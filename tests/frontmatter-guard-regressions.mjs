const guardModule = await import("../src/sync/frontmatterGuard.ts");
const guard = guardModule.default ?? guardModule;
const {
	extractFrontmatter,
	validateFrontmatterTransition,
	isFrontmatterBlocked,
} = guard;

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

class FrontmatterBridgeHarness {
	constructor({ guardEnabled = true } = {}) {
		this.guardEnabled = guardEnabled;
		this.disk = new Map();
		this.crdt = new Map();
		this.blocked = [];
		this.ingestCount = 0;
		this.writeCount = 0;
	}

	inbound(path) {
		const next = this.disk.get(path);
		if (typeof next !== "string") throw new Error(`Missing disk content for ${path}`);
		const previous = this.crdt.get(path) ?? null;
		const validation = validateFrontmatterTransition(previous, next);
		if (this.guardEnabled && isFrontmatterBlocked(validation)) {
			this.blocked.push({ path, direction: "disk-to-crdt", validation });
			return false;
		}
		this.crdt.set(path, next);
		this.ingestCount++;
		return true;
	}

	outbound(path) {
		const next = this.crdt.get(path);
		if (typeof next !== "string") throw new Error(`Missing CRDT content for ${path}`);
		const previous = this.disk.get(path) ?? null;
		const validation = validateFrontmatterTransition(previous, next);
		if (this.guardEnabled && isFrontmatterBlocked(validation)) {
			this.blocked.push({ path, direction: "crdt-to-disk", validation });
			return false;
		}
		this.disk.set(path, next);
		this.writeCount++;
		return true;
	}
}

console.log("\n--- Test 1: body-only markdown bypasses frontmatter guard ---");
{
	const result = validateFrontmatterTransition(
		"body before\n",
		"body after\n",
	);
	assert(result.risk === "ok", "body-only edit is ok");
	assert(result.frontmatterLength === null, "body-only edit has no frontmatter length");
}

console.log("\n--- Test 2: duplicate frontmatter keys are blocked ---");
{
	const next = [
		"---",
		"taskSourceType: taskNotes",
		"taskSourceType: taskNotes",
		"---",
		"body",
	].join("\n");
	const result = validateFrontmatterTransition(null, next);
	assert(isFrontmatterBlocked(result), "duplicate key is blocked");
	assert(result.reasons.includes("duplicate-key:taskSourceType"), "duplicate key reason is reported");
}

console.log("\n--- Test 3: repeated bare key bursts are blocked ---");
{
	const next = [
		"---",
		"taskSourceType",
		"taskSourceType",
		"taskSourceType",
		"---",
		"body",
	].join("\n");
	const result = validateFrontmatterTransition(null, next);
	assert(isFrontmatterBlocked(result), "repeated bare key burst is blocked");
	assert(
		result.reasons.includes("repeated-bare-key-burst:taskSourceType"),
		"bare key burst reason is reported",
	);
}

console.log("\n--- Test 4: quoted duplicate frontmatter keys are blocked ---");
{
	const next = [
		"---",
		"\"task source\": taskNotes",
		"\"task source\": taskNotes",
		"---",
		"body",
	].join("\n");
	const result = validateFrontmatterTransition(null, next);
	assert(isFrontmatterBlocked(result), "quoted duplicate key is blocked");
	assert(result.reasons.includes("duplicate-key:task source"), "quoted duplicate key reason is reported");
}

console.log("\n--- Test 5: unknown top-level YAML warns instead of blocking ---");
{
	const next = [
		"---",
		"? complex",
		": value",
		"---",
		"body",
	].join("\n");
	const result = validateFrontmatterTransition(null, next);
	assert(result.risk === "warn", "unknown top-level YAML is a warning");
	assert(!isFrontmatterBlocked(result), "unknown top-level YAML is not blocked");
}

console.log("\n--- Test 6: malformed frontmatter fence is blocked ---");
{
	const next = [
		"---",
		"title: Broken",
		"body that never closed",
	].join("\n");
	const result = validateFrontmatterTransition(null, next);
	assert(isFrontmatterBlocked(result), "missing closing fence is blocked");
	assert(
		result.reasons.includes("malformed-frontmatter:missing-closing-fence"),
		"malformed fence reason is reported",
	);
}

console.log("\n--- Test 7: frontmatter growth burst is blocked ---");
{
	const previous = [
		"---",
		"title: Short",
		"---",
		"body",
	].join("\n");
	const next = [
		"---",
		"title: Short",
		`notes: ${"x".repeat(300)}`,
		"---",
		"body",
	].join("\n");
	const result = validateFrontmatterTransition(previous, next);
	assert(isFrontmatterBlocked(result), "large frontmatter-only growth burst is blocked");
	assert(result.reasons.includes("frontmatter-growth-burst"), "growth burst reason is reported");
}

console.log("\n--- Test 8: extractor separates frontmatter and body ---");
{
	const markdown = [
		"---",
		"title: Clean",
		"---",
		"",
		"body",
	].join("\n");
	const block = extractFrontmatter(markdown);
	assert(block.kind === "present", "frontmatter block is detected");
	assert(block.kind === "present" && block.frontmatterText.includes("title: Clean"), "frontmatter text is extracted");
	assert(block.kind === "present" && block.bodyText === "\nbody", "body text is extracted");
}

console.log("\n--- Test 9: inbound blocked frontmatter does not poison CRDT ---");
{
	const path = "Bathroom floor clean.md";
	const clean = [
		"---",
		"timeEstimate: 20",
		"---",
		"body",
	].join("\n");
	const corrupt = [
		"---",
		"timeEstimate: 20",
		"timeEstimate: 200",
		"---",
		"body",
	].join("\n");
	const bridge = new FrontmatterBridgeHarness();
	bridge.crdt.set(path, clean);
	bridge.disk.set(path, corrupt);

	assert(!bridge.inbound(path), "inbound corrupt frontmatter is blocked");
	assert(bridge.crdt.get(path) === clean, "blocked inbound content does not update CRDT");
	assert(bridge.blocked[0]?.direction === "disk-to-crdt", "inbound block records direction");
}

console.log("\n--- Test 10: outbound blocked frontmatter does not mutate disk ---");
{
	const path = "Bathroom floor clean.md";
	const clean = [
		"---",
		"timeEstimate: 20",
		"---",
		"body",
	].join("\n");
	const corrupt = [
		"---",
		"timeEstimate: 20",
		"timeEstimate: 200",
		"---",
		"body",
	].join("\n");
	const bridge = new FrontmatterBridgeHarness();
	bridge.disk.set(path, clean);
	bridge.crdt.set(path, corrupt);

	assert(!bridge.outbound(path), "outbound corrupt frontmatter is blocked");
	assert(bridge.disk.get(path) === clean, "blocked outbound content does not update disk");
	assert(bridge.blocked[0]?.direction === "crdt-to-disk", "outbound block records direction");
}

console.log("\n--- Test 11: repeated blocked retries do not loop writes ---");
{
	const path = "Bathroom floor clean.md";
	const clean = [
		"---",
		"timeEstimate: 20",
		"---",
		"body",
	].join("\n");
	const corrupt = [
		"---",
		"timeEstimate: 20",
		"timeEstimate: 200",
		"---",
		"body",
	].join("\n");
	const bridge = new FrontmatterBridgeHarness();
	bridge.disk.set(path, clean);
	bridge.crdt.set(path, corrupt);

	for (let i = 0; i < 3; i++) {
		assert(!bridge.outbound(path), `blocked retry ${i + 1} remains blocked`);
	}
	assert(bridge.disk.get(path) === clean, "repeated blocked retries leave disk unchanged");
	assert(bridge.writeCount === 0, "repeated blocked retries do not perform writes");
}

console.log("\n--- Test 12: body-only edits still flow through the guard harness ---");
{
	const path = "Body only.md";
	const bridge = new FrontmatterBridgeHarness();
	bridge.crdt.set(path, "body before\n");
	bridge.disk.set(path, "body after\n");

	assert(bridge.inbound(path), "body-only inbound edit is imported");
	assert(bridge.crdt.get(path) === "body after\n", "body-only inbound edit updates CRDT");

	bridge.crdt.set(path, "body after again\n");
	assert(bridge.outbound(path), "body-only outbound edit is written");
	assert(bridge.disk.get(path) === "body after again\n", "body-only outbound edit updates disk");
}

console.log("\n--- Test 13: disabled guard allows suspicious frontmatter for troubleshooting ---");
{
	const path = "Bathroom floor clean.md";
	const clean = [
		"---",
		"timeEstimate: 20",
		"---",
		"body",
	].join("\n");
	const corrupt = [
		"---",
		"timeEstimate: 20",
		"timeEstimate: 200",
		"---",
		"body",
	].join("\n");
	const bridge = new FrontmatterBridgeHarness({ guardEnabled: false });
	bridge.disk.set(path, clean);
	bridge.crdt.set(path, corrupt);

	assert(bridge.outbound(path), "disabled guard allows outbound write");
	assert(bridge.disk.get(path) === corrupt, "disabled guard writes the suspicious state");
	assert(bridge.blocked.length === 0, "disabled guard records no block");
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);

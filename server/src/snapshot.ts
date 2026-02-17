/**
 * Server-side snapshot creation and management.
 *
 * Snapshots are point-in-time backups of the CRDT state stored in R2.
 * The server encodes the Y.Doc, gzips it, and writes two objects:
 *   - crdt.bin.gz   (gzipped Y.encodeStateAsUpdate)
 *   - index.json    (metadata: vault, timestamp, file/blob counts, referenced blob hashes)
 *
 * R2 key layout:
 *   v1/<vaultId>/snapshots/<YYYY-MM-DD>/<snapshotId>/crdt.bin.gz
 *   v1/<vaultId>/snapshots/<YYYY-MM-DD>/<snapshotId>/index.json
 *
 * Coordination:
 *   - lastSnapshotDay stored in DO room.storage to avoid duplicate daily snapshots.
 *   - /snapshot/maybe checks lastSnapshotDay; /snapshot/now always creates.
 */

import * as Y from "yjs";
import { gzipSync } from "fflate";
import type { R2Config } from "./presign";
import { AwsClient } from "aws4fetch";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

export interface SnapshotIndex {
	/** Unique snapshot identifier. */
	snapshotId: string;
	/** Vault ID this snapshot belongs to. */
	vaultId: string;
	/** ISO 8601 timestamp when the snapshot was created. */
	createdAt: string;
	/** Calendar day string (YYYY-MM-DD) for grouping. */
	day: string;
	/** Schema version of the CRDT doc at snapshot time. */
	schemaVersion: number | undefined;
	/** Number of markdown file paths in pathToId. */
	markdownFileCount: number;
	/** Number of blob paths in pathToBlob. */
	blobFileCount: number;
	/** Size of the gzipped CRDT binary in bytes. */
	crdtSizeBytes: number;
	/** Size of the raw (uncompressed) CRDT update in bytes. */
	crdtRawSizeBytes: number;
	/** All blob content hashes referenced by pathToBlob at snapshot time. */
	referencedBlobHashes: string[];
	/** Device that triggered the snapshot (if known). */
	triggeredBy?: string;
}

export interface SnapshotResult {
	status: "created" | "noop" | "unavailable";
	snapshotId?: string;
	snapshotKey?: string;
	reason?: string;
	index?: SnapshotIndex;
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function generateSnapshotId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `${ts}-${rand}`;
}

function snapshotPrefix(vaultId: string, day: string, snapshotId: string): string {
	return `v1/${vaultId}/snapshots/${day}/${snapshotId}`;
}

function r2Endpoint(config: R2Config): string {
	return `https://${config.accountId}.r2.cloudflarestorage.com`;
}

function makeClient(config: R2Config): AwsClient {
	return new AwsClient({
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		region: "auto",
		service: "s3",
	});
}

/**
 * PUT an object to R2 using signed request.
 */
async function r2Put(
	config: R2Config,
	key: string,
	body: Uint8Array | string,
	contentType: string,
): Promise<void> {
	const client = makeClient(config);
	const url = `${r2Endpoint(config)}/${config.bucketName}/${key}`;

	const bodyBytes = typeof body === "string"
		? new TextEncoder().encode(body)
		: body;

	const signed = await client.sign(
		new Request(url, {
			method: "PUT",
			headers: {
				"Content-Type": contentType,
				"Content-Length": String(bodyBytes.byteLength),
			},
			body: bodyBytes,
		}),
	);

	const res = await fetch(signed);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`R2 PUT failed (${res.status}): ${text}`);
	}
}

/**
 * List objects under a given prefix in R2.
 * Returns the keys found.
 */
async function r2List(
	config: R2Config,
	prefix: string,
	maxKeys = 1000,
): Promise<string[]> {
	const client = makeClient(config);
	const url = new URL(`${r2Endpoint(config)}/${config.bucketName}`);
	url.searchParams.set("list-type", "2");
	url.searchParams.set("prefix", prefix);
	url.searchParams.set("max-keys", String(maxKeys));

	const signed = await client.sign(
		new Request(url.toString(), { method: "GET" }),
	);

	const res = await fetch(signed);
	if (!res.ok) {
		throw new Error(`R2 LIST failed (${res.status})`);
	}

	const xml = await res.text();
	// Simple XML key extraction — R2 returns S3-compatible ListObjectsV2
	const keys: string[] = [];
	const keyRegex = /<Key>([^<]+)<\/Key>/g;
	let match;
	while ((match = keyRegex.exec(xml)) !== null) {
		keys.push(match[1]);
	}
	return keys;
}

/**
 * GET an object from R2 as bytes.
 */
async function r2Get(
	config: R2Config,
	key: string,
): Promise<Uint8Array> {
	const client = makeClient(config);
	const url = `${r2Endpoint(config)}/${config.bucketName}/${key}`;

	const signed = await client.sign(
		new Request(url, { method: "GET" }),
	);

	const res = await fetch(signed);
	if (!res.ok) {
		throw new Error(`R2 GET failed (${res.status})`);
	}

	return new Uint8Array(await res.arrayBuffer());
}

// -------------------------------------------------------------------
// Core snapshot creation
// -------------------------------------------------------------------

/**
 * Create a snapshot from the given Y.Doc and write it to R2.
 *
 * @param ydoc - The live Y.Doc (must be fully loaded/synced)
 * @param vaultId - Vault identifier
 * @param r2 - R2 configuration
 * @param triggeredBy - Optional device name that triggered the snapshot
 * @returns The snapshot index
 */
export async function createSnapshot(
	ydoc: Y.Doc,
	vaultId: string,
	r2: R2Config,
	triggeredBy?: string,
): Promise<SnapshotIndex> {
	const day = today();
	const snapshotId = generateSnapshotId();
	const prefix = snapshotPrefix(vaultId, day, snapshotId);

	// 1. Encode the full Y.Doc state
	const rawUpdate = Y.encodeStateAsUpdate(ydoc);

	// 2. Gzip it
	const compressed = gzipSync(rawUpdate);

	// 3. Extract metadata from the doc's maps
	const pathToId = ydoc.getMap<string>("pathToId");
	const pathToBlob = ydoc.getMap<unknown>("pathToBlob");
	const sys = ydoc.getMap<unknown>("sys");

	// Collect referenced blob hashes
	const referencedBlobHashes: string[] = [];
	pathToBlob.forEach((ref: unknown) => {
		if (ref && typeof ref === "object" && "hash" in ref) {
			const hash = (ref as { hash: string }).hash;
			if (typeof hash === "string") {
				referencedBlobHashes.push(hash);
			}
		}
	});

	// 4. Build the index
	const index: SnapshotIndex = {
		snapshotId,
		vaultId,
		createdAt: new Date().toISOString(),
		day,
		schemaVersion: sys.get("schemaVersion") as number | undefined,
		markdownFileCount: pathToId.size,
		blobFileCount: pathToBlob.size,
		crdtSizeBytes: compressed.byteLength,
		crdtRawSizeBytes: rawUpdate.byteLength,
		referencedBlobHashes,
		triggeredBy,
	};

	// 5. Write both objects to R2
	await Promise.all([
		r2Put(r2, `${prefix}/crdt.bin.gz`, compressed, "application/gzip"),
		r2Put(r2, `${prefix}/index.json`, JSON.stringify(index), "application/json"),
	]);

	return index;
}

// -------------------------------------------------------------------
// Snapshot listing
// -------------------------------------------------------------------

/**
 * List all snapshot indexes for a vault.
 * Returns parsed SnapshotIndex objects sorted by creation date (newest first).
 */
export async function listSnapshots(
	vaultId: string,
	r2: R2Config,
): Promise<SnapshotIndex[]> {
	const prefix = `v1/${vaultId}/snapshots/`;
	const keys = await r2List(r2, prefix);

	// Filter for index.json files only
	const indexKeys = keys.filter((k) => k.endsWith("/index.json"));

	// Fetch all indexes in parallel (bounded — typically < 30)
	const indexes = await Promise.all(
		indexKeys.map(async (key) => {
			try {
				const data = await r2Get(r2, key);
				const text = new TextDecoder().decode(data);
				return JSON.parse(text) as SnapshotIndex;
			} catch {
				return null;
			}
		}),
	);

	// Filter nulls and sort newest first
	return indexes
		.filter((idx): idx is SnapshotIndex => idx !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Presign a GET URL for the crdt.bin.gz of a specific snapshot.
 * Used by the plugin to download snapshot data for restore.
 */
export async function presignSnapshotGet(
	vaultId: string,
	snapshotId: string,
	day: string,
	r2: R2Config,
): Promise<{ url: string; expiresIn: number }> {
	const key = `${snapshotPrefix(vaultId, day, snapshotId)}/crdt.bin.gz`;
	const client = makeClient(r2);
	const objectUrl = `${r2Endpoint(r2)}/${r2.bucketName}/${key}`;

	const url = new URL(objectUrl);
	url.searchParams.set("X-Amz-Expires", "900");

	const signed = await client.sign(
		new Request(url.toString(), { method: "GET" }),
		{ aws: { signQuery: true } },
	);

	return { url: signed.url, expiresIn: 900 };
}

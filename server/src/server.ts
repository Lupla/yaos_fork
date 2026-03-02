import * as Y from "yjs";
import { YServer } from "y-partyserver";

const DOCUMENT_KEY = "document";
const DEBUG_TRACE_RING_KEY = "debugTraceRing";
const MAX_DEBUG_TRACE_EVENTS = 200;

interface ServerTraceEntry {
	ts: string;
	event: string;
	roomId: string;
	[key: string]: unknown;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function normalizeBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (data instanceof Uint8Array) {
		return data;
	}
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return new Uint8Array(data);
}

export class VaultSyncServer extends YServer {
	static options = {
		hibernate: true,
	};

	private documentLoaded = false;

	async onLoad(): Promise<void> {
		await this.ensureDocumentLoaded();
	}

	async onSave(): Promise<void> {
		this.documentLoaded = true;
		await this.ctx.storage.put(
			DOCUMENT_KEY,
			Y.encodeStateAsUpdate(this.document),
		);
	}

	async fetch(request: Request): Promise<Response> {
		await this.ensureDocumentLoaded();

		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/__yaos/document") {
			return new Response(Y.encodeStateAsUpdate(this.document), {
				headers: {
					"Content-Type": "application/octet-stream",
					"Cache-Control": "no-store",
				},
			});
		}

		if (request.method === "GET" && url.pathname === "/__yaos/debug") {
			const recent =
				(await this.ctx.storage.get<ServerTraceEntry[]>(DEBUG_TRACE_RING_KEY))
				?? [];
			return json({
				roomId: this.getRoomId(),
				recent,
			});
		}

		if (request.method === "POST" && url.pathname === "/__yaos/trace") {
			let body: { event?: string; data?: Record<string, unknown> } = {};
			try {
				body = await request.json() as typeof body;
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			if (!body.event || typeof body.event !== "string") {
				return json({ error: "missing event" }, 400);
			}

			await this.recordTrace(body.event, body.data ?? {});
			return json({ ok: true });
		}

		return super.fetch(request);
	}

	private async ensureDocumentLoaded(): Promise<void> {
		if (this.documentLoaded) return;

		const data = await this.ctx.storage.get<Uint8Array | ArrayBuffer>(DOCUMENT_KEY);
		if (data) {
			const bytes = normalizeBytes(data);
			if (bytes.byteLength > 0) {
				Y.applyUpdate(this.document, bytes);
			}
		}

		this.documentLoaded = true;
	}

	private async recordTrace(
		event: string,
		data: Record<string, unknown>,
	): Promise<void> {
		const entry: ServerTraceEntry = {
			ts: new Date().toISOString(),
			event,
			roomId: this.getRoomId(),
			...data,
		};

		console.log(JSON.stringify({
			source: "vault-sync",
			...entry,
		}));

		const existing =
			(await this.ctx.storage.get<ServerTraceEntry[]>(DEBUG_TRACE_RING_KEY))
			?? [];
		existing.push(entry);
		if (existing.length > MAX_DEBUG_TRACE_EVENTS) {
			existing.splice(0, existing.length - MAX_DEBUG_TRACE_EVENTS);
		}
		await this.ctx.storage.put(DEBUG_TRACE_RING_KEY, existing);
	}

	private getRoomId(): string {
		const candidate = (this as unknown as { name?: unknown }).name;
		return typeof candidate === "string" && candidate.length > 0
			? candidate
			: "unknown";
	}
}

export default VaultSyncServer;

/**
 * Shared type definitions for the vault CRDT sync plugin.
 */

/** Metadata stored per file ID in the CRDT meta map. */
export interface FileMeta {
	/** Vault-relative path (normalized). */
	path: string;
	/** Soft-delete flag. When true, file should be removed from disk. */
	deleted?: boolean;
	/** Last-modified timestamp (ms since epoch). Informational only. */
	mtime?: number;
	/** Device that last modified this entry. */
	device?: string;
}

/** Origin string used for Yjs transactions initiated by this plugin. */
export const ORIGIN_LOCAL = "vault-crdt-local";
export const ORIGIN_SEED = "vault-crdt-seed";

/** Paths that are excluded from CRDT sync. */
const EXCLUDED_PREFIXES = [".obsidian/", ".obsidian\\", ".trash/", ".trash\\"];

/** Check if a vault-relative path should be synced via CRDT. */
export function shouldSync(path: string): boolean {
	if (!path.endsWith(".md")) return false;
	for (const prefix of EXCLUDED_PREFIXES) {
		if (path.startsWith(prefix)) return false;
	}
	return true;
}

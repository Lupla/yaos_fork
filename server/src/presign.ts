/**
 * R2 presigned URL generation using the S3-compatible API.
 *
 * Uses aws4fetch to sign requests against Cloudflare R2's S3 endpoint.
 * The server never proxies blob bytes — it only signs URLs that clients
 * use for direct PUT/GET to R2.
 */
import { AwsClient } from "aws4fetch";

export interface R2Config {
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucketName: string;
}

/** How long presigned URLs remain valid. */
const PRESIGN_EXPIRY_SECONDS = 900; // 15 minutes

/**
 * Build an AwsClient for R2's S3-compatible API.
 */
function makeClient(config: R2Config): AwsClient {
	return new AwsClient({
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		region: "auto",
		service: "s3",
	});
}

/**
 * R2 S3-compatible endpoint for a given account.
 */
function endpoint(config: R2Config): string {
	return `https://${config.accountId}.r2.cloudflarestorage.com`;
}

/**
 * Validate that a key looks like a valid blob key: 64 hex chars.
 */
function isValidHash(hash: string): boolean {
	return /^[0-9a-f]{64}$/.test(hash);
}

/**
 * Construct the R2 object key from vaultId and content hash.
 * Server derives this — client only submits hash, not arbitrary keys.
 */
export function blobKey(vaultId: string, hash: string): string {
	return `v1/${vaultId}/blobs/${hash}`;
}

/**
 * Generate a presigned PUT URL for uploading a blob.
 */
export async function presignPut(
	config: R2Config,
	vaultId: string,
	hash: string,
	contentType: string,
	contentLength: number,
): Promise<{ url: string; expiresIn: number }> {
	if (!isValidHash(hash)) {
		throw new Error(`Invalid hash: ${hash}`);
	}

	const client = makeClient(config);
	const key = blobKey(vaultId, hash);
	const objectUrl = `${endpoint(config)}/${config.bucketName}/${key}`;

	// Create a presigned PUT request
	const url = new URL(objectUrl);
	url.searchParams.set("X-Amz-Expires", String(PRESIGN_EXPIRY_SECONDS));

	const signed = await client.sign(
		new Request(url.toString(), {
			method: "PUT",
			headers: {
				"Content-Type": contentType,
				"Content-Length": String(contentLength),
			},
		}),
		{ aws: { signQuery: true } },
	);

	return {
		url: signed.url,
		expiresIn: PRESIGN_EXPIRY_SECONDS,
	};
}

/**
 * Generate a presigned GET URL for downloading a blob.
 */
export async function presignGet(
	config: R2Config,
	vaultId: string,
	hash: string,
): Promise<{ url: string; expiresIn: number }> {
	if (!isValidHash(hash)) {
		throw new Error(`Invalid hash: ${hash}`);
	}

	const client = makeClient(config);
	const key = blobKey(vaultId, hash);
	const objectUrl = `${endpoint(config)}/${config.bucketName}/${key}`;

	const url = new URL(objectUrl);
	url.searchParams.set("X-Amz-Expires", String(PRESIGN_EXPIRY_SECONDS));

	const signed = await client.sign(
		new Request(url.toString(), { method: "GET" }),
		{ aws: { signQuery: true } },
	);

	return {
		url: signed.url,
		expiresIn: PRESIGN_EXPIRY_SECONDS,
	};
}

/**
 * Check which blobs exist in R2 (batch HEAD requests).
 * Returns the subset of hashes that are present.
 */
export async function checkExists(
	config: R2Config,
	vaultId: string,
	hashes: string[],
): Promise<string[]> {
	const client = makeClient(config);
	const present: string[] = [];

	// Fan out HEAD requests in parallel (bounded by input size)
	const checks = hashes.map(async (hash) => {
		if (!isValidHash(hash)) return;

		const key = blobKey(vaultId, hash);
		const objectUrl = `${endpoint(config)}/${config.bucketName}/${key}`;

		try {
			const signed = await client.sign(
				new Request(objectUrl, { method: "HEAD" }),
			);
			const res = await fetch(signed);
			if (res.ok) {
				present.push(hash);
			}
		} catch {
			// Network error = treat as not present
		}
	});

	await Promise.all(checks);
	return present;
}

/**
 * Extract R2 config from room env vars. Returns null if not configured.
 */
export function getR2Config(env: Record<string, unknown>): R2Config | null {
	const accountId = env.R2_ACCOUNT_ID as string | undefined;
	const accessKeyId = env.R2_ACCESS_KEY_ID as string | undefined;
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY as string | undefined;
	const bucketName = env.R2_BUCKET_NAME as string | undefined;

	if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
		return null;
	}

	return { accountId, accessKeyId, secretAccessKey, bucketName };
}

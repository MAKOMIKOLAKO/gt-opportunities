// Object storage for org icon uploads — Cloudflare R2 (S3-compatible API).
// Chosen over AWS S3 for cheaper egress and a near-identical API surface
// (the AWS SDK v3 S3 client works against R2 unmodified, just pointed at
// R2's account-scoped endpoint) — see BUILD_NOTES_FILE_STORAGE.md. Replaces
// the earlier URL-only icon submission, which never fetched/validated the
// remote URL server-side (an SSRF footgun) — uploading the bytes directly
// sidesteps that class of problem entirely.
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET_NAME = process.env.R2_BUCKET_NAME;
// Public base URL the bucket is served from (R2 public bucket dev domain, or
// a custom domain mapped to the bucket) — NOT the S3 API endpoint. Objects
// are addressed as `${R2_PUBLIC_URL}/${key}`.
const PUBLIC_URL = process.env.R2_PUBLIC_URL;

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
    throw new Error(
      "R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY (see .env.example)."
    );
  }
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    });
  }
  return client;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export const ALLOWED_ICON_MIME_TYPES = Object.keys(EXTENSION_BY_MIME);
export const MAX_ICON_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * Uploads a submitted icon under a namespaced pending path
 * (`icons/pending/{opportunityId}/{uuid}.{ext}`) and returns its public URL.
 * Caller (the route) MUST validate `mimeType` against ALLOWED_ICON_MIME_TYPES
 * and `buffer.length` against MAX_ICON_UPLOAD_BYTES before calling this — no
 * validation happens here.
 */
export async function uploadIcon(opportunityId: number, buffer: Buffer, mimeType: string): Promise<string> {
  if (!BUCKET_NAME || !PUBLIC_URL) {
    throw new Error("R2 is not configured — set R2_BUCKET_NAME and R2_PUBLIC_URL (see .env.example).");
  }
  const ext = EXTENSION_BY_MIME[mimeType];
  const key = `icons/pending/${opportunityId}/${randomUUID()}.${ext}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  );

  return `${PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}

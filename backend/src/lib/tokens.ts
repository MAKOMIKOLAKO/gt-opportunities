// Token generation + hashing for the leader-access magic-link/session
// surface (module 2 of 7). Raw tokens are only ever handed to a caller once
// (the JSON body of a magic-link issuance, or a Set-Cookie header for a
// session) — they are NEVER persisted. Only `hashToken(raw)`'s output ever
// touches the database, matching `magic_links.token_hash` /
// `sessions.token_hash` (see backend/src/db/schema.ts, module 1).
import crypto from "node:crypto";

// 32 random bytes -> 64 hex chars. hex (not base64url) so the token is safe
// to embed in a URL query string without further encoding and is trivially
// eyeballable in logs/tests, matching this repo's existing token style
// (backend/src/lib/auth.ts uses base64url for the *admin* session, but that
// token is a signed payload, not an opaque random secret — hex is simpler
// here since these tokens carry no payload, only entropy).
const TOKEN_BYTES = 32;

/** Generates a new cryptographically random raw token (32 bytes / 64 hex chars). */
export function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * SHA-256 hex digest of a raw token — the only form ever persisted (as
 * `magic_links.token_hash` / `sessions.token_hash`). Deterministic (no salt):
 * a lookup-by-hash is the whole point of this scheme (see
 * getMagicLinkByTokenHash/getSessionByTokenHash in data-access.ts), so a
 * salted/keyed hash (which would require a per-row salt lookup before you
 * even know which row you're looking for) doesn't apply here. Security comes
 * from the token's 256 bits of entropy, not from the hash being unguessable.
 */
export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

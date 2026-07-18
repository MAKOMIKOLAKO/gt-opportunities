// Simple shared-password admin auth. Credentials and the session-signing
// secret come from the environment in production (ADMIN_USERNAME,
// ADMIN_PASSWORD, JWT_SECRET — see .env.example) so they survive redeploys
// and restarts. If unset (local dev only), a random password + secret are
// generated at process startup instead — never hardcoded, never committed.
// Sessions are opaque bearer tokens: base64url(payload) + "." + hmac-signature.
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? crypto.randomBytes(16).toString("hex"); // 32 chars
const SESSION_SECRET = process.env.JWT_SECRET ?? crypto.randomBytes(32).toString("hex");
if (process.env.NODE_ENV === "production" && (!process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET)) {
  console.warn(
    "WARNING: ADMIN_PASSWORD and/or JWT_SECRET not set in production — using a random value generated at " +
      "startup, which changes on every restart and invalidates admin sessions. Set them in the Railway " +
      "dashboard env vars (see .env.example)."
  );
}
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface SessionPayload {
  username: string;
  exp: number;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

export function createToken(username: string): string {
  const payload: SessionPayload = { username, exp: Date.now() + SESSION_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(encoded);
  return `${encoded}.${sig}`;
}

export function verifyToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = sign(encoded);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const payload: SessionPayload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  (req as Request & { adminUser?: string }).adminUser = payload.username;
  next();
}

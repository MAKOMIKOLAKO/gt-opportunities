// Small shared helpers for the /api/** Vercel Node function handlers.
// Files/folders prefixed with `_` under /api are ignored by Vercel's
// filesystem router, so this module (and the rest of `_lib/`) is never
// itself deployed as a route — see
// https://vercel.com/docs/functions/serverless-functions (the /api
// directory convention this project uses instead of a framework).
//
// Notes on the Vercel Node.js runtime (not Edge) this project targets:
//   - `req.body` is already parsed for us when Content-Type is
//     application/json (Vercel's default body parsing for Node functions),
//     so there is no `express.json()` equivalent to wire up manually.
//   - `req.query` already merges the querystring AND any dynamic route
//     segments (e.g. `[id].ts` -> `req.query.id`), same as Express's
//     req.params for our purposes.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAdmin, ADMIN_USERNAME } from "../../backend/src/lib/auth.js";

export type ErrorBody = { error: string; details?: string[] };

export function sendJson(res: VercelResponse, status: number, body: unknown): void {
  res.status(status).json(body);
}

export function notFound(res: VercelResponse): void {
  sendJson(res, 404, { error: "not_found" });
}

export function validationError(res: VercelResponse, details: string[]): void {
  sendJson(res, 400, { error: "validation_error", details });
}

/** Responds 405 with an Allow header, mirroring Express's default behavior for unmatched methods. */
export function methodNotAllowed(res: VercelResponse, allowed: string[]): void {
  res.setHeader("Allow", allowed.join(", "));
  sendJson(res, 405, { error: "method_not_allowed" });
}

/**
 * Verifies the request carries a valid admin bearer token. On success
 * returns the admin username to stamp onto reviewedBy/resolvedBy fields. On
 * failure, writes the 401 response itself and returns null — callers must
 * check for null and `return` immediately without writing to `res` again:
 *
 *   const adminUser = requireAdminOrRespond(req, res);
 *   if (!adminUser) return;
 */
export function requireAdminOrRespond(req: VercelRequest, res: VercelResponse): string | null {
  const payload = requireAdmin(req.headers.authorization);
  if (!payload) {
    sendJson(res, 401, { error: "unauthorized" });
    return null;
  }
  return payload.username ?? ADMIN_USERNAME;
}

/** Reads a single string route param out of req.query (Vercel merges [id]-style segments into query). */
export function stringParam(req: VercelRequest, name: string): string | undefined {
  const v = req.query[name];
  return Array.isArray(v) ? v[0] : v;
}

export function intParam(req: VercelRequest, name: string): number | null {
  const raw = stringParam(req, name);
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

// GET /api/health — simple liveness check. The original Express app served
// this at the bare `/health` path (outside the `/api` router mount); it now
// lives under `/api/health` since Vercel's convention roots every function
// at `/api`. Update any external uptime checks accordingly.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { methodNotAllowed, sendJson } from "./_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  sendJson(res, 200, { ok: true });
}

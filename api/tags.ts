// GET /api/tags — full tag vocabulary, for building filter UI.
// Ported from backend/src/routes/public.ts (publicRouter.get("/tags")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAllTags } from "../backend/src/db/data-access.js";
import { methodNotAllowed, sendJson } from "./_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  const results = await getAllTags();
  sendJson(res, 200, { results });
}

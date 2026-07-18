// GET /api/opportunities/:id — fetch a single approved opportunity, with
// its approved reviews attached. Ported from
// backend/src/routes/public.ts (publicRouter.get("/opportunities/:id")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPublic, getApprovedReviews } from "../../../backend/src/db/data-access.js";
import { intParam, methodNotAllowed, notFound, sendJson } from "../../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }

  const id = intParam(req, "id");
  if (id === null) {
    notFound(res);
    return;
  }

  const results = await getPublic();
  const result = results.find((r) => r.id === id);
  if (!result) {
    notFound(res);
    return;
  }
  const reviews = await getApprovedReviews(id);
  sendJson(res, 200, { result: { ...result, reviews } });
}

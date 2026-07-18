// POST /api/admin/opportunities/:id/reject — ported from
// backend/src/routes/admin.ts (adminRouter.post(".../reject")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { rejectOpportunity } from "../../../../backend/src/db/data-access.js";
import { intParam, methodNotAllowed, notFound, requireAdminOrRespond, sendJson } from "../../../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  const reviewedBy = requireAdminOrRespond(req, res);
  if (!reviewedBy) return;

  const id = intParam(req, "id");
  if (id === null) {
    notFound(res);
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const result = await rejectOpportunity(id, reviewedBy, reason);
  if (!result) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { result });
}

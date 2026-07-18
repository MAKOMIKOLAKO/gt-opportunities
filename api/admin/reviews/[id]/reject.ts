// POST /api/admin/reviews/:id/reject — ported from
// backend/src/routes/admin.ts (adminRouter.post("/admin/reviews/:id/reject")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { rejectReview } from "../../../../backend/src/db/data-access.js";
import { methodNotAllowed, notFound, requireAdminOrRespond, sendJson, stringParam } from "../../../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  const reviewedBy = requireAdminOrRespond(req, res);
  if (!reviewedBy) return;

  const id = stringParam(req, "id");
  if (!id) {
    notFound(res);
    return;
  }

  const result = await rejectReview(id, reviewedBy);
  if (!result) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { result });
}

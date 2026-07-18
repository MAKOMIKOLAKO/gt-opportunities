// POST /api/admin/reviews/:id/approve — ported from
// backend/src/routes/admin.ts (adminRouter.post("/admin/reviews/:id/approve")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { approveReview } from "../../../../backend/src/db/data-access.js";
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

  const result = await approveReview(id, reviewedBy);
  if (!result) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { result });
}

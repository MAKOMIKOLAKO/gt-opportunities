// POST /api/admin/reports/:id/resolve — ported from
// backend/src/routes/admin.ts (adminRouter.post("/admin/reports/:id/resolve")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveReport } from "../../../../backend/src/db/data-access.js";
import { intParam, methodNotAllowed, notFound, requireAdminOrRespond, sendJson } from "../../../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  const resolvedBy = requireAdminOrRespond(req, res);
  if (!resolvedBy) return;

  const id = intParam(req, "id");
  if (id === null) {
    notFound(res);
    return;
  }

  const result = await resolveReport(id, resolvedBy);
  if (!result) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { result });
}

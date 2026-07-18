// GET /api/admin/reports?status=open — moderation queue for reports/disputes
// (Addition 3). Ported from backend/src/routes/admin.ts
// (adminRouter.get("/admin/reports")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getReportsForAdmin } from "../../../backend/src/db/data-access.js";
import type { ReportStatus } from "../../../backend/src/db/schema.js";
import { methodNotAllowed, requireAdminOrRespond, sendJson } from "../../_lib/http.js";

const VALID_REPORT_STATUSES: ReportStatus[] = ["open", "resolved"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  if (!requireAdminOrRespond(req, res)) return;

  const { status } = req.query;
  const statusFilter =
    typeof status === "string" && VALID_REPORT_STATUSES.includes(status as ReportStatus)
      ? (status as ReportStatus)
      : undefined;
  const results = await getReportsForAdmin({ status: statusFilter });
  sendJson(res, 200, { results, count: results.length });
}

// GET /api/admin/opportunities?status=pending — review queue listing.
// Ported from backend/src/routes/admin.ts (adminRouter.get("/admin/opportunities")).
// Requires a valid admin session (all admin routes do).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getForAdmin } from "../../../backend/src/db/data-access.js";
import type { OpportunityStatus, OpportunityType } from "../../../backend/src/db/schema.js";
import { methodNotAllowed, requireAdminOrRespond, sendJson } from "../../_lib/http.js";

const VALID_STATUSES: OpportunityStatus[] = ["approved", "pending", "rejected"];
const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  if (!requireAdminOrRespond(req, res)) return;

  const { status, type, search } = req.query;
  const statusFilter =
    typeof status === "string" && VALID_STATUSES.includes(status as OpportunityStatus)
      ? (status as OpportunityStatus)
      : undefined;
  const typeFilter =
    typeof type === "string" && VALID_TYPES.includes(type as OpportunityType) ? (type as OpportunityType) : undefined;
  const searchFilter = typeof search === "string" && search.length > 0 ? search : undefined;

  const results = await getForAdmin({ status: statusFilter, type: typeFilter, search: searchFilter });
  sendJson(res, 200, { results, count: results.length });
}

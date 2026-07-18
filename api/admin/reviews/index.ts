// GET /api/admin/reviews?status=pending — moderation queue (Addition 3).
// Ported from backend/src/routes/admin.ts (adminRouter.get("/admin/reviews")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getReviewsForAdmin } from "../../../backend/src/db/data-access.js";
import type { ReviewStatus } from "../../../backend/src/db/schema.js";
import { methodNotAllowed, requireAdminOrRespond, sendJson } from "../../_lib/http.js";

const VALID_REVIEW_STATUSES: ReviewStatus[] = ["pending", "approved", "rejected"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  if (!requireAdminOrRespond(req, res)) return;

  const { status } = req.query;
  const statusFilter =
    typeof status === "string" && VALID_REVIEW_STATUSES.includes(status as ReviewStatus)
      ? (status as ReviewStatus)
      : undefined;
  const results = await getReviewsForAdmin({ status: statusFilter });
  sendJson(res, 200, {
    results,
    count: results.length,
    guidance:
      "Approve accounts of the experience (workload, structure, onboarding, culture). Reject or send back for edit anything that reads as a specific accusation about a named individual's conduct. This is a judgment call per review — not automatable.",
  });
}

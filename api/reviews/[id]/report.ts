// POST /api/reviews/:id/report — public dispute/flag path for a specific
// published review (Addition 3). Ported from backend/src/routes/public.ts
// (publicRouter.post("/reviews/:id/report")). No auth required.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getApprovedReviewById, insertReport } from "../../../backend/src/db/data-access.js";
import type { ReportCategory } from "../../../backend/src/db/schema.js";
import { REPORT_CATEGORIES } from "../../../backend/src/db/schema.js";
import { methodNotAllowed, notFound, sendJson, stringParam, validationError } from "../../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }

  const reviewId = stringParam(req, "id");
  if (!reviewId) {
    notFound(res);
    return;
  }

  const review = await getApprovedReviewById(reviewId);
  if (!review) {
    notFound(res);
    return;
  }

  const body = req.body ?? {};
  const category = typeof body.category === "string" ? (body.category as ReportCategory) : undefined;
  if (!category || !REPORT_CATEGORIES.includes(category)) {
    validationError(res, [`category is required and must be one of ${REPORT_CATEGORIES.join("|")}`]);
    return;
  }

  const id = await insertReport({
    opportunityId: review.opportunityId,
    reviewId,
    category,
    details: typeof body.details === "string" ? body.details : "",
    reporterContact: typeof body.reporterContact === "string" ? body.reporterContact : null,
  });

  sendJson(res, 201, { result: { id, status: "open" } });
}

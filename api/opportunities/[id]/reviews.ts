// POST /api/opportunities/:id/reviews — public, anonymous review submission
// (Addition 3). Ported from
// backend/src/routes/public.ts (publicRouter.post("/opportunities/:id/reviews")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPublic, insertReview } from "../../../backend/src/db/data-access.js";
import { intParam, methodNotAllowed, notFound, sendJson, validationError } from "../../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }

  const opportunityId = intParam(req, "id");
  if (opportunityId === null) {
    notFound(res);
    return;
  }

  // Confirm the opportunity is publicly visible before accepting a review
  // for it (avoids leaking existence of pending/rejected rows via 201s).
  const publicResults = await getPublic();
  const opp = publicResults.find((r) => r.id === opportunityId);
  if (!opp) {
    notFound(res);
    return;
  }

  const body = req.body ?? {};
  const details: string[] = [];
  if (typeof body.timeCommitment !== "string" || body.timeCommitment.trim() === "") {
    details.push("timeCommitment is required");
  }
  if (typeof body.beforeApplying !== "string" || body.beforeApplying.trim() === "") {
    details.push("beforeApplying is required");
  }
  if (typeof body.adviceNewMember !== "string" || body.adviceNewMember.trim() === "") {
    details.push("adviceNewMember is required");
  }
  if (details.length > 0) {
    validationError(res, details);
    return;
  }

  const id = await insertReview({
    opportunityId,
    timeCommitment: body.timeCommitment.trim(),
    beforeApplying: body.beforeApplying.trim(),
    adviceNewMember: body.adviceNewMember.trim(),
  });

  sendJson(res, 201, { result: { id, status: "pending" } });
}

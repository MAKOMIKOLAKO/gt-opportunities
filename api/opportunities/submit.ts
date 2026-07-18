// POST /api/opportunities/submit — public submission endpoint, no auth.
// Ported from backend/src/routes/submit.ts. Inserts via insertSubmission()
// (source='user_submitted', status='pending' — never directly approved).
//
// Note: this is a static route segment ("submit"), which Vercel's
// filesystem router matches before the sibling dynamic segment
// `opportunities/[id]/index.ts` — same precedence rule as Express matching
// a literal path before a `:id` param.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { insertSubmission } from "../../backend/src/db/data-access.js";
import type { OpportunityType } from "../../backend/src/db/schema.js";
import { methodNotAllowed, sendJson, validationError } from "../_lib/http.js";

const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }

  const body = req.body ?? {};
  const details: string[] = [];

  if (typeof body.name !== "string" || body.name.trim() === "") {
    details.push("name is required");
  }
  if (typeof body.description !== "string" || body.description.trim() === "") {
    details.push("description is required");
  }
  if (typeof body.type !== "string" || !VALID_TYPES.includes(body.type)) {
    details.push("type is required and must be one of vip|lab|club");
  }

  if (details.length > 0) {
    validationError(res, details);
    return;
  }

  const id = await insertSubmission({
    type: body.type,
    name: body.name,
    description: body.description,
    majors: Array.isArray(body.majors) ? body.majors : [],
    link: typeof body.link === "string" ? body.link : null,
    tagSlugs: Array.isArray(body.tagSlugs) ? body.tagSlugs : [],
    submittedBy: typeof body.submittedBy === "string" ? body.submittedBy : null,
  });

  sendJson(res, 201, { result: { id, status: "pending" } });
}

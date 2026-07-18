// PATCH /api/admin/opportunities/:id — edit-then-approve flow. Ported from
// backend/src/routes/admin.ts (adminRouter.patch("/admin/opportunities/:id")).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { updateOpportunity } from "../../../../backend/src/db/data-access.js";
import type { OpportunityType } from "../../../../backend/src/db/schema.js";
import { intParam, methodNotAllowed, notFound, requireAdminOrRespond, sendJson, validationError } from "../../../_lib/http.js";

const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "PATCH") {
    methodNotAllowed(res, ["PATCH"]);
    return;
  }
  const reviewedBy = requireAdminOrRespond(req, res);
  if (!reviewedBy) return;

  const id = intParam(req, "id");
  if (id === null) {
    notFound(res);
    return;
  }

  const body = req.body ?? {};
  const details: string[] = [];
  if (body.name !== undefined && typeof body.name !== "string") details.push("name must be a string");
  if (body.description !== undefined && typeof body.description !== "string") details.push("description must be a string");
  if (body.majors !== undefined && !Array.isArray(body.majors)) details.push("majors must be an array");
  if (body.tagSlugs !== undefined && !Array.isArray(body.tagSlugs)) details.push("tagSlugs must be an array");
  if (body.type !== undefined && !VALID_TYPES.includes(body.type)) details.push("type must be one of vip|lab|club");

  if (details.length > 0) {
    validationError(res, details);
    return;
  }

  const result = await updateOpportunity(
    id,
    {
      name: body.name,
      description: body.description,
      majors: body.majors,
      link: body.link,
      tagSlugs: body.tagSlugs,
      type: body.type,
    },
    body.approve === true,
    reviewedBy
  );

  if (!result) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { result });
}

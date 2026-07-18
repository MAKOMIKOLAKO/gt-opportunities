// GET /api/opportunities — list/search/filter approved opportunities.
// Ported from backend/src/routes/public.ts (publicRouter.get("/opportunities")).
// MUST call getPublic() exclusively — never query `opportunities` directly.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPublic } from "../../backend/src/db/data-access.js";
import type { OpportunityType } from "../../backend/src/db/schema.js";
import { methodNotAllowed, sendJson } from "../_lib/http.js";

const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }

  const { type, search, tags } = req.query;

  const typeFilter =
    typeof type === "string" && VALID_TYPES.includes(type as OpportunityType) ? (type as OpportunityType) : undefined;
  const searchFilter = typeof search === "string" && search.length > 0 ? search : undefined;
  const tagSlugs = typeof tags === "string" && tags.length > 0 ? tags.split(",") : undefined;

  const results = await getPublic({ type: typeFilter, search: searchFilter, tagSlugs });
  sendJson(res, 200, { results, count: results.length });
}

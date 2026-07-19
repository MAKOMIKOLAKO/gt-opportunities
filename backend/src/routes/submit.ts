// Public submission endpoint. No auth required. Inserts via the
// insertSubmission() helper in data-access.ts (source='user_submitted',
// status='pending' — never directly approved).
import { Router } from "express";
import { insertSubmission, insertLinkSubmission } from "../db/data-access.js";
import type { OpportunityType, LinkType } from "../db/schema.js";
import { LINK_TYPES } from "../db/schema.js";

const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];

export const submitRouter = Router();

submitRouter.post("/opportunities/submit", async (req, res) => {
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
    res.status(400).json({ error: "validation_error", details });
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

  // Optional array of additional links submitted alongside the opportunity
  // itself (e.g. homepage/social/other apply-adjacent links). Each entry is
  // validated individually — a malformed entry is skipped rather than
  // failing the whole submission, since the opportunity itself is already
  // valid and shouldn't be blocked by one bad link row. See BUILD_NOTES.md.
  if (Array.isArray(body.links)) {
    for (const entry of body.links) {
      if (entry === null || typeof entry !== "object") continue;
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      const url = typeof entry.url === "string" ? entry.url.trim() : "";
      const type = typeof entry.type === "string" ? (entry.type as LinkType) : undefined;
      if (!label || !url || !type || !LINK_TYPES.includes(type)) continue;
      await insertLinkSubmission({
        opportunityId: id,
        label,
        url,
        type,
        submittedBy: typeof body.submittedBy === "string" ? body.submittedBy : null,
      });
    }
  }

  res.status(201).json({ result: { id, status: "pending" } });
});

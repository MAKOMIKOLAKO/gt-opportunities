// Public submission endpoint. No auth required. Inserts via the
// insertSubmission() helper in data-access.ts (source='user_submitted',
// status='pending' — never directly approved).
import { Router } from "express";
import { insertSubmission } from "../db/data-access.js";
import type { OpportunityType } from "../db/schema.js";

const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];

export const submitRouter = Router();

submitRouter.post("/opportunities/submit", (req, res) => {
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

  const id = insertSubmission({
    type: body.type,
    name: body.name,
    description: body.description,
    majors: Array.isArray(body.majors) ? body.majors : [],
    link: typeof body.link === "string" ? body.link : null,
    tagSlugs: Array.isArray(body.tagSlugs) ? body.tagSlugs : [],
    submittedBy: typeof body.submittedBy === "string" ? body.submittedBy : null,
  });

  res.status(201).json({ result: { id, status: "pending" } });
});

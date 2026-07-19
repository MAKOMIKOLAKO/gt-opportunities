// Public read routes. MUST call getPublic()/getAllTags() exclusively —
// never query `opportunities` directly here.
import { Router } from "express";
import {
  getPublic,
  getAllTags,
  getApprovedReviews,
  getApprovedReviewById,
  insertReview,
  insertReport,
  insertSuggestedEdit,
  SUGGESTABLE_FIELDS,
  type SuggestableField,
} from "../db/data-access.js";
import type { OpportunityType, ReportCategory } from "../db/schema.js";
import { REPORT_CATEGORIES } from "../db/schema.js";

const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];

export const publicRouter = Router();

publicRouter.get("/opportunities", async (req, res) => {
  const { type, search, tags } = req.query;

  const typeFilter = typeof type === "string" && VALID_TYPES.includes(type as OpportunityType)
    ? (type as OpportunityType)
    : undefined;
  const searchFilter = typeof search === "string" && search.length > 0 ? search : undefined;
  const tagSlugs = typeof tags === "string" && tags.length > 0 ? tags.split(",") : undefined;

  const results = await getPublic({ type: typeFilter, search: searchFilter, tagSlugs });
  res.json({ results, count: results.length });
});

publicRouter.get("/opportunities/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const results = await getPublic();
  const result = results.find((r) => r.id === id);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const reviews = await getApprovedReviews(id);
  res.json({ result: { ...result, reviews } });
});

publicRouter.get("/tags", async (_req, res) => {
  const results = await getAllTags();
  res.json({ results });
});

// Public review submission — anonymous, no auth, no rating field. Creates
// a pending review; only visible publicly once an admin approves it (see
// getApprovedReviews() in data-access.ts).
publicRouter.post("/opportunities/:id/reviews", async (req, res) => {
  const opportunityId = Number(req.params.id);
  if (!Number.isInteger(opportunityId)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Confirm the opportunity is publicly visible before accepting a review
  // for it (avoids leaking existence of pending/rejected rows via 201s).
  const publicOpportunities = await getPublic();
  const opp = publicOpportunities.find((r) => r.id === opportunityId);
  if (!opp) {
    res.status(404).json({ error: "not_found" });
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
    res.status(400).json({ error: "validation_error", details });
    return;
  }

  const id = await insertReview({
    opportunityId,
    timeCommitment: body.timeCommitment.trim(),
    beforeApplying: body.beforeApplying.trim(),
    adviceNewMember: body.adviceNewMember.trim(),
  });

  res.status(201).json({ result: { id, status: "pending" } });
});

// Public dispute/flag path for a specific published review — extends the
// reports mechanism (reports.reviewId). No auth required (a PI/advisor/club
// leader flagging a review doesn't need an account).
publicRouter.post("/reviews/:id/report", async (req, res) => {
  const reviewId = req.params.id;
  const review = await getApprovedReviewById(reviewId);
  if (!review) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const body = req.body ?? {};
  const category = typeof body.category === "string" ? (body.category as ReportCategory) : undefined;
  if (!category || !REPORT_CATEGORIES.includes(category)) {
    res.status(400).json({
      error: "validation_error",
      details: [`category is required and must be one of ${REPORT_CATEGORIES.join("|")}`],
    });
    return;
  }

  const id = await insertReport({
    opportunityId: review.opportunityId,
    reviewId,
    category,
    details: typeof body.details === "string" ? body.details : "",
    reporterContact: typeof body.reporterContact === "string" ? body.reporterContact : null,
  });

  res.status(201).json({ result: { id, status: "open" } });
});

// Public "suggest an edit" path for a single field on an existing, publicly
// visible opportunity. `field` is validated against a fixed server-side
// allowlist (SUGGESTABLE_FIELDS) — never trust a client-supplied field name,
// since that would let a caller target internal columns (status/source/meta/id).
// Creates a pending suggested_edits row; nothing touches the live
// opportunities row until an admin approves it (see approveSuggestedEdit()).
publicRouter.post("/opportunities/:id/suggest-edit", async (req, res) => {
  const opportunityId = Number(req.params.id);
  if (!Number.isInteger(opportunityId)) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const body = req.body ?? {};
  const field = typeof body.field === "string" ? (body.field as SuggestableField) : undefined;
  const details: string[] = [];
  if (!field || !SUGGESTABLE_FIELDS.includes(field)) {
    details.push(`field is required and must be one of ${SUGGESTABLE_FIELDS.join("|")}`);
  }
  if (typeof body.newValue !== "string" || body.newValue.trim() === "") {
    details.push("newValue is required");
  }
  if (details.length > 0) {
    res.status(400).json({ error: "validation_error", details });
    return;
  }

  const result = await insertSuggestedEdit({
    opportunityId,
    field: field as SuggestableField,
    newValue: body.newValue,
    submittedBy: typeof body.submittedBy === "string" ? body.submittedBy : undefined,
  });

  if (!result.ok) {
    if (result.reason === "not_found") {
      res.status(404).json({ error: "not_found" });
    } else {
      res.status(400).json({ error: "validation_error", details: ["newValue matches the current value"] });
    }
    return;
  }

  res.status(201).json({ result: { id: result.id, status: "pending" } });
});

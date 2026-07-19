// Public read routes. MUST call getPublic()/getAllTags() exclusively —
// never query `opportunities` directly here.
import { Router } from "express";
import {
  getPublic,
  getAllTags,
  getApprovedReviews,
  getApprovedReviewById,
  getRelatedOpportunities,
  insertReview,
  insertReport,
  submitIconPending,
  getApprovedLinks,
  insertLinkSubmission,
  insertSuggestedEdit,
  SUGGESTABLE_FIELDS,
  type SuggestableField,
} from "../db/data-access.js";
import type { OpportunityType, ReportCategory, LinkType } from "../db/schema.js";
import { REPORT_CATEGORIES, LINK_TYPES } from "../db/schema.js";

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
  const links = await getApprovedLinks(id);
  const relatedOrgs = await getRelatedOpportunities(id);
  res.json({ result: { ...result, reviews, links, relatedOrgs } });
});

// Basic content check before it reaches the admin pending-icon queue: must
// look like a plausible https image URL and stay under a sane length. This
// is deliberately NOT a fetch-and-verify (real content-type/size check) —
// actually fetching an arbitrary user-supplied URL server-side has SSRF
// implications that deserve a deliberate design pass; see
// BUILD_NOTES_ICON_FEATURE.md.
// TODO: server-side fetch-and-verify (content-type sniff, size cap, SSRF-safe
// resolved-IP allowlisting + redirect handling) before the URL is trusted —
// currently an admin visually reviewing the thumbnail is the safety net.
const ICON_URL_MAX_LENGTH = 2048;
const ICON_URL_PATTERN = /^https:\/\/[^\s]+\.(png|jpe?g|gif|webp|svg)(\?[^\s]*)?$/i;

// Public icon submission for an EXISTING (public/approved) opportunity —
// there's no id to attach an icon to until an org has been approved. Sets
// iconPendingUrl only; never touches the live iconUrl. Returns 404 if the
// opportunity isn't public, same "can't distinguish pending/rejected from
// doesn't-exist" convention used elsewhere in this file.
publicRouter.post("/opportunities/:id/icon", async (req, res) => {
  const opportunityId = Number(req.params.id);
  if (!Number.isInteger(opportunityId)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const publicOpportunities = await getPublic();
  const opp = publicOpportunities.find((r) => r.id === opportunityId);
  if (!opp) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const body = req.body ?? {};
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const details: string[] = [];
  if (!url) {
    details.push("url is required");
  } else if (url.length > ICON_URL_MAX_LENGTH) {
    details.push(`url must be ${ICON_URL_MAX_LENGTH} characters or fewer`);
  } else if (!ICON_URL_PATTERN.test(url)) {
    details.push("url must be an https:// link ending in .png, .jpg, .jpeg, .gif, .webp, or .svg");
  }
  if (details.length > 0) {
    res.status(400).json({ error: "validation_error", details });
    return;
  }

  await submitIconPending(opportunityId, url);
  res.status(201).json({ result: { id: opportunityId, iconPendingUrl: url } });
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

// Public submission of an ADDITIONAL link (beyond opportunities.link, the
// primary "how to apply" link) — e.g. a homepage, social, or another
// apply-adjacent link. Creates a pending link; only visible publicly once
// an admin approves it (see getApprovedLinks() in data-access.ts).
publicRouter.post("/opportunities/:id/links", async (req, res) => {
  const opportunityId = Number(req.params.id);
  if (!Number.isInteger(opportunityId)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Confirm the opportunity is publicly visible before accepting a link
  // for it (avoids leaking existence of pending/rejected rows via 201s).
  const publicOpportunities = await getPublic();
  const opp = publicOpportunities.find((r) => r.id === opportunityId);
  if (!opp) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const body = req.body ?? {};
  const details: string[] = [];
  if (typeof body.label !== "string" || body.label.trim() === "") {
    details.push("label is required");
  }
  if (typeof body.url !== "string" || body.url.trim() === "") {
    details.push("url is required");
  }
  const type = typeof body.type === "string" ? (body.type as LinkType) : undefined;
  if (!type || !LINK_TYPES.includes(type)) {
    details.push(`type is required and must be one of ${LINK_TYPES.join("|")}`);
  }
  if (details.length > 0) {
    res.status(400).json({ error: "validation_error", details });
    return;
  }

  const id = await insertLinkSubmission({
    opportunityId,
    label: body.label.trim(),
    url: body.url.trim(),
    type: type!,
    submittedBy: typeof body.submittedBy === "string" ? body.submittedBy : null,
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

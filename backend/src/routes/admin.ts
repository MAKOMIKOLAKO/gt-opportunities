// Admin routes. All mutation/read paths here go through getForAdmin() /
// the admin-only mutation helpers in data-access.ts — never getPublic().
import { Router } from "express";
import { ADMIN_USERNAME, ADMIN_PASSWORD, createToken, requireAdmin } from "../lib/auth.js";
import {
  getForAdmin,
  approveOpportunity,
  rejectOpportunity,
  updateOpportunity,
  getReviewsForAdmin,
  approveReview,
  rejectReview,
  getReportsForAdmin,
  resolveReport,
  getPendingIcons,
  approveIcon,
  rejectIcon,
  getLinksForAdmin,
  approveLink,
  rejectLink,
} from "../db/data-access.js";
import type { OpportunityStatus, OpportunityType, ReviewStatus, ReportStatus, LinkStatus } from "../db/schema.js";

const VALID_STATUSES: OpportunityStatus[] = ["approved", "pending", "rejected"];
const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];
const VALID_REVIEW_STATUSES: ReviewStatus[] = ["pending", "approved", "rejected"];
const VALID_REPORT_STATUSES: ReportStatus[] = ["open", "resolved"];
const VALID_LINK_STATUSES: LinkStatus[] = ["pending", "approved", "rejected"];

export const adminRouter = Router();

adminRouter.post("/admin/login", (req, res) => {
  const { username, password } = req.body ?? {};
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const token = createToken(username);
  res.json({ token });
});

// Everything below requires a valid admin session.
adminRouter.use("/admin", requireAdmin);

adminRouter.get("/admin/opportunities", async (req, res) => {
  const { status, type, search } = req.query;
  const statusFilter = typeof status === "string" && VALID_STATUSES.includes(status as OpportunityStatus)
    ? (status as OpportunityStatus)
    : undefined;
  const typeFilter = typeof type === "string" && VALID_TYPES.includes(type as OpportunityType)
    ? (type as OpportunityType)
    : undefined;
  const searchFilter = typeof search === "string" && search.length > 0 ? search : undefined;

  const results = await getForAdmin({ status: statusFilter, type: typeFilter, search: searchFilter });
  res.json({ results, count: results.length });
});

adminRouter.post("/admin/opportunities/:id/approve", async (req, res) => {
  const id = Number(req.params.id);
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = await approveOpportunity(id, reviewedBy);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

adminRouter.post("/admin/opportunities/:id/reject", async (req, res) => {
  const id = Number(req.params.id);
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const result = await rejectOpportunity(id, reviewedBy, reason);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

// ---- Reviews moderation queue (Addition 3) ----
// Moderation guidance (also surfaced in the admin UI near the controls):
// the three review prompts are designed to keep responses about the
// EXPERIENCE (workload, structure, onboarding, culture). Approve accounts
// of the experience. Reject or send back for edit anything that reads as a
// specific accusation about a named individual's conduct. This is a
// judgment call per review — there is no keyword/profanity auto-screening
// and no LLM auto-approve step (see BUILD_NOTES.md).
adminRouter.get("/admin/reviews", async (req, res) => {
  const { status } = req.query;
  const statusFilter = typeof status === "string" && VALID_REVIEW_STATUSES.includes(status as ReviewStatus)
    ? (status as ReviewStatus)
    : undefined;
  const results = await getReviewsForAdmin({ status: statusFilter });
  res.json({
    results,
    count: results.length,
    guidance:
      "Approve accounts of the experience (workload, structure, onboarding, culture). Reject or send back for edit anything that reads as a specific accusation about a named individual's conduct. This is a judgment call per review — not automatable.",
  });
});

adminRouter.post("/admin/reviews/:id/approve", async (req, res) => {
  const id = req.params.id;
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = await approveReview(id, reviewedBy);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

adminRouter.post("/admin/reviews/:id/reject", async (req, res) => {
  const id = req.params.id;
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = await rejectReview(id, reviewedBy);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

// ---- Reports / disputes queue (Addition 3) ----
// See BUILD_NOTES.md — this table/queue duplicates in-progress work on
// worktree-reports-and-vip-search and will need reconciliation when that
// branch merges.
adminRouter.get("/admin/reports", async (req, res) => {
  const { status } = req.query;
  const statusFilter = typeof status === "string" && VALID_REPORT_STATUSES.includes(status as ReportStatus)
    ? (status as ReportStatus)
    : undefined;
  const results = await getReportsForAdmin({ status: statusFilter });
  res.json({ results, count: results.length });
});

adminRouter.post("/admin/reports/:id/resolve", async (req, res) => {
  const id = Number(req.params.id);
  const resolvedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = await resolveReport(id, resolvedBy);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

// ---- Org profile icon review queue (icon submission feature) ----
// Same pending -> admin-review -> approved lifecycle as the opportunities
// queue above, scoped to the iconUrl/iconPendingUrl pair.
adminRouter.get("/admin/icons/pending", async (_req, res) => {
  const results = await getPendingIcons();
  res.json({ results, count: results.length });
});

adminRouter.post("/admin/opportunities/:id/icon/approve", async (req, res) => {
  const id = Number(req.params.id);
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = await approveIcon(id, reviewedBy);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

adminRouter.post("/admin/opportunities/:id/icon/reject", async (req, res) => {
  const id = Number(req.params.id);
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = await rejectIcon(id, reviewedBy);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

// ---- Links moderation queue (additional org links beyond "how to apply") ----
adminRouter.get("/admin/links", async (req, res) => {
  const { status } = req.query;
  const statusFilter = typeof status === "string" && VALID_LINK_STATUSES.includes(status as LinkStatus)
    ? (status as LinkStatus)
    : undefined;
  const results = await getLinksForAdmin({ status: statusFilter });
  res.json({ results, count: results.length });
});

adminRouter.post("/admin/links/:id/approve", async (req, res) => {
  const id = Number(req.params.id);
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = await approveLink(id, reviewedBy);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

adminRouter.post("/admin/links/:id/reject", async (req, res) => {
  const id = Number(req.params.id);
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = await rejectLink(id, reviewedBy);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

adminRouter.patch("/admin/opportunities/:id", async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;

  const details: string[] = [];
  if (body.name !== undefined && typeof body.name !== "string") details.push("name must be a string");
  if (body.description !== undefined && typeof body.description !== "string") details.push("description must be a string");
  if (body.majors !== undefined && !Array.isArray(body.majors)) details.push("majors must be an array");
  if (body.tagSlugs !== undefined && !Array.isArray(body.tagSlugs)) details.push("tagSlugs must be an array");
  if (body.type !== undefined && !VALID_TYPES.includes(body.type)) details.push("type must be one of vip|lab|club");

  if (details.length > 0) {
    res.status(400).json({ error: "validation_error", details });
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
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

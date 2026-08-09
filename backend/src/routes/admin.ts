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
  getSuggestedEditsForAdmin,
  approveSuggestedEdit,
  rejectSuggestedEdit,
  getAccessRequestsForAdmin,
  getAccessRequest,
  updateAccessRequestStatus,
  getActiveAccessForOpportunity,
  createMagicLink,
  appendAuditLog,
} from "../db/data-access.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import type {
  OpportunityStatus,
  OpportunityType,
  ReviewStatus,
  ReportStatus,
  LinkStatus,
  SuggestedEditStatus,
  AccessRequestStatus,
} from "../db/schema.js";

const VALID_STATUSES: OpportunityStatus[] = ["approved", "pending", "rejected"];
const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];
const VALID_REVIEW_STATUSES: ReviewStatus[] = ["pending", "approved", "rejected"];
const VALID_REPORT_STATUSES: ReportStatus[] = ["open", "resolved"];
const VALID_LINK_STATUSES: LinkStatus[] = ["pending", "approved", "rejected"];
const VALID_SUGGESTED_EDIT_STATUSES: SuggestedEditStatus[] = ["pending", "approved", "rejected"];
const VALID_ACCESS_REQUEST_STATUSES: AccessRequestStatus[] = ["pending", "approved", "denied"];

// Claim links minted from the admin approve/resend flows below live for 72
// hours — long enough for the admin to copy the link out of the JSON
// response and hand it to the org over whatever channel they use (email,
// Slack, in person), given this repo has no outbound email/SMS delivery
// infra (checked: no nodemailer/sendgrid/twilio dependency in
// backend/package.json) — same reasoning leader.ts's login-request route
// documents for why it returns the raw token directly instead of "sending"
// it.
const CLAIM_LINK_TTL_MS = 72 * 60 * 60 * 1000;

function buildClaimLinkPath(rawToken: string): string {
  // Same relative-path convention leader.ts's login-request route uses —
  // no leader-facing frontend route exists yet to turn this into an
  // absolute URL, so this is a convention the admin UI prefixes with
  // window.location.origin, not a live link on its own.
  return `/leader/verify?token=${rawToken}`;
}

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

// ---- Suggested edits moderation queue ----
// Mirrors the reviews queue shape: opportunityName is joined in so the
// queue never needs a second lookup to show what's being edited.
adminRouter.get("/admin/suggested-edits", async (req, res) => {
  const { status } = req.query;
  const statusFilter =
    typeof status === "string" && VALID_SUGGESTED_EDIT_STATUSES.includes(status as SuggestedEditStatus)
      ? (status as SuggestedEditStatus)
      : undefined;
  const results = await getSuggestedEditsForAdmin({ status: statusFilter });
  res.json({ results, count: results.length });
});

adminRouter.post("/admin/suggested-edits/:id/approve", async (req, res) => {
  const id = Number(req.params.id);
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = await approveSuggestedEdit(id, reviewedBy);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ result });
});

adminRouter.post("/admin/suggested-edits/:id/reject", async (req, res) => {
  const id = Number(req.params.id);
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  const result = await rejectSuggestedEdit(id, reviewedBy);
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

// ---- Club/VIP leader access review queue (module 4 of 7) ----
// Admin-side of the leader-access feature: reviews access_requests filed via
// the public "request access" form (module 3), and — on approval — mints the
// magic_links row a claimant will redeem at POST /api/leader/verify (module
// 2). This module does NOT build the leader edit UI (module 5) or
// revocation controls (module 6); approving here creates the magic_links
// row only, not the opportunity_access row itself — that row is created
// lazily the first time the claim link is actually redeemed (see
// leader.ts's /leader/verify, purpose === "claim" branch), so a request that
// gets approved but never claimed leaves no dangling opportunity_access row.
adminRouter.get("/admin/access-requests", async (req, res) => {
  const { status } = req.query;
  const statusFilter =
    typeof status === "string" && VALID_ACCESS_REQUEST_STATUSES.includes(status as AccessRequestStatus)
      ? (status as AccessRequestStatus)
      : "pending"; // default filter, per spec — the queue starts on "what needs my attention".
  const results = await getAccessRequestsForAdmin({ status: statusFilter });
  res.json({ results, count: results.length });
});

adminRouter.post("/admin/access-requests/:id/approve", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await getAccessRequest(id);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const updated = await updateAccessRequestStatus(id, "approved");
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const rawToken = generateToken();
  const expiresAt = new Date(Date.now() + CLAIM_LINK_TTL_MS).toISOString();
  await createMagicLink({
    opportunityId: existing.opportunityId,
    tokenHash: hashToken(rawToken),
    purpose: "claim",
    expiresAt,
  });

  // audit_log action string settled on: "approve_request" — deliberately
  // distinct from "grant_access" (which leader.ts's /leader/verify writes
  // the moment an org actually redeems a claim link and opportunity_access
  // is first created). Reusing "grant_access" here would make the audit
  // trail ambiguous between "admin approved a request" and "org actually
  // claimed access", which can happen at very different times (or never, if
  // the link goes unused) — keeping them separate strings lets a future
  // audit-log viewer (module 7) tell the two events apart.
  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  await appendAuditLog({
    opportunityId: existing.opportunityId,
    actor: reviewedBy,
    action: "approve_request",
  });

  // Raw token returned exactly once, in this response body — never
  // persisted (only its hash is), never emailed/texted (no outbound
  // delivery infra in this repo — checked backend/package.json for
  // nodemailer/sendgrid/twilio, none present), so the admin must manually
  // copy `claimLink`/`claimToken` out of this response and send it to the
  // org via requesterContact shown in the queue.
  res.json({
    result: updated,
    claimToken: rawToken,
    claimLinkPath: buildClaimLinkPath(rawToken),
    expiresAt,
  });
});

adminRouter.post("/admin/access-requests/:id/deny", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await getAccessRequest(id);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const updated = await updateAccessRequestStatus(id, "denied");
  if (!updated) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  await appendAuditLog({
    opportunityId: existing.opportunityId,
    actor: reviewedBy,
    action: "deny_request",
  });

  res.json({ result: updated });
});

// ---- Resend / fresh claim link (module 4 of 7) ----
// Covers the "first claim link expired unused, and there was never a
// pending access_request for it (e.g. an org that got access under an older
// flow, or the original request row is long gone from the default 'pending'
// filter above)" case — lets an admin mint a brand new purpose='claim'
// magic_links row for an opportunity without needing a fresh
// access_requests row to approve.
//
// GUARD CHOSEN (documented per task instructions): reject with 409 if the
// opportunity already has an ACTIVE opportunity_access row
// (getActiveAccessForOpportunity() !== null). Reasoning: a claim link's job
// is to perform the *first* claim of a shared org account; an org that
// already has active access should use the self-service login-link flow
// (POST /api/leader/login-request) to get back in, not a fresh claim link.
// Minting a claim link on top of an already-active org isn't unsafe on its
// own (leader.ts's /leader/verify treats a second claim redemption as an
// idempotent no-op reusing the existing opportunity_access row — see its
// CLAIM-VS-REVOKED comment), but allowing it here would blur this endpoint's
// purpose and make it look like a way to "re-invite" an org without going
// through revocation (module 6) first. If an admin genuinely needs to hand
// a *revoked* org a fresh way back in, that is a deliberate access decision
// that belongs together with a revoke/re-grant flow (module 6), not this
// endpoint.
adminRouter.post("/admin/opportunities/:opportunityId/resend-claim-link", async (req, res) => {
  const opportunityId = Number(req.params.opportunityId);
  if (!Number.isInteger(opportunityId)) {
    res.status(400).json({ error: "validation_error", details: ["opportunityId must be an integer"] });
    return;
  }

  const activeAccess = await getActiveAccessForOpportunity(opportunityId);
  if (activeAccess) {
    res.status(409).json({
      error: "already_has_active_access",
      message:
        "This opportunity already has active leader access. Use the self-service login link (POST /api/leader/login-request) instead, or revoke access first if you intend to re-invite a different claimant.",
    });
    return;
  }

  const rawToken = generateToken();
  const expiresAt = new Date(Date.now() + CLAIM_LINK_TTL_MS).toISOString();
  await createMagicLink({
    opportunityId,
    tokenHash: hashToken(rawToken),
    purpose: "claim",
    expiresAt,
  });

  const reviewedBy = (req as typeof req & { adminUser?: string }).adminUser ?? ADMIN_USERNAME;
  await appendAuditLog({
    opportunityId,
    actor: reviewedBy,
    action: "reissue_claim_link",
  });

  res.json({
    result: { opportunityId },
    claimToken: rawToken,
    claimLinkPath: buildClaimLinkPath(rawToken),
    expiresAt,
  });
});

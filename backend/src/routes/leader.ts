// Leader-access magic-link verification + session handling (module 2 of 7).
// Builds on module 1's schema/data-access layer (opportunity_access,
// access_requests, magic_links, sessions, audit_log — see
// backend/src/db/data-access.ts) to let a club/VIP claim, and later log back
// into, a single shared session scoped to their own opportunity_id.
//
// Explicitly OUT of scope for this module (later modules): the admin
// approve/deny UI that creates the *first* claim magic_links row (module 4),
// the public "request access" form (module 3), the leader edit UI itself
// (module 5), and admin revocation UI (module 6). This module only owns:
// consuming a magic link (claim or login), issuing fresh login links, and
// the session middleware later modules import to gate their own routes.
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { uploadLeaderIcon, ALLOWED_ICON_MIME_TYPES, MAX_ICON_UPLOAD_BYTES } from "../lib/storage.js";
import {
  getMagicLinkByTokenHash,
  consumeMagicLinkAtomic,
  createMagicLink,
  getOpportunityAccess,
  getActiveAccessForOpportunity,
  createOpportunityAccess,
  createSession,
  getSessionByTokenHash,
  appendAuditLog,
  listAccessRequestsForOpportunity,
  createAccessRequest,
  getPublic,
  getLeaderEditableOpportunity,
  updateLeaderOpportunity,
} from "../db/data-access.js";
import { LINK_TYPES } from "../db/schema.js";
import type { LinkType } from "../db/schema.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { createRateLimiter } from "../lib/rate-limit.js";

export const leaderRouter = Router();

// ---- Cookie helpers ----
// No cookie-parser dependency exists in this repo (checked package.json) and
// this is the only route file that needs to READ a cookie (setting one is
// built into Express's `res.cookie` already) — a tiny manual parse of the
// `Cookie` request header is simpler than adding a new dependency for one
// call site.
export const SESSION_COOKIE_NAME = "leader_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — picked as a reasonable "stay logged in" duration for a low-stakes shared org account; easy to shorten later if that turns out too long.
const LOGIN_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes — short-lived, OTP-style, since login links are self-service-issued (see login-request route) rather than admin-vetted like the original claim link.

// Exported so the /org/:slug/manage SSR route (routes/seo.ts, module 5 of the
// per-org-subpages task) can peek at the session cookie itself — it needs to
// know *which* org a logged-in leader's session belongs to (to catch a
// bookmarked/shared manage link for the wrong org) before the page's client
// JS ever runs, which requireLeaderSession alone can't do since that
// middleware 401s outright rather than reporting "logged in, wrong org".
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function setSessionCookie(res: Response, rawToken: string): void {
  // httpOnly + secure + sameSite=lax is the explicit minimum this module was
  // asked for. `secure: true` unconditionally (not gated on NODE_ENV) per
  // that requirement — this repo's real deployments (Vercel/Railway) are
  // HTTPS-only, so the only cost is that a plain-http local dev server can't
  // read the cookie back in the browser; local API-level testing (curl,
  // supertest hitting the Express app directly) is unaffected since it's the
  // browser's HTTPS-only cookie jar enforcing this, not the server.
  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

// ---- Session middleware (exported for later modules) ----
// Usage from a later module: `import { requireLeaderSession } from
// "../routes/leader.js"` and mount it on any route that needs a logged-in
// org session, e.g.:
//   router.patch("/leader/opportunities/:id", requireLeaderSession, (req, res) => {
//     if (req.leaderOpportunityId !== Number(req.params.id)) { res.status(403)...; return; }
//     ...
//   });
// The `:id` comparison above is NOT optional — this middleware only proves
// "there is a valid, unrevoked, unexpired session for *some* opportunity_id".
// It intentionally does not know or care what URL it's protecting, so every
// route handler that uses it MUST independently compare
// `req.leaderOpportunityId` against whatever opportunity the request target
// (URL param) refers to. Skipping that comparison would let org A's session
// edit org B's listing.
declare module "express-serve-static-core" {
  interface Request {
    leaderOpportunityId?: number;
  }
}

export async function requireLeaderSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cookies = parseCookies(req.header("cookie"));
  const raw = cookies[SESSION_COOKIE_NAME];
  if (!raw) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const session = await getSessionByTokenHash(hashToken(raw));
  const now = Date.now();
  if (!session || session.revokedAt || new Date(session.expiresAt).getTime() < now) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  req.leaderOpportunityId = session.opportunityId;
  next();
}

// ---- POST /api/leader/verify — consumes a claim OR login magic link ----
// Single endpoint for both purposes (per spec: the verification path is
// shared). `purpose` lives on the magic_links row itself, not on the URL, so
// there's nothing purpose-specific about the route shape — only about what
// happens after the token is confirmed valid.
//
// CLAIM-VS-REVOKED DECISION (documented per task instructions): if the
// opportunity's most recent opportunity_access row is 'revoked', NEITHER a
// login link NOR a claim link may resurrect it. Revocation is a deliberate
// admin action (module 6); reactivating access should require a fresh
// admin-approved grant (a brand new opportunity_access row via module 4's
// flow), not just replaying/reissuing a magic link. This keeps claim and
// login symmetric and avoids a claim link (which could in principle be
// re-sent by an admin from an old email thread) silently undoing a
// revocation. The magic link itself is still consumed (single-use) even
// when this happens — see the "still spent" note below.
leaderRouter.post("/leader/verify", async (req, res) => {
  const body = req.body ?? {};
  const rawToken = typeof body.token === "string" ? body.token : "";
  if (!rawToken) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  const tokenHash = hashToken(rawToken);

  // Atomically claims the row (UPDATE ... WHERE used_at IS NULL AND
  // expires_at > now() RETURNING — see consumeMagicLinkAtomic in
  // data-access.ts) so a double-submit race can't consume the same token
  // twice. This replaces the naive "look up, check fields, then call
  // markMagicLinkUsed()" sequence the task sketched, specifically to close
  // that race — markMagicLinkUsed() is still exported/available for other
  // callers but isn't used on this path.
  const magicLink = await consumeMagicLinkAtomic(tokenHash);

  if (!magicLink) {
    // Server-side-only diagnostic: distinguish not-found / used / expired
    // for logs, WITHOUT letting that distinction reach the HTTP response
    // (constant "invalid_token" for all three, per the no-enumeration
    // requirement).
    const existing = await getMagicLinkByTokenHash(tokenHash);
    if (!existing) {
      console.warn("[leader/verify] token not found");
    } else if (existing.usedAt) {
      console.warn(`[leader/verify] token already used at ${existing.usedAt} (magic_link id=${existing.id})`);
    } else {
      console.warn(`[leader/verify] token expired at ${existing.expiresAt} (magic_link id=${existing.id})`);
    }
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  const opportunityId = magicLink.opportunityId;

  let accessId: number;
  if (magicLink.purpose === "claim") {
    const existingAccess = await getOpportunityAccess(opportunityId);
    if (!existingAccess) {
      // First-ever claim for this org: create the shared access row and
      // record it in the audit trail (actor = the opportunity id itself,
      // per schema.ts's convention for an org acting as itself).
      const created = await createOpportunityAccess(opportunityId);
      accessId = created.id;
      await appendAuditLog({
        opportunityId,
        actor: String(opportunityId),
        action: "grant_access",
      });
    } else if (existingAccess.status === "active") {
      // Idempotent re-claim (e.g. a second officer redeeming a second claim
      // link for the same org, or a retried request) — reuse the existing
      // row, no new audit entry (nothing changed).
      accessId = existingAccess.id;
    } else {
      // status === "revoked" — see CLAIM-VS-REVOKED DECISION above. The
      // magic link is already consumed (spent) at this point; it is not
      // un-consumed on this failure path, by design (single-use tokens
      // shouldn't become replayable just because the outcome was a no).
      res.status(401).json({ error: "invalid_token" });
      return;
    }
  } else {
    // purpose === "login": must NOT create a new opportunity_access row.
    // Only an *active* row counts — a revoked or nonexistent row both fail
    // the same generic way (no enumeration of which case it was).
    const activeAccess = await getActiveAccessForOpportunity(opportunityId);
    if (!activeAccess) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    accessId = activeAccess.id;
    // No audit_log row for a routine login, by design — grant/revoke/edit
    // events are what the audit trail is for; every login would otherwise
    // drown those out. (Session creation itself is still recorded in the
    // `sessions` table, which is its own lightweight login history.)
  }

  const rawSessionToken = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await createSession({
    opportunityId,
    tokenHash: hashToken(rawSessionToken),
    expiresAt,
  });

  setSessionCookie(res, rawSessionToken);
  res.json({ result: { opportunityId, accessId, purpose: magicLink.purpose } });
});

// ---- POST /api/leader/login-request — self-service re-issue of a login link ----
// v1 CONTACT-MATCHING TRADEOFF (documented per task instructions):
// opportunity_access does not store contact info (only access_requests
// does). This route treats the requester_contact on the org's most recently
// APPROVED access_request as the "known contact on file" and only issues a
// fresh login link if the submitted contact matches it (case-insensitive,
// trimmed). This is a deliberate v1 shortcut, not real contact management:
//   - it trusts whatever contact string was on the ORIGINAL approved
//     request, with no way to update it short of filing (and having
//     approved) a brand new access_request;
//   - it has no notion of "multiple valid contacts for one org" (e.g. two
//     officers) beyond whichever access_request was approved most recently;
//   - if an org's contact changes, they lose self-service login until an
//     admin re-approves a new request for them (out of scope here — module
//     4/6 territory).
// A more complete version would need its own "contact info" concept on
// opportunity_access itself; that's future work, not this module.
const loginRequestLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Single generic response shape returned on EVERY non-match outcome
// (unknown opportunity, no approved request on file, contact mismatch, no
// active access) so a caller can't enumerate which orgs exist / have access
// by watching which requests come back "different".
const GENERIC_RESULT = { result: { status: "if_matched_a_link_was_issued" } };

leaderRouter.post("/leader/login-request", loginRequestLimiter, async (req, res) => {
  const body = req.body ?? {};
  const opportunityId = Number(body.opportunityId);
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";

  if (!Number.isInteger(opportunityId) || !contact) {
    res.status(400).json({ error: "validation_error", details: ["opportunityId and contact are required"] });
    return;
  }

  const approvedRequests = await listAccessRequestsForOpportunity(opportunityId, { status: "approved" });
  const knownContact = approvedRequests[0]?.requesterContact; // most-recent-first, see data-access.ts
  const activeAccess = await getActiveAccessForOpportunity(opportunityId);

  const matches =
    !!knownContact &&
    !!activeAccess &&
    knownContact.trim().toLowerCase() === contact.toLowerCase();

  if (!matches) {
    // Artificial delay on the non-match path only (per spec) so a caller
    // can't use response latency to distinguish "this org doesn't exist" /
    // "wrong contact" / "no active access" from a genuine match attempt.
    await sleep(250 + Math.floor(Math.random() * 150));
    res.json(GENERIC_RESULT);
    return;
  }

  const rawToken = generateToken();
  const expiresAt = new Date(Date.now() + LOGIN_LINK_TTL_MS).toISOString();
  await createMagicLink({
    opportunityId,
    tokenHash: hashToken(rawToken),
    purpose: "login",
    expiresAt,
  });

  // No outbound email/SMS infra exists in this repo — mirrors module 1's
  // sibling "admin sends manually" approach by returning the raw token/link
  // directly in the response body instead. This is safe ONLY because we
  // already confirmed `matches` above; an unmatched request never reaches
  // this branch, so this response body never leaks a usable token to
  // someone who doesn't already know the org's contact on file.
  const orgs = await getPublic();
  const org = orgs.find((o) => o.id === opportunityId);
  const path = org ? `/org/${org.slug}/manage?token=${rawToken}` : `/leader/verify?token=${rawToken}`;

  res.json({
    result: {
      status: "issued",
      token: rawToken,
      // Real, live URL now (/org/:slug/manage — leader-edit.js consumes
      // `?token=` off it directly on load; see routes/seo.ts and
      // BUILD_NOTES_ORG_SUBPAGES.md).
      path,
      expiresAt,
    },
  });
});

// ---- POST /api/leader/access-requests — public "request leader access" form (module 3 of 7) ----
// No auth required — same public-submission shape as public.ts's review/
// link/suggest-edit endpoints: validates against the real (approved-only)
// opportunity via getPublic(), the same "can't distinguish pending/rejected
// from doesn't-exist" convention used throughout that file, then inserts a
// pending access_requests row via createAccessRequest() (module 1's data
// layer). Nothing here touches opportunity_access — an admin approving the
// request (module 4, not this module) is what eventually issues the first
// claim magic_links row.
//
// RATE LIMIT (documented per task instructions): 5 requests per 15 minutes
// per IP, matching loginRequestLimiter just above — this endpoint is the
// same "low-traffic, self-service, public, no CAPTCHA" shape as
// login-request, so it reuses the same numbers rather than inventing new
// ones. Keyed by IP only (not by opportunity), so a caller can't hammer a
// single org's request queue by spreading requests across many
// opportunity_ids either.
const accessRequestLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

leaderRouter.post("/leader/access-requests", accessRequestLimiter, async (req, res) => {
  const body = req.body ?? {};
  const opportunityId = Number(body.opportunity_id ?? body.opportunityId);
  const requesterName = typeof body.requester_name === "string" ? body.requester_name.trim() : "";
  const requesterContact = typeof body.requester_contact === "string" ? body.requester_contact.trim() : "";
  const noteRaw = typeof body.note === "string" ? body.note.trim() : "";

  const details: string[] = [];
  if (!Number.isInteger(opportunityId)) details.push("opportunity_id is required");
  if (!requesterName) details.push("requester_name is required");
  if (!requesterContact) details.push("requester_contact is required");

  if (details.length > 0) {
    res.status(400).json({ error: "validation_error", details });
    return;
  }

  // Confirm the opportunity is a real, publicly visible (approved) org
  // before accepting a request against it — same "404, don't leak
  // pending/rejected rows" convention as public.ts's review/link/
  // suggest-edit endpoints.
  const publicOpportunities = await getPublic();
  const opp = publicOpportunities.find((r) => r.id === opportunityId);
  if (!opp) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const created = await createAccessRequest({
    opportunityId,
    requesterName,
    requesterContact,
    note: noteRaw || null,
  });

  res.status(201).json({ result: { id: created.id, status: created.status } });
});

// ---- GET/PUT /api/leader/opportunity — session-scoped edit surface (module 5) ----
// Both routes are gated by requireLeaderSession and use ONLY
// `req.leaderOpportunityId` (from the session) to decide which row to
// read/write — never an id from the URL or body. That's the whole point of
// a shared-per-org session: a valid cookie for org A must be structurally
// incapable of touching org B's row, so there is no :id param on either
// route at all.
leaderRouter.get("/leader/opportunity", requireLeaderSession, async (req, res) => {
  const result = await getLeaderEditableOpportunity(req.leaderOpportunityId!);
  if (!result) {
    // The opportunity row itself is gone (e.g. hard-deleted) even though the
    // session is still technically valid — treat as unauthorized rather than
    // leaking a 404/500 distinction to the client.
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json({ result });
});

// Field whitelist for the PUT body — matches getLeaderEditableOpportunity's
// shape exactly (description, tags, link ["application info"], iconUrl,
// links). Anything else in the body is silently ignored, not rejected —
// matches this repo's existing PATCH /admin/opportunities/:id convention of
// only reading recognized keys off `body` rather than 400ing on unknown
// ones.
leaderRouter.put("/leader/opportunity", requireLeaderSession, async (req, res) => {
  const body = req.body ?? {};
  const details: string[] = [];

  if (body.description !== undefined && typeof body.description !== "string") {
    details.push("description must be a string");
  }
  if (body.link !== undefined && body.link !== null && typeof body.link !== "string") {
    details.push("link must be a string or null");
  }
  if (body.iconUrl !== undefined && body.iconUrl !== null && typeof body.iconUrl !== "string") {
    details.push("iconUrl must be a string or null");
  }
  if (body.tagSlugs !== undefined) {
    if (!Array.isArray(body.tagSlugs) || body.tagSlugs.some((s: unknown) => typeof s !== "string")) {
      details.push("tagSlugs must be an array of strings");
    }
  }
  let validatedLinks: { label: string; url: string; type: LinkType }[] | undefined;
  if (body.links !== undefined) {
    if (!Array.isArray(body.links)) {
      details.push("links must be an array");
    } else {
      validatedLinks = [];
      for (const entry of body.links) {
        if (entry === null || typeof entry !== "object") {
          details.push("each link must be an object with label, url, and type");
          continue;
        }
        const label = typeof entry.label === "string" ? entry.label.trim() : "";
        const url = typeof entry.url === "string" ? entry.url.trim() : "";
        const type = typeof entry.type === "string" ? entry.type : "";
        if (!label || !url || !LINK_TYPES.includes(type as LinkType)) {
          details.push(`each link needs a non-empty label, url, and type in ${LINK_TYPES.join("|")}`);
          continue;
        }
        validatedLinks.push({ label, url, type: type as LinkType });
      }
    }
  }

  if (details.length > 0) {
    res.status(400).json({ error: "validation_error", details });
    return;
  }

  const result = await updateLeaderOpportunity(req.leaderOpportunityId!, {
    description: body.description,
    link: body.link,
    iconUrl: body.iconUrl,
    tagSlugs: body.tagSlugs,
    links: validatedLinks,
  });

  if (!result) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json({ result });
});

// ---- POST /api/leader/opportunity/icon — direct icon upload, no review ----
// Mirrors public.ts's POST /opportunities/:id/icon (real file upload, never
// a leader-typed URL fetched server-side — same SSRF reasoning, see
// lib/storage.ts) but WITHOUT the pending-review step: a leader already has
// direct-write access to every other field via PUT /leader/opportunity
// above, so gating just the icon behind admin approval would be
// inconsistent. This route only uploads the file and hands back its public
// URL — it does NOT write iconUrl itself, so the leader edit page fills the
// icon URL field with the response and the existing Save button (PUT
// /leader/opportunity) is what actually persists it, same single write path
// as every other field on the form.
const iconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ICON_UPLOAD_BYTES },
});

function handleIconUpload(req: Request, res: Response, next: NextFunction): void {
  iconUpload.single("icon")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: "validation_error", details: [err.message] });
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

leaderRouter.post("/leader/opportunity/icon", requireLeaderSession, handleIconUpload, async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "validation_error", details: ["icon file is required"] });
    return;
  }
  if (!ALLOWED_ICON_MIME_TYPES.includes(file.mimetype)) {
    res.status(400).json({
      error: "validation_error",
      details: [`icon must be one of: ${ALLOWED_ICON_MIME_TYPES.join(", ")}`],
    });
    return;
  }

  const url = await uploadLeaderIcon(req.leaderOpportunityId!, file.buffer, file.mimetype);
  res.status(201).json({ result: { iconUrl: url } });
});

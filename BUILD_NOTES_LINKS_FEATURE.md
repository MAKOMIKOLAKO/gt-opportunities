# Build notes — Additional org links beyond "how to apply" (2026-07-19)

Built in an isolated worktree as one of four parallel overnight features.
Split into a separate file (rather than appending to `BUILD_NOTES.md`) to
avoid merge conflicts with other agents editing that file in parallel.

## What was built

- **Schema** (`backend/src/db/schema.ts`): new `links` table — child table
  keyed by `opportunityId` (FK to `opportunities.id`, `onDelete: cascade`).
  Columns: `id` (serial PK), `opportunityId`, `label`, `url`, `type`
  (`$type<LinkType>()`, app-level enum, not a Postgres native enum),
  `status` (`$type<LinkStatus>()`, default `pending`), `submittedBy`,
  `createdAt`, `reviewedBy`, `reviewedAt`. Exports `LINK_TYPES` (`apply |
  homepage | social | other`) and `LINK_STATUSES` (`pending | approved |
  rejected`) as const-array + type, matching the `OPPORTUNITY_TYPES` /
  `REVIEW_STATUSES` pattern. `opportunities.link` (the single primary
  how-to-apply link) is untouched — this table is strictly additive.
  Migration generated via `npx drizzle-kit generate` →
  `backend/src/db/migrations/0001_illegal_genesis.sql`. NOT run against any
  database (no reachable `DATABASE_URL` in this worktree, and instructed not
  to).

- **Data access** (`backend/src/db/data-access.ts`): `LinkDTO` +
  `toLinkDTO()`, `insertLinkSubmission()` (public path, always
  `status: "pending"`), `getApprovedLinks(opportunityId)` (the only
  sanctioned public read path — status hardcoded to `approved`; `apply`-typed
  rows sorted first, then creation order), `getLinksForAdmin(filters)`
  (admin-only, joins `opportunityName` like `getReviewsForAdmin`),
  `approveLink(id, reviewedBy)` / `rejectLink(id, reviewedBy)`. Mirrors the
  `reviews` section's shape closely, per the task brief.

- **Routes**:
  - `POST /api/opportunities/:id/links` (public.ts) — mirrors the review
    submission route's validation style: 404 if the opportunity isn't
    publicly visible, 400 `validation_error` with `details[]` for missing
    `label`/`url` or an invalid `type`, `201 { result: { id, status:
    "pending" } }` on success.
  - `GET /api/opportunities/:id` (public.ts) — now also returns a `links`
    array (approved-only) alongside the existing `reviews` array.
  - `GET /api/admin/links?status=pending`, `POST /api/admin/links/:id/approve`,
    `POST /api/admin/links/:id/reject` (admin.ts) — all behind
    `requireAdmin`, mirroring the reviews admin routes' response shapes
    exactly (`{ result: Link }`, `404 { error: "not_found" }`).
  - `POST /api/opportunities/submit` (submit.ts) — now accepts an optional
    `links: [{ label, url, type }]` array. Each entry is validated
    individually and inserted as a pending `links` row via
    `insertLinkSubmission()` after the opportunity itself is created;
    malformed entries (missing label/url, or an invalid type) are silently
    skipped rather than failing the whole submission — the opportunity
    submission itself is already valid at that point and one bad link row
    shouldn't block it.

- **API-CONTRACT.md**: added the `Link` (`LinkDTO`) shape, documented
  `POST /api/opportunities/:id/links`, extended the `GET
  /api/opportunities/:id` and `POST /api/opportunities/submit` docs, and
  added the three `/api/admin/links*` endpoints — all additive, following
  the existing Review/Report section template.

- **Frontend**:
  - `frontend/public/app.js` / `style.css` — org detail view now renders a
    "More links" block (`renderLinksBlock`) below the existing Apply
    button/contact footer, showing each approved link with a small type
    badge (Apply/Homepage/Social/Link) and its label as a clickable link.
  - Submission form (`index.html` is untouched; the form markup lives in
    `renderSubmit()` in `app.js`) — added a repeatable "Additional links"
    field group (label input, URL input, type `<select>`, add/remove-row
    controls) serialized into the `links` array sent to
    `/api/opportunities/submit`. Rows are managed via direct DOM
    manipulation (`insertAdjacentHTML` / `.remove()`) rather than app state,
    consistent with how the rest of this vanilla-JS app avoids re-rendering
    live form input.
  - `frontend/public/admin.js` — new "Links" tab in the admin moderation
    queue (alongside Reviews / Reports), listing pending link submissions
    (opportunity name, label, url, type) with Approve/Reject buttons wired
    to the new admin endpoints, following the existing pending-queue tab
    pattern exactly (`renderLinksTab`, `approveLink`/`rejectLink`,
    `loadQueues()` now also fetches `/admin/links?status=pending`).

## Skipped / deferred

- No dedupe/URL-validation beyond "non-empty string" — a link submission
  with a garbage `url` value (e.g. not a real URL) is accepted as pending
  and relies on the admin reviewer to catch it, same trust model as the
  existing `opportunities.link` field and review/report text fields.
- No rate limiting or spam protection on the public link-submission route,
  consistent with the existing review/report/submit routes (none of them
  have it either).
- Link `type` is a plain text column validated at the route layer against
  `LINK_TYPES`, not a Postgres native enum — matches the instruction to
  keep it "explicitly extensible later" and is consistent with how
  `OpportunityType`/`OpportunityStatus`/etc. are all plain text + app-level
  validation in this schema, not native Postgres enums.

## Assumptions

- "Apply-adjacent" `apply`-typed rows in this table are treated as
  ADDITIONAL apply links, not a replacement for `opportunities.link` (the
  spec explicitly called this out) — `getApprovedLinks()` sorts them first
  among the additional links, but `opportunities.link` is still what powers
  the primary "How to Apply" button in the UI.
- `submittedBy` on a link created via the submission-form `links[]` array
  reuses the opportunity submission's own `submittedBy` (the submitter's
  email), same as how the opportunity row itself is stamped.

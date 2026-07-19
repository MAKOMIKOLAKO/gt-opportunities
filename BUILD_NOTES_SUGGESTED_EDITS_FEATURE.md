# Build notes — Suggest edits on existing listings (2026-07-19)

Built in an isolated worktree as one of four parallel overnight features.
Written as a separate file (rather than appending to `BUILD_NOTES.md`) to
avoid merge conflicts with other agents editing that file in their own
worktrees at the same time; fold this into `BUILD_NOTES.md` proper at
integration time.

## What was built

- **Schema** (`backend/src/db/schema.ts`): new `suggested_edits` table —
  `id`, `opportunityId` (FK to `opportunities.id`, `onDelete: cascade`),
  `field`, `oldValue`, `newValue`, `submittedBy`, `status`
  (`SUGGESTED_EDIT_STATUSES = ["pending","approved","rejected"]`,
  same pattern as `OPPORTUNITY_STATUSES`/`REVIEW_STATUSES`), `createdAt`,
  `reviewedBy`, `reviewedAt`. Migration generated via
  `npx drizzle-kit generate` →
  `backend/src/db/migrations/0001_exotic_ozymandias.sql` (additive only,
  one `CREATE TABLE` + one FK constraint). **Not** run against any database
  — no reachable `DATABASE_URL` in this environment, and the task explicitly
  said not to.

- **Data access** (`backend/src/db/data-access.ts`): `SuggestedEditDTO` +
  `toSuggestedEditDTO()`; `SUGGESTABLE_FIELDS` = `["name","description","link","majors"]`
  (the single source of truth the public route imports rather than
  re-declaring); `insertSuggestedEdit()` (looks up the opportunity, 404s if
  not approved/public, reads the CURRENT field value server-side into
  `oldValue`, rejects `newValue === oldValue` as a no-op result rather than
  inserting a pointless row — returns a discriminated
  `{ok:true,...} | {ok:false,reason:"not_found"|"noop"}` so the route can
  turn each failure into the right status code); `getSuggestedEditsForAdmin()`
  (mirrors `getReviewsForAdmin`, joins in `opportunityName`);
  `approveSuggestedEdit()` (transaction: writes `newValue` onto the live
  opportunities row — `setMajors(JSON.parse(newValue))` for the `majors`
  field, a plain column write otherwise — stamps `updatedAt`, stamps the
  suggested_edits row `approved`/`reviewedBy`/`reviewedAt`, then runs
  `refreshSearchBlob()` after the transaction commits, same shape as
  `updateOpportunity()`); `rejectSuggestedEdit()` (mirrors `rejectReview()`
  — status stamp only, no live-row write).

- **Routes**: `POST /api/opportunities/:id/suggest-edit` (public,
  `backend/src/routes/public.ts`) validates `field` against
  `SUGGESTABLE_FIELDS` and `newValue` non-empty, 404s via the not-found
  result, 400s via the noop result, 201s with `{id, status:"pending"}`.
  `GET /api/admin/suggested-edits`, `POST /api/admin/suggested-edits/:id/approve`,
  `POST /api/admin/suggested-edits/:id/reject` (admin,
  `backend/src/routes/admin.ts`), all behind the existing `requireAdmin`
  middleware — no new auth surface.

- **Frontend**:
  - `frontend/public/app.js` / `style.css`: collapsible "Suggest an edit to
    this listing" link on the org detail view (`renderSuggestEditBlock`),
    expands into a field `<select>` (name/description/link/majors) + a
    textarea, posts to the new endpoint. Follows the same modal/form
    plumbing pattern already used for the review-write and flag-review
    forms (data-action delegation, per-field error div, disabled-button
    submitting state). `majors` is entered as a comma-separated list in the
    UI and JSON-serialized client-side before POSTing, matching how the
    field is stored server-side.
  - `frontend/public/admin.js` / `style.css`: new "Suggested Edits" tab
    alongside the existing Reviews / Reports tabs, listing pending
    suggestions with a field badge, opportunity name/id, and a simple
    strikethrough-old / highlighted-new inline diff (no real diff
    algorithm — these are short field values, not documents; `majors`
    values are parsed back into a comma list for readability). One-click
    Approve/Reject buttons wired to the new endpoints, same
    `admin-queue-item`/`admin-btn` styling as the other queues.

- **API-CONTRACT.md**: added the `SuggestedEditDTO` shape, the public
  `POST /api/opportunities/:id/suggest-edit` endpoint doc, and the three
  admin endpoint docs — all additive, following the existing per-endpoint
  template used for Reviews/Reports.

## Assumptions / judgment calls

- `oldValue`/`newValue` for the `majors` field are the raw JSON-serialized
  array string (matching the `opportunities.majors` column's own storage
  format) rather than a plain array — kept the public API and the admin
  diff display consistent with "matching how it's stored on the row" from
  the spec, at the cost of the raw API response being slightly less
  human-readable (the admin UI pretty-prints it back to a comma list).
- No-op detection compares the raw stored string, not a semantic/whitespace-
  normalized comparison — a suggestion that only changes whitespace/casing
  is treated as a real change and queued for review. Flagged as an
  intentional simplicity choice, not an oversight.
- `insertSuggestedEdit()` does its own opportunity lookup by directly
  querying `opportunities` (needed to read the raw pre-serialization column
  value for `oldValue`) rather than going through `getPublic()` like the
  reviews/reports routes do — `getPublic()` returns the already-decoded
  `OpportunityDTO` (majors as `string[]`), which would require
  re-serializing to get back the on-the-wire `oldValue` string. Still
  enforces the same "must be status = approved" gate `getPublic()` would.

## Deferred / TODO

- No rate limiting or duplicate-suggestion throttling on the public
  endpoint (matches the existing reviews/reports endpoints — same gap,
  not new to this feature).
- No email/notification to admins when a new suggestion lands; the admin
  panel is poll-on-load only, same as the other queues.
- `submittedBy` is never validated as a real GT email (matches the
  `opportunities.submittedBy` / review pattern elsewhere).

## Verification performed

- `cd backend && npx tsc --noEmit` — clean (had to `npm install` first;
  `node_modules` wasn't present in this worktree).
- `npx drizzle-kit generate` — produced a single additive migration
  (`CREATE TABLE suggested_edits` + one FK), no changes to existing tables.
  Not migrated against a live database.
- `node --check` on `frontend/public/app.js` and `admin.js` — both parse
  cleanly.
- No live end-to-end run — no reachable database in this environment to
  boot the backend against.

# Build notes — Org profile icon submission (admin-approved)

Date: 2026-07-19
Branch/worktree: `worktree-agent-ab495a61a330540b6`

Written as a separate file (rather than appending to `BUILD_NOTES.md`)
because this is one of four features being built concurrently by separate
agents in separate worktrees against the same repo — appending to the same
shared file would be a guaranteed merge conflict on rebase/merge morning.
Fold this into `BUILD_NOTES.md` at integration time.

## What was built

- **Schema** (`backend/src/db/schema.ts`): two new nullable `text` columns
  on `opportunities` — `iconUrl` (`icon_url`, live/public) and
  `iconPendingUrl` (`icon_pending_url`, submitted-but-unapproved,
  admin-only). Purely additive; no existing column touched. Migration
  generated via `npx drizzle-kit generate` →
  `backend/src/db/migrations/0001_rainy_gauntlet.sql`. **Not run** against
  any database (no reachable `DATABASE_URL` in this environment, and the
  task explicitly said not to migrate a live DB) — this needs `npm run
  migrate` (or Railway's build/deploy hook, whichever this repo uses) at
  integration time.

- **Data access** (`backend/src/db/data-access.ts`):
  - `OpportunityDTO` (the public shape, from `attachTags`) now includes
    `iconUrl`. It deliberately does **not** include `iconPendingUrl`.
  - New `AdminOpportunityDTO = OpportunityDTO & { iconPendingUrl }`, used
    only by `getByIdForAdmin()` (and therefore by `approveOpportunity`,
    `rejectOpportunity`, `updateOpportunity`, and the new icon mutation
    helpers below, all of which return through `getByIdForAdmin`).
  - `submitIconPending(opportunityId, url)` — public path, sets
    `iconPendingUrl` only, never touches `iconUrl`. Returns `false` if the
    opportunity row doesn't exist at all (route layer additionally checks
    the opportunity is *public*, i.e. approved, before calling this — see
    below — so pending/rejected rows can't be probed through this path).
  - `getPendingIcons()` — admin-only list of
    `{ id, name, iconUrl, iconPendingUrl }` where `iconPendingUrl IS NOT
    NULL`.
  - `approveIcon(id, reviewedBy)` — copies `iconPendingUrl` → `iconUrl`,
    clears `iconPendingUrl`, stamps `updatedAt`.
  - `rejectIcon(id, reviewedBy)` — clears `iconPendingUrl`, stamps
    `updatedAt`.
  - **Assumption**: `approveIcon`/`rejectIcon` accept a `reviewedBy` param
    (for parity with the other admin mutation helpers' signatures / call
    sites) but deliberately do **not** write it into the opportunity's own
    `reviewedBy`/`reviewedAt` columns — those track the opportunity
    approve/reject lifecycle, a separate concern from icon review, and
    overwriting them here would clobber that history with no audit trail
    of who actually reviewed the icon. If a full audit trail for icon
    review specifically is wanted later, that's a "add
    `iconReviewedBy`/`iconReviewedAt` columns" follow-up, not a reuse of
    the existing ones.

- **Routes**:
  - `POST /api/opportunities/:id/icon` (public, `backend/src/routes/public.ts`):
    accepts `{ url }`, validates `https://` + `.png|.jpg|.jpeg|.gif|.webp|.svg`
    extension + max 2048 chars, 404s if the opportunity isn't public
    (approved) — same "can't distinguish pending/rejected from doesn't-exist"
    convention as the rest of this file.
  - `GET /api/admin/icons/pending`, `POST
    /api/admin/opportunities/:id/icon/approve`, `POST
    /api/admin/opportunities/:id/icon/reject` (all admin-auth-gated,
    `backend/src/routes/admin.ts`), following the exact `{ result:
    Opportunity }` / `404 { error: "not_found" }` shape used by the
    existing approve/reject endpoints.
  - `API-CONTRACT.md` updated additively: `iconUrl` added to the
    `OpportunityDTO` example + prose note about `iconPendingUrl` being
    admin-only; new sections for all four new endpoints.

- **Frontend**:
  - `frontend/public/app.js`: new `renderOrgIcon(opp, sizeClass)` helper —
    renders an `<img>` against the type-color background when `iconUrl` is
    set, with an `onerror` handler that falls back to the existing
    colored-initials placeholder if the image 404s/fails to load;
    otherwise renders the placeholder directly (unchanged behavior). Used
    on both directory grid cards and the detail page header (list view
    still just uses its existing colored dot, not the icon — out of scope,
    it's a compact one-line row).
  - **Icon submission is scoped to the org detail page only**, not the
    "submit an opportunity" form — a brand-new submission has no id until
    an admin approves it, so there is nothing for
    `POST /api/opportunities/:id/icon` to attach to at submit time. This
    was called out as an acceptable scoping choice in the task itself
    rather than something to block on.
  - New `renderIconSubmitBlock()` + `#iconForm` on the detail view, wired
    through the existing `[data-action]`/`state`/`setState` render-loop
    pattern (mirrors the review-submission form's shape: local
    `state.iconSubmit` status object, POST on submit, inline
    success/error message).
  - `frontend/public/admin.js`: new "Pending Icons" tab alongside the
    existing Reviews / Reports tabs, following their exact visual/queue-item
    pattern (`admin-queue-item` cards, `admin-btn approve|reject`). Renders
    current vs. submitted icon as side-by-side `<img>` thumbnails (with a
    text fallback for "no icon" / broken image), wired to the two new admin
    endpoints. `loadQueues()` now fetches `/admin/icons/pending` alongside
    reviews/reports on login and after every action.
  - `frontend/public/style.css`: `.org-icon img` (image fills the existing
    colored placeholder box), `.icon-submit-block`/`.icon-submit-form`/
    `.icon-submit-status` (detail-page submission UI), `.icon-compare-row`/
    `.icon-compare-thumb`/`.icon-compare-arrow` (admin side-by-side
    thumbnails) — all built from the existing `--navy`/`--gold`/
    `--gray-matter`/`--pi-mile`/`--diploma` custom properties already in
    the file, no new palette introduced.

## Skipped / deferred (left as TODOs)

- **No fetch-and-verify of submitted icon URLs.** The public submission
  endpoint only does a format check (regex: `https://`, known image
  extension, length cap) before the URL reaches the admin pending queue —
  it does not actually fetch the URL server-side to confirm it's a real
  image, check its content-type, or check its size. Deliberately **not**
  implemented here: having the server fetch an arbitrary user-supplied URL
  is an SSRF vector (could be used to probe internal network addresses,
  cloud metadata endpoints, etc.) and doing it safely needs a real design
  pass (allowlisting resolved IPs, timeouts, redirect handling, egress
  restrictions) rather than a quick add. TODO comment left in
  `backend/src/routes/public.ts` at the validation block. A human admin
  visually reviewing the thumbnail in the Pending Icons queue before
  approving is the current safety net.
- **No real file upload / object storage.** Per the task, this app has no
  S3/R2/etc configured, so icon "submission" is a URL field, not a file
  picker. Out of scope to add storage infra here.
- **No env vars added.** This feature needs none — no `.env.example`
  changes.

## Verification performed

- `cd backend && npx tsc --noEmit` — clean (ran `npm install` first since
  `node_modules` wasn't present in this fresh worktree).
- `npx drizzle-kit generate` — produced a clean, additive
  `ALTER TABLE ... ADD COLUMN` migration (no drops/renames); migration was
  **not** run against any database.
- Frontend JS syntax-checked with `node -e "new Function(...)"` against
  both `app.js` and `admin.js` (no build step in this project to run a
  bundler/linter against).
- No existing test suite found to run (`backend/package.json` has no
  `test` script) — relied on tsc + the same manual code-path reasoning the
  rest of this file's routes use (mirrored the review/report
  submit-then-admin-approve flow exactly).

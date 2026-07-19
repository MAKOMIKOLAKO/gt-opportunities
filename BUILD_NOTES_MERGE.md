# Build notes — Merge of file storage, embeddings CI, and four feature worktrees (2026-07-19)

Orchestrated merge of a prior batch's four independent feature worktrees
(icon submission, extra links, related orgs, suggest-edits — none merged
with each other or with `main`) plus two new pieces of work (R2 file
storage, an embeddings GitHub Action). Done on a local `integration` branch
off `main`; nothing pushed to a remote, no live database touched.

## Merge order used

1. `worktree-agent-ab495a61a330540b6` (icon submission) → `integration`.
   Clean merge, no conflicts.
2. `worktree-agent-aa39483e70d00b50b` (extra links) → `integration`.
   Conflicts in `schema.ts` migration meta, `admin.ts`, `public.ts`,
   `admin.js`, `app.js` (see below).
3. `worktree-agent-afb7a6fe4d79e1e2c` (related orgs) → `integration`.
   Conflicts in `schema.ts`, `data-access.ts`, migration meta,
   `public.ts`, `app.js`.
4. `worktree-agent-acb494583080bd141` (suggest-edits) → `integration`.
   Conflicts in `API-CONTRACT.md`, `data-access.ts`, migration meta,
   `admin.ts`, `public.ts`, `admin.js`, `app.js`, `style.css`.
5. **Task A (R2 file storage)** built directly on `integration` (not a
   separate pre-merge branch) — it modifies the icon submission feature's
   route directly, so building it after step 1's merge avoided doing the
   same conflict resolution twice.
6. **Task B (embeddings GitHub Action)** built directly on `integration` —
   wires up `backend/src/db/backfill-embeddings.ts`, which only exists after
   step 3's merge.
7. `integration` → `main` (this step).

Steps 5–6 depended on code from steps 1 and 3 respectively, so doing the
storage/CI work as commits on the already-merged `integration` branch (per
the orchestrator brief's explicit "or merged in as their own commits
alongside the rest" option) was more direct than building them in isolation
first and re-resolving the same conflicts a second time.

`cd backend && npx tsc --noEmit` and `node --check` on both frontend JS
files were run after every merge step; `npx drizzle-kit generate` was run
after every schema-touching merge to confirm the schema and migrations
directory stayed in sync (see below).

## Conflicts encountered and how they were resolved

Every conflict across all three feature-merges followed the same shape:
**two features touched the same file in genuinely non-overlapping,
additive ways** (each added its own functions/routes/tables/UI tabs) — no
conflict involved two features actually disagreeing about the same
column, route, or behavior. Resolution was almost entirely "keep both
sides, in file order," with three mechanical exceptions:

- **`schema.ts`**: auto-merged cleanly at every step (Git's merge itself
  handled it — each feature only ever appended a new `pgTable`/enum near
  the bottom of the file). Verified after each merge that no two features
  redefined the same table/column name — none did; every addition was a
  brand-new table (`links`, `related_opportunities`, `suggested_edits`) or
  brand-new nullable columns on `opportunities` (`iconUrl`,
  `iconPendingUrl`, `embedding`).
- **`backend/src/db/data-access.ts`, `admin.ts`, `public.ts`, `admin.js`**:
  conflicts were import-list and function-list interleaving from Git's
  3-way diff, not real disagreements — resolved by keeping every symbol
  from both sides. No function/route names collided across features (each
  worktree had already picked distinct names — `approveLink`/`rejectLink`
  vs `approveIcon`/`rejectIcon` vs `approveSuggestedEdit`/
  `rejectSuggestedEdit`, `/admin/links/*` vs `/admin/icons/*` vs
  `/admin/suggested-edits/*`), so **no renaming was needed**.
- **`frontend/public/app.js` / `admin.js`**: same pattern — each feature
  added its own render function and its own admin queue tab
  (Links/Icons/Suggested Edits, alongside the pre-existing Reviews/Reports
  tabs). `admin.js` was rewritten as a clean whole file at each conflicting
  step (rather than resolved marker-by-marker) once it became clear the
  conflicts were dense/interleaved enough that a clean rewrite was faster
  and less error-prone than hand-splicing five tabs' worth of interleaved
  hunks. One judgment call: `renderRelatedOrgCard()` (from the related-orgs
  feature) originally rendered a plain colored-initials icon; upgraded it
  to call the icon feature's `renderOrgIcon()` helper instead, so related-org
  cards show a real icon when one is approved, consistent with the
  directory grid and detail-page header. This wasn't a conflict — it's a
  one-line consistency fix made while both features' code was in view
  during the same merge.

### Migration files — the one place hand-editing was needed

Each worktree independently ran `drizzle-kit generate` against the *same*
`0000` baseline, so all four produced a migration numbered `0001_*.sql` with
different tags, plus conflicting `meta/_journal.json` /
`meta/0001_snapshot.json` files. Git can't 3-way-merge those meaningfully
(they're generated, position-dependent state). Resolution, repeated at each
merge step:

1. Resolve `schema.ts` first (always clean/additive, see above).
2. Keep "ours" journal/snapshot (`git checkout --ours`), delete the
   incoming worktree's own `0001_*.sql` migration file entirely.
3. Re-run `npx drizzle-kit generate` — since the *schema* diff from both
   sides was already merged in step 1, this regenerates one clean
   migration capturing exactly the newly-added tables/columns, correctly
   numbered next in sequence.
4. For the related-orgs migration specifically, `drizzle-kit generate`
   doesn't know about the `CREATE EXTENSION IF NOT EXISTS vector;`
   statement the original worktree had added by hand (drizzle has no
   concept of Postgres extensions) — re-added that line by hand at the top
   of the regenerated migration, exactly as the original worktree's build
   notes described doing.

Final migration sequence: `0000_luxuriant_spitfire` (base) →
`0001_rainy_gauntlet` (icon columns) → `0002_volatile_lady_bullseye`
(links table + related_opportunities table + embedding column, generated
fresh to capture both merged features at once) → `0003_little_power_pack`
(suggested_edits table). Verified with a final `npx drizzle-kit generate`
after all merges: **"No schema changes, nothing to migrate"** — schema.ts
and the migrations directory are fully in sync.

None of these migrations were run against any database (no reachable
`DATABASE_URL` in this environment, and out of scope per the task —
local/CI-config work only).

## Renamed functions/routes

**None.** Every feature's function and route names were already distinct
before merging (see above) — no collisions to rename around.

## Task A / Task B summary (full detail in their own BUILD_NOTES files)

- **`BUILD_NOTES_FILE_STORAGE.md`**: replaced the icon feature's URL-only
  submission with a real Cloudflare R2 upload (`POST
  /api/opportunities/:id/icon` now accepts `multipart/form-data`, validates
  MIME type + size server-side against the actual bytes, uploads via the
  AWS SDK v3 S3 client pointed at R2's endpoint). New file:
  `backend/src/lib/storage.ts`.
- **`BUILD_NOTES_EMBEDDINGS_ACTION.md`**: wired the existing
  `backfill:embeddings` script into `.github/workflows/embeddings-backfill.yml`
  (manual `workflow_dispatch` + nightly cron, `concurrency:
  cancel-in-progress: false` guard, summary logged to both stdout and
  `GITHUB_STEP_SUMMARY`). Extended the script itself with a `failed` counter
  and non-zero exit on failure (previously only tracked embedded/skipped).

## Remaining TODOs

- **Secrets that must be set before Task A/B are live** (none of these exist
  in this environment or are committed anywhere):
  - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
    `R2_BUCKET_NAME`, `R2_PUBLIC_URL` — Vercel/Railway env vars (see
    `.env.example` for setup steps). Without these, icon upload fails with a
    clear "R2 is not configured" error rather than silently no-opping.
  - `DATABASE_URL`, `OPENAI_API_KEY` — GitHub Actions repo secrets (Settings
    -> Secrets and variables -> Actions), required for
    `embeddings-backfill.yml` to do anything real. `DATABASE_URL` is also
    already required by the two pre-existing workflows
    (`vip-scraper.yml`, `backfill-search.yml`) if not already set.
- None of the four feature migrations (`0001`–`0003`) have been run against
  any database — `npm run migrate` (or the Vercel build hook, which already
  runs it per `vercel.json`'s `buildCommand`) needs to execute against a real
  `DATABASE_URL` before any of this code path works end-to-end.
- The existing SSRF TODO from the original icon feature build notes is now
  moot (removed along with the URL-only submission path it applied to) — no
  action needed there, noted here only so it isn't mistaken for a dangling
  TODO still to address.
- No live upload/embedding run was exercised in this environment (no
  reachable database or R2/OpenAI credentials) — first real verification of
  both Task A and Task B will happen at actual deploy time.

## Verification performed

- `cd backend && npx tsc --noEmit` — clean after every merge/build step and
  at the end.
- `node --check frontend/public/app.js` / `admin.js` — clean after every
  merge/build step and at the end.
- `npx drizzle-kit generate` — "No schema changes, nothing to migrate" as
  the final check, confirming schema.ts and the migrations directory agree.
- Grepped the full `backend/src` and `frontend/public` trees for leftover
  `<<<<<<<`/`=======`/`>>>>>>>` conflict markers after every merge — none
  remained before committing.
- `git merge integration` into `main` performed as a single fast-forward or
  merge commit (see the commit this file ships alongside) — not pushed to
  any remote.

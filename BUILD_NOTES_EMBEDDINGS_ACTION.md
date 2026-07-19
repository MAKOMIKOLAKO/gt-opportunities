# Build notes — Embeddings backfill as a GitHub Action (2026-07-19)

Built directly on top of the merged related-orgs feature (see
`BUILD_NOTES_RELATED_ORGS_FEATURE.md`) on the `integration` branch, which
already shipped `backend/src/db/backfill-embeddings.ts` and the
`backfill:embeddings` npm script. This wires that existing script into CI.

## What was built

- **`.github/workflows/embeddings-backfill.yml`** (new), following the same
  shape as the existing `vip-scraper.yml`/`backfill-search.yml` workflows in
  this repo:
  - `workflow_dispatch: {}` for ad-hoc full backfills.
  - `schedule: cron: "17 9 * * *"` for a nightly run (arbitrary off-peak
    minute, same "not tied to anything dynamic" spirit as `vip-scraper.yml`'s
    semester-start cron comments).
  - `concurrency: { group: embeddings-backfill, cancel-in-progress: false }`
    — a manual run and the nightly cron landing close together queue instead
    of one cancelling the other. Safe either way: the backfill is a
    read-then-write per row with no shared mutable state across rows, so an
    overlapping run is at worst redundant, never corrupting.
  - Secrets: `DATABASE_URL` and `OPENAI_API_KEY`, both pulled from GitHub
    Actions repo secrets (Settings -> Secrets and variables -> Actions) — no
    credentials hardcoded in the workflow file. **These two secret names
    must exist in the repo before this workflow can do anything real**; if
    `OPENAI_API_KEY` is unset the script still runs and exits cleanly (0
    embedded, matching `backfill-embeddings.ts`'s existing "inert without a
    key" behavior — see `BUILD_NOTES_RELATED_ORGS_FEATURE.md`), it just
    won't embed anything.
- **`backend/src/db/backfill-embeddings.ts`** (extended, not rewritten):
  - Already incremental — the query is `WHERE embedding IS NULL`, so
    already-embedded rows are never recomputed. No change needed there; this
    is why a single "nightly full pass" is cheap even at scale, since it's
    really a "nightly top-up of whatever's still null" pass. Rows edited
    through the app (admin approve/edit, scrapers) are re-embedded inline at
    write time already (`reembedAndRecompute()` in `data-access.ts`), so
    this workflow's job is specifically to catch rows that landed WITHOUT
    going through that path — most commonly the very first backfill against
    pre-existing data, or a row whose inline embed call silently failed.
  - Added a `failed` counter (previously only `embedded`/`skipped` existed;
    a hard exception per-row was uncaught and would have killed the whole
    script's loop on one bad row) — each row's embed+recompute is now wrapped
    in try/catch, logs `[failed] <id>: <name> — <error>`, and continues to
    the next row rather than aborting the batch.
  - The script now exits with a non-zero code if `failed > 0`, so a CI run
    with real failures shows as a failed GitHub Actions run (not a silent
    green checkmark) while still completing every row it could.
  - Summary line (`embedded=X skipped=Y failed=Z total=N`) is unchanged in
    shape, just now includes `failed`. Additionally, when running under
    GitHub Actions (`GITHUB_STEP_SUMMARY` env var present — GitHub sets this
    automatically, nothing configured in the workflow itself), the same
    counts are also appended to the job's Summary tab as markdown, so the
    result is visible without opening the raw log.

## Secrets that need to be set before this is live

`DATABASE_URL` and `OPENAI_API_KEY` in the repo's Actions secrets (Settings
-> Secrets and variables -> Actions) — same two names used by the other
workflows in `.github/workflows/` for `DATABASE_URL`, plus the new
`OPENAI_API_KEY` this workflow additionally needs.

## Deferred / not attempted

- No Slack/email notification on failure — none of the other workflows in
  this repo have that either; out of scope here.
- No dedicated "changed since last embed" comparison against an `updatedAt`
  timestamp. Not needed: every write path that changes embeddable fields
  (`approveOpportunity`, `updateOpportunity`) already calls
  `reembedAndRecompute()` inline, which re-embeds unconditionally on every
  such write — an edited row's embedding is never stale by the time this
  workflow would run. The `WHERE embedding IS NULL` filter alone is
  therefore sufficient to catch the actual gap (rows that never got an
  inline embed at all).

## Verification performed

- `cd backend && npx tsc --noEmit` — clean.
- Workflow YAML not run in CI here (this task is local/CI-config work only,
  per the orchestrator instructions — no push to a remote). Structure was
  checked by hand against the three existing workflows in
  `.github/workflows/` for consistency (trigger shape, `actions/checkout@v4`
  + `actions/setup-node@v4` + `npm ci` + `npm run <script> --workspace
  backend` pattern, secrets passed via `env:`).

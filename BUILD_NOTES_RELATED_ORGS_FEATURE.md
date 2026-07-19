# Build notes — Related organizations feature (2026-07-19)

Built in its own worktree (`worktree-agent-afb7a6fe4d79e1e2c`) as one of four
parallel overnight features; kept in a separate notes file rather than
appending to `BUILD_NOTES.md` to avoid a merge conflict with other agents
editing that file in their own worktrees tonight.

## What was built

- **Schema** (`backend/src/db/schema.ts`): a `vector1536` `customType`
  (copies the existing `tsvector` customType pattern exactly) backing a new
  nullable `opportunities.embedding` column, and a new `relatedOpportunities`
  ("related_opportunities") table — `opportunityId` / `relatedOpportunityId`
  (both FK → opportunities, cascade delete), `score` (real), `rank`
  (integer, 1-based), `computedAt` (timestamp, default now), composite PK on
  `(opportunityId, relatedOpportunityId)`.
- **Migration** (`backend/src/db/migrations/0001_certain_vindicator.sql`):
  `npx drizzle-kit generate` actually handled the custom vector type fine
  (diffed it as a plain `vector(1536)` column) — no hand-writing needed for
  the table/column DDL. The one thing `generate` can't know about is the
  extension itself, so `CREATE EXTENSION IF NOT EXISTS vector;` was added by
  hand as the first statement in the generated file (idempotent, safe to
  re-run). No ANN index yet — see "Deferred" below. **Not run against any
  database** — no reachable `DATABASE_URL` in this environment, per
  instructions.
- **`backend/src/lib/embeddings.ts`** (new): `embedText()` (calls OpenAI
  `POST /v1/embeddings`, model `text-embedding-3-small`, via plain `fetch`;
  returns `null` and logs one warning if `OPENAI_API_KEY` is unset or the
  request fails — never throws), `buildEmbeddingInput()`, and
  `embedOpportunity(id)` (loads the row + tags, builds input text, embeds,
  and — if non-null — `UPDATE`s `opportunities.embedding` via a raw
  pgvector literal `[0.1,0.2,...]::vector`).
- **`backend/src/lib/related-opportunities.ts`** (new): `recomputeRelated(id)`
  — no-ops if the target has no embedding yet; otherwise pulls the 20
  nearest approved-and-embedded candidates by cosine distance (`<=>`, raw
  `sql`), adds a small tag-overlap boost (`+0.05` per overlapping tag,
  capped at 5 tags = +0.25 max) on top of `1 - cosine_distance`, takes the
  top 6, and fully replaces that opportunity's rows in
  `related_opportunities` (delete + re-insert with rank 1..6) inside a
  transaction. **`type` (vip/lab/club) is never read or referenced anywhere
  in the scoring path** — verified by grep — so cross-category matches (a
  VIP robotics team surfacing an Engage robotics club with zero shared tags)
  are structurally possible, not just theoretically allowed.
- **Wiring**: `embedOpportunity()` + `recomputeRelated()` are called (await,
  wrapped in try/catch so a failure never blocks the caller) at the end of
  `vip.ts`'s per-team upsert, `engage-classify.ts`'s per-org upsert, and
  from a new shared `reembedAndRecompute()` helper in `data-access.ts`
  called from both `approveOpportunity()` and `updateOpportunity()` (on
  every edit, not just when `approve=true` — an edit to an already-approved
  row still refreshes its related-orgs cache).
- **Read path**: `getRelatedOpportunities(opportunityId)` in
  `data-access.ts` — joins `related_opportunities` → `opportunities`,
  filters to `status = 'approved'` only (same discipline as `getPublic()`,
  important because a cached related row can point at something that's
  since been unpublished), ordered by `rank`, returns `OpportunityDTO[]`
  (raw `embedding` never serialized into any DTO). Wired into
  `GET /api/opportunities/:id` in `public.ts` as a new `relatedOrgs` field.
  `API-CONTRACT.md` updated additively to document it.
- **Frontend** (`frontend/public/app.js` / `style.css`): a "Related
  organizations" section appended after the reviews block on the detail
  view, rendering `relatedOrgs` as horizontally-scrollable cards that reuse
  the existing `.org-card` markup/rendering shape from the directory grid
  (`renderRelatedOrgCard()` mirrors the grid card's structure so it inherits
  the same navy/gold styling for free) inside a new
  `.related-orgs-scroller` flex row. Hidden entirely (returns `""`, no
  empty-state UI) when `relatedOrgs` is empty — which is the common case
  right now, see below.
- **Backfill script** (`backend/src/db/backfill-embeddings.ts`, new,
  `npm run backfill:embeddings` from `backend/`): loops every opportunity
  with a null `embedding`, embeds + recomputes related-orgs for each. Safe
  to re-run (already-embedded rows are skipped via `WHERE embedding IS
  NULL`). Reports `0 embedded` cleanly (not an error) if `OPENAI_API_KEY`
  is still unset when it's run.
- `.env.example` documents `OPENAI_API_KEY` (doc only, no real value).

## Explicitly deferred / TODO

- **ANN index**: no IVFFlat/HNSW index on `opportunities.embedding` yet —
  plain column, brute-force `<=>` scan in `recomputeRelated()`. At current
  scale (~112 VIP + ~600 Engage ≈ 700 rows) this is fine; add
  `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` (or ivfflat)
  in a follow-up migration once row counts grow enough to matter — not
  attempted here per the task's explicit "don't over-engineer this."
- Nothing else deferred functionally — the pipeline (ingest → embed →
  recompute → serve → render) is wired end-to-end for all three ingestion
  paths (VIP scrape, Engage classify, admin approve/edit).

## Key assumption / current state: inert without a live key

**Live embeddings require `OPENAI_API_KEY` to be set — it is NOT configured
in this environment.** Until it is:

- `embedText()` logs one warning per process and returns `null`.
- `opportunities.embedding` stays `NULL` for every row (new and existing).
- `recomputeRelated()` no-ops (logs and returns) for every call, since it
  requires a non-null target embedding.
- `GET /api/opportunities/:id` always returns `relatedOrgs: []`.
- The frontend's "Related organizations" section never renders (by design —
  empty array = section hidden, not an empty slider).

None of this throws or breaks any other part of the app — the whole feature
is designed to degrade to "present but empty" rather than fail. The moment
a real `OPENAI_API_KEY` is set (Vercel dashboard / GitHub secrets / local
`.env`, per `.env.example`'s existing conventions) and either a scraper
re-runs, an admin edits/approves a row, or someone runs
`npm run backfill:embeddings` once against existing data, the feature comes
alive with no further code changes.

## Typecheck

`cd backend && npx tsc --noEmit` passes clean as of this commit (verified
after `npm install` at the repo root — this worktree had no `node_modules`
checked in, consistent with every other worktree in this batch).

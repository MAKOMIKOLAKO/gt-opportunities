# Build Notes

Notes from adding the reviews feature (Addition 3) that need human
attention or future reconciliation. Not a full changelog — see git log /
API-CONTRACT.md for that.

## `reports` table duplicates in-progress work on another worktree

`worktree-reports-and-vip-search` (not merged as of this writing) is
independently prototyping a `reports` table for a general opportunity-report
flow. The review-dispute requirement in Addition 3 needed a reports
mechanism wired *now*, so this branch creates its own `reports` table in
`backend/src/db/schema.ts`, matching that branch's prototyped shape as
closely as possible:

```ts
export const REPORT_CATEGORIES = ["outdated_info", "broken_link", "wrong_contact", "other"] as const;
export const REPORT_STATUSES = ["open", "resolved"] as const;
export const reports = sqliteTable("reports", { ... });
```

Two deltas from the other branch's shape, both required for the
review-dispute flow:
- `reviewId` (nullable text, FK -> `reviews.id`) — lets a report target a
  specific review instead of/alongside an opportunity.
- `opportunityId` is nullable here (rather than `.notNull()`) so a report
  can be purely about a review; when a report *is* about a review, this
  branch still populates `opportunityId` from the review for context.

**When `worktree-reports-and-vip-search` merges, these two schema
definitions will collide** (two migrations creating a `reports` table).
Reconciliation needed:
1. Diff the two `reports` table definitions and pick one canonical shape
   (this branch's superset — with `reviewId` — is probably the right base).
2. Merge `insertReport`/`getReportsForAdmin`/`resolveReport` in
   `backend/src/db/data-access.ts` with whatever that branch built for
   general opportunity reporting (broken links, outdated info, etc.) —
   avoid ending up with two parallel "reports" concepts.
3. Squash the two migrations that both `CREATE TABLE reports` into one.

Per instructions, the other worktree was left untouched — this note is the
handoff.

## No rating field on reviews — this is permanent, not deferred

The spec explicitly excludes a numeric rating field: a score invites direct
comparison between labs/PIs, and a single bad semester could unfairly
dominate it. Reviews are three structured short-answer prompts only
(time commitment / before applying / advice for a new member). **Do not
add a rating field as a follow-on "easy win" without explicit human
sign-off** — if this idea comes up again, it needs a real product decision,
not an engineering shortcut.

## No auto-approval for reviews — logged for a human decision, not implemented

Two auto-approval mechanisms were explicitly *not* built, per spec:
- Keyword/profanity screening on review text.
- An LLM-based auto-approve step (e.g. asking a model to judge whether a
  review reads as "about the experience" vs. "an accusation about a named
  individual" and auto-approving/rejecting on that basis).

Both are plausible ways to reduce moderation burden as review volume grows,
but both also carry real risk of getting hard moderation calls wrong
without a human in the loop, especially the "named individual" distinction,
which is exactly the kind of judgment call that's hard to encode reliably.
This is deliberately left as **pending admin review only**, with the
moderation guidance text surfaced in the admin UI (`GET /api/admin/reviews`
`guidance` field, rendered in `frontend/public/admin.js`). If someone wants
to revisit auto-approval, it needs an explicit decision from a human owner
first — not a follow-on PR.

## Acceptance checks — all four passed

Verified manually against a running instance (see commit history / PR
description for the exact commands):

1. **No reviewer-identifying data stored anywhere.** Confirmed via direct
   sqlite inspection of the `reviews` row after submission — the table has
   no name/email/IP/user-agent column at all, and nothing in
   `backend/src/routes/public.ts` reads or logs request IP/UA for the
   review endpoints.
2. **Admin queue lists pending reviews linked to their opportunity.**
   `GET /api/admin/reviews?status=pending` joins through to
   `opportunities.name`, returning `opportunityId` + `opportunityName` on
   every row (`getReviewsForAdmin()` in `backend/src/db/data-access.ts`).
3. **Approve -> visible on detail; reject -> stays out of public view.**
   Verified via the actual `getPublic()`/`getApprovedReviews()` read path
   (not by eyeballing): a rejected review's id does not appear in
   `GET /api/opportunities/:id`'s `reviews` array; an approved one does.
4. **Flagging a published review creates a linked, visible admin entry.**
   `POST /api/reviews/:id/report` (review must currently be approved, via
   `getApprovedReviewById()`) creates a `reports` row with `reviewId` set
   and `opportunityId` carried through for context; it shows up in
   `GET /api/admin/reports?status=open`.

No partial/broken paths were shipped — everything above was exercised
end-to-end against a real sqlite db before this note was written.

## Frontend admin panel is net-new

There was no admin frontend anywhere in the repo before this change (only
the backend `/api/admin/*` routes existed, unused by any UI). This branch
adds a minimal `frontend/public/admin.html` + `admin.js`: login form, a
pending-reviews queue with the moderation guidance surfaced inline, and a
reports/disputes queue. It intentionally does **not** build UI for the
existing opportunity-approval queue (`GET/POST /api/admin/opportunities/*`)
— that's a working API with no consumer, but building its UI wasn't in
scope for the reviews addition and would have been scope creep.

## Addition 5: Railway deployment — kept SQLite instead of migrating to Postgres

**Human decision needed.** The instructions for this addition asked for "a
managed Postgres instance." I did not do that migration and instead wired
Railway around the existing SQLite setup (a persistent Volume for
`backend/data/`). Flagging this explicitly rather than guessing further,
per the addition's own instructions.

Why: `backend/src/db/schema.ts` was written to be *mechanically* portable
to Postgres (no SQLite-only column types, JSON stored as TEXT behind typed
accessors in `json-columns.ts`), but the full-text search layer is not
mechanical. `opportunities_fts` is a SQLite FTS5 virtual table with three
hand-written triggers (`opportunities_ai/ad/au` in
`backend/src/db/migrate.ts`) keeping it in sync, and
`data-access.ts`'s `searchMatchingIds()` issues a raw `MATCH` query against
it. A Postgres port means: replacing FTS5 with `tsvector` + a GIN index,
rewriting the sync triggers (or moving sync into application code),
rewriting the `MATCH` query as `@@ to_tsquery(...)` with different ranking/
prefix-match semantics, switching `drizzle.config.ts` + `client.ts` to the
`pg` driver, and regenerating every migration file from scratch. That's a
data-layer rewrite with real correctness risk to a feature (search) with
existing passing behavior — not a config change, and out of scope for a
"low effort" deployment task.

What's shipped instead: `DB_PATH` (already an env var both `client.ts` and
`drizzle.config.ts` read) is documented in `.env.example` to point at a
Railway Volume mount (e.g. `/data/db.sqlite`), so the SQLite file persists
across redeploys/restarts exactly like a managed DB would from the app's
perspective. Migrations still run automatically on every deploy
(`railway.json`'s `startCommand` runs `npm run migrate --workspace backend`
before starting the server; `migrate.ts` is already idempotent — see its
own comments).

If a human wants the real Postgres move: budget it as its own task, not a
follow-on to this one. The schema/data-access split was deliberately built
to make that task mechanical everywhere *except* search.

## Addition 5: admin auth moved to env vars

`backend/src/lib/auth.ts` previously generated `ADMIN_USERNAME` (hardcoded
`"admin"`), `ADMIN_PASSWORD`, and the session-signing secret at random on
every process start — fine for local dev (a fresh password each run,
written to gitignored `RUN-STATUS.md`), useless in production (every
Railway restart/redeploy would silently invalidate all admin sessions and
rotate the password out from under anyone who'd saved it). Now reads
`ADMIN_USERNAME` / `ADMIN_PASSWORD` / `JWT_SECRET` from the environment
first, falling back to the old random-generation behavior only when unset
(so local `npm run dev` is unchanged). `index.ts` also stops writing
`RUN-STATUS.md` and printing the password to stdout when
`NODE_ENV=production`, since Railway logs aren't a safe place to leave a
production credential sitting around indefinitely.

Confirmed via git history search (`git log --all -S`, `git log --all -p --
'*.env'`) that no `.env` file, `*.sqlite` file, or hardcoded admin password
has ever been committed — the previous random-per-process-start design
meant there was never a static credential to leak. Nothing needs rotating.

## 2026-07-18: Restructure for Vercel-only hosting (Postgres/Neon, /api functions)

This closes out the gap flagged in "Addition 5: Railway deployment — kept
SQLite instead of migrating to Postgres" below, plus removes Railway
entirely in favor of a single Vercel project (frontend static output +
`/api` serverless functions, no second host).

**Express -> `/api` serverless functions.** `backend/src/index.ts` (the
Express bootstrap) is deleted. Every route from
`backend/src/routes/{public,submit,admin}.ts` is now a standalone file
under `/api` (Vercel's plain `/api` directory convention — see
`API-CONTRACT.md` for the route list, each `/api/**/*.ts` file's header
comment names the Express route it replaces). `backend/` is no longer a
standalone app; it's shared lib code (`backend/src/db/`, `backend/src/lib/`)
imported by both `/api/**` and the standalone scraper scripts, which is
exactly the "repurpose backend/ as shared lib" option the restructure task
called out. `backend/src/lib/auth.ts`'s `requireAdmin` was reworked from an
Express middleware `(req, res, next)` into a plain function taking the raw
`Authorization` header value and returning the verified payload or `null`
— framework-agnostic, callable from any handler shape. Vercel's Node.js
runtime auto-parses `req.body` for JSON content types and merges dynamic
route segments (`[id].ts`) into `req.query`, so no body-parsing or
param-parsing middleware was needed to replace `express.json()`.

**SQLite -> Postgres (Neon).** This is the piece the earlier note explicitly
punted on because of the FTS5 full-text search layer. What actually
happened:
- `backend/src/db/schema.ts` ported from `sqlite-core` to `pg-core`.
  `majors`/`meta`/`details` (previously TEXT-serialized JSON) are now native
  `jsonb`; `json-columns.ts`'s accessors — which were deliberately the one
  file that would need to change — now just normalize already-parsed jsonb
  values instead of JSON.parse/stringify-ing TEXT. Timestamps use Postgres
  `timestamp` columns in `{ mode: "string" }` so every DTO (still typed as
  plain `string` throughout the codebase) needed zero changes.
- Full-text search dropped the FTS5 virtual table + sync triggers entirely.
  `search_blob` (the precomputed searchable-text column, unchanged in
  purpose) is now queried directly at query time via
  `to_tsvector('english', search_blob) @@ plainto_tsquery('english', $1)`,
  backed by a GIN expression index defined in `schema.ts` itself (so
  `drizzle-kit generate` tracks it like any other index, rather than being a
  hand-written trigger in the migration runner). This is simpler than
  replicating FTS5's virtual-table+trigger machinery and was the right
  tradeoff given the existing `search_blob` column was already the
  single source of truth for indexed text — no ranking/prefix-match
  semantics from the old MATCH query were relied on anywhere in
  `API-CONTRACT.md`, so nothing observable changed.
- Driver choice: `pg` (node-postgres) via `drizzle-orm/node-postgres`, not
  `@neondatabase/serverless` + `drizzle-orm/neon-http`. Reason:
  `updateOpportunity()` (the admin edit-then-approve flow) needs a real
  interactive `db.transaction()`, which the neon-http HTTP driver does not
  support (only neon-http's own non-interactive "batch" mode, or the
  websocket-based `neon-serverless` driver would work). `pg` speaks
  standard Postgres wire protocol, which Neon's **pooled** connection string
  supports directly and works fine from Vercel's Node.js (non-Edge)
  serverless runtime — see `.env.example` for why pooled (not direct)
  matters here (connection-limit exhaustion under many concurrent
  short-lived functions).
- Every function in `data-access.ts` is now `async` (node-postgres/drizzle
  has no `.all()`/`.run()`/`.get()` — those were better-sqlite3-specific
  synchronous APIs). All call sites (the `/api/**` handlers, the two
  scrapers that touch the DB) were updated to `await` accordingly.
- Migrations regenerated from scratch for the `postgresql` dialect
  (`backend/drizzle.config.ts`); the old SQLite migration files were
  deleted rather than kept as dead history, since a fresh Postgres DB has no
  need to replay a SQLite-dialect migration path.
- Migration runner (`backend/src/db/migrate.ts`) is wired into
  `npm run build` at the repo root, which is `vercel.json`'s
  `buildCommand` — so migrations apply automatically on every Vercel
  deploy, before the `/api` functions are packaged. Same idempotency
  guarantee as before (drizzle's own migration-tracking table), just
  without the FTS5 trigger-drop/rebuild dance the old runner needed (there
  are no triggers anymore).

**Railway removed.** Both `railway.json` files (root + `frontend/`) are
deleted. `DEPLOY.md` is rewritten for the Vercel+Neon flow end to end.
`frontend/server.js` (the Express static-file+proxy server) is kept only as
an explicitly-labeled local-dev convenience — it has no role in the
deployed app, since Vercel serves `frontend/public` as static output
directly and routes `/api/*` to the functions itself.

**Not done, out of scope per the restructure task:** no scheduling/cron was
added for the scrapers (still manual `tsx`-invoked scripts, per instruction);
no Next.js conversion was needed or attempted — the plain `/api` convention
covered every route in `API-CONTRACT.md` without hitting a wall, so the
escape hatch in the restructure task's instructions was not exercised.

**Verified statically only** (no live Neon database or real Vercel deploy
available in this environment): `drizzle-kit generate` ran successfully
against the new pg schema (confirms the schema compiles and the migration
SQL is well-formed); TypeScript typechecking across `backend/src` and
`/api` (see the `typecheck` script). **Not verified**: an actual migration
run against a live Postgres instance, the scrapers' Postgres writes, or a
real `vercel dev`/deploy. Whoever picks this up for a real deploy should run
`npm run migrate` against a throwaway Neon branch first and sanity-check the
result before pointing it at anything real.

## Addition 5: two Railway services, not one

The repo is an npm-workspaces monorepo (`backend/`, `frontend/`) with two
separate long-running servers (API on `PORT`, and a static-file + `/api`
reverse-proxy server in `frontend/server.js` that talks to the API over
`BACKEND_URL`). Railway doesn't run two processes from one service cleanly,
so this needs **two Railway services from the same repo**, each with a
different dashboard "Root Directory" setting pointing at its own
`railway.json` (root `railway.json` for the backend service at repo root;
`frontend/railway.json` for the frontend service at `frontend/`). That
per-service Root Directory assignment is a dashboard click a human has to
do — see `DEPLOY.md`. Also had to add `express` as an explicit dependency
in `frontend/package.json` (it was previously relying on hoisting from the
root workspace install, which breaks the moment `frontend/` is installed
standalone as its own service root) and move `tsx` from `backend/`'s
devDependencies to dependencies (it's the production start command, not
just a dev tool — Nixpacks installs can skip devDependencies).

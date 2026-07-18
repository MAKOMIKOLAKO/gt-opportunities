# Deploying (Vercel + Neon)

Everything automatable is already wired up: `vercel.json` (static frontend +
the `/api` serverless function + a build command that runs migrations),
`.env.example` (every required env var), and three GitHub Actions workflows
under `.github/workflows/` for the scrapers/classification batch. The steps
below are the ones that genuinely require a human in a browser.

A Railway deployment of the same app also still works (see the bottom of
this file) — it predates this Vercel setup and was left in place, now
pointed at the same Neon database instead of a SQLite volume.

## 1. Create the Neon project

1. [neon.tech](https://neon.tech) -> New Project. Any region/name.
2. Dashboard -> Connection Details -> switch to **"Pooled connection"** (not
   "Direct connection" — the hostname should contain `-pooler`) -> copy the
   connection string. You'll set this as `DATABASE_URL` in both places
   below.

## 2. Create the Vercel project

1. [vercel.com](https://vercel.com) -> Add New -> Project -> import this
   GitHub repo.
2. Vercel will detect `vercel.json` at the repo root and use it
   automatically — no framework preset needed, leave "Other" selected.
3. Project Settings -> Environment Variables -> add every var from
   `.env.example` with real values (all environments — Production/Preview/
   Development):
   - `DATABASE_URL` — the Neon pooled connection string from step 1.2.
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD` — pick real ones.
   - `JWT_SECRET` — generate with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - `NODE_ENV=production` (Vercel sets this automatically at runtime, but
     the build step also reads it — set it explicitly to be safe).
4. Deploy. The build command (`npm run migrate --workspace backend`, from
   `vercel.json`) runs migrations against the empty Neon DB and creates the
   schema before the static assets/function are published. Every later
   push re-runs this — it's a safe no-op once the DB is already migrated.
5. Once deployed, seed the tag vocabulary once (`npm run seed:tags
   --workspace backend`, run locally with `DATABASE_URL` pointed at the
   same Neon pooled connection string — there's no dashboard button for
   this, it's a one-off script).

## 3. Verify

- Visit the deployed URL, confirm the opportunity list loads (empty is fine
  until the scrapers run — proves the DB connection works end to end).
- Visit `<url>/health`, confirm `{"ok": true}`.
- Visit `<url>/api/tags`, confirm the seeded tag vocabulary comes back.
- Log into `<url>/admin.html` with the `ADMIN_USERNAME`/`ADMIN_PASSWORD`
  set in step 2.3.

## 4. Enable the GitHub Actions workflows

1. Repo -> Settings -> Secrets and variables -> Actions -> New repository
   secret -> `DATABASE_URL` = the same Neon pooled connection string.
2. Repo -> Actions tab -> confirm the three workflows (VIP scraper, Engage
   scrape + classify) are listed and enabled (GitHub disables scheduled
   workflows on repos with no recent activity sometimes — re-enable if
   greyed out).
3. Each workflow has a `workflow_dispatch` trigger — use "Run workflow" in
   the Actions tab to test manually rather than waiting for the semester
   cron. See `BUILD_NOTES.md` for the exact cron dates and why they're a
   defaulted judgment call, not a hard requirement — adjust them by hand if
   GT's actual add/drop dates differ.

That's it — every subsequent push to `main` redeploys the Vercel project and
re-runs migrations automatically (safe no-op if nothing changed); the
scrapers run on their own schedule, or on demand via "Run workflow".

## Optional: also deploying to Railway

The pre-existing Railway setup (`railway.json` at repo root,
`frontend/railway.json`) still works — it just needs `DATABASE_URL` set to
the same Neon pooled connection string instead of the old `DB_PATH`/SQLite
volume setup. If you want it:

1. Railway dashboard -> New Project -> Deploy from GitHub repo -> this repo.
   Variables -> add `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`,
   `JWT_SECRET`, `NODE_ENV=production` (do **not** set `PORT` — Railway
   injects it). No Volume needed anymore.
2. Same project -> New -> GitHub Repo -> this repo again -> Settings -> Root
   Directory -> `frontend`. Variables -> `BACKEND_URL` = the first
   service's public URL (Settings -> Networking -> generate a domain).
3. Generate a public domain for the frontend service too — that's the URL
   users visit.

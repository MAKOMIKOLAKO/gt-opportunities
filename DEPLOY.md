# Deploying to Vercel

This project deploys as a **single Vercel project** — no second host, no
Railway, no Render. Vercel serves two things from the same project:

- The static frontend (`frontend/public/*.html`, `app.js`, `admin.js`,
  `style.css`) as static output.
- Every file under `/api` as its own Node.js serverless function, using
  Vercel's plain `/api` directory convention (no framework — see each
  handler file for the route it implements, and `API-CONTRACT.md` for the
  full list).

The database is [Neon](https://neon.tech) (managed Postgres), not a Volume
or a second service — see `BUILD_NOTES.md` for the SQLite -> Postgres port
this replaces (`backend/src/db/schema.ts`, `data-access.ts`).

## 1. Create the Neon database

1. [neon.tech](https://neon.tech) -> New Project.
2. Once created, go to **Connection Details** and copy the **pooled**
   connection string (the one with `-pooler` in the hostname — this matters,
   see the comment in `.env.example`). It looks like:
   ```
   postgresql://user:password@ep-xxxx-pooler.region.aws.neon.tech/dbname?sslmode=require
   ```

## 2. Create the Vercel project

1. Vercel dashboard -> Add New -> Project -> import this repo.
2. Vercel will detect `vercel.json` at the repo root automatically:
   - `outputDirectory: "frontend/public"` — the static site.
   - `/api/**` — auto-detected as serverless functions (Node.js runtime,
     pinned via `vercel.json`'s `functions` block).
   - `buildCommand: "npm run build"` — runs
     `npm run migrate --workspace backend` before Vercel finishes the build,
     so schema migrations apply on every deploy (see step 4).
3. Project Settings -> Environment Variables -> add every var from
   `.env.example` with real values:
   - `DATABASE_URL` — the Neon pooled connection string from step 1.
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD` (pick real ones).
   - `JWT_SECRET` (generate:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   - `NODE_ENV=production`.
   - Apply these to Production (and Preview, if you want preview deploys to
     hit the same DB — or point Preview at a separate Neon branch/database
     for isolation).
4. Deploy. The build runs migrations against Neon (idempotent — safe to
   re-run on every deploy, see `backend/src/db/migrate.ts`), then Vercel
   packages `/api/**` and publishes `frontend/public` as static output.

## 3. Seed the tag vocabulary (one-time)

Migrations create the schema but don't seed data. Run once, from a machine
with `DATABASE_URL` pointed at the same Neon database used in production:

```
DATABASE_URL="<neon pooled connection string>" npm run seed:tags
```

## 4. Verify

- Visit the Vercel project's URL, confirm the opportunity list loads (proves
  `frontend/public/app.js`'s same-origin `fetch("/api/...")` calls are
  reaching the serverless functions, and that the functions can reach Neon).
- Visit `<project-url>/api/health`, confirm `{"ok": true}`.
- Log into `/admin.html` (or `/admin/index.html`) with the `ADMIN_USERNAME` /
  `ADMIN_PASSWORD` set in step 2.

That's it — every subsequent push to the branch Vercel is tracking redeploys
and re-runs migrations automatically (safe no-op if the schema didn't
change).

## Running the scrapers

The scrapers (`backend/src/scrapers/vip.ts`, `engage-scrape.ts`,
`engage-classify.ts`) are **not** part of the Vercel deployment — they stay
standalone scripts you run manually (locally, or from any machine/CI job),
pointed at the same Neon database via `DATABASE_URL`:

```
DATABASE_URL="<neon pooled connection string>" npm run scrape:vip
DATABASE_URL="<neon pooled connection string>" npm run scrape:engage
DATABASE_URL="<neon pooled connection string>" npm run classify:engage
```

`scrape:engage` drives a headless browser (Playwright) and has no DB
dependency of its own — it only writes to `data/raw-cache/engage/`.
`classify:engage` reads that cache and writes to Postgres, so it's the one
that needs `DATABASE_URL`. See root `SCHEDULING.md` for suggested run
cadence (VIP: once per semester; Engage: monthly).

## Local development

- `DATABASE_URL="<neon pooled connection string, or a local Postgres>" npx vercel dev`
  runs the `/api` functions + static frontend together, matching production
  routing.
- Alternatively, `node frontend/server.js` still works as a lightweight
  static-file server for the frontend only (see its updated comment header —
  it's local-dev convenience only now, not a deployed service).
- `npm run migrate`, `npm run seed:tags`, `npm run smoke` all read
  `DATABASE_URL` from the environment the same way production does.

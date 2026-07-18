# Deploying to Railway

Everything automatable is already wired up: build/start commands
(`railway.json`, `frontend/railway.json`), migrations running on every
deploy (`npm run migrate --workspace backend` before the server starts),
and env-based config (`.env.example`, `frontend/.env.example`). The steps
below are the ones that genuinely require a human in a browser.

**Note on the database:** this deploys with SQLite on a Railway Volume, not
a managed Postgres instance. See `BUILD_NOTES.md` ("Addition 5: Railway
deployment — kept SQLite instead of migrating to Postgres") for why, and
what a real Postgres migration would involve if you want to revisit that.

## 1. Create the backend service

1. Railway dashboard -> New Project -> Deploy from GitHub repo -> select
   this repo.
2. Railway will detect `railway.json` at the repo root and use it
   automatically (Nixpacks build, migrate-then-start command).
3. Service Settings -> Add a **Volume**, mount path `/data`.
4. Service Settings -> Variables -> add every var from `.env.example` with
   real values:
   - `DB_PATH=/data/db.sqlite`
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD` (pick real ones)
   - `JWT_SECRET` (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   - `NODE_ENV=production`
   - Do **not** set `PORT` — Railway injects it.
5. Deploy. First deploy runs migrations against the empty volume and
   creates the schema automatically.
6. Settings -> Networking -> generate a public domain for this service.
   Copy that URL, you'll need it for step 2.

## 2. Create the frontend service

1. Same project -> New -> GitHub Repo -> same repo again.
2. Settings -> Root Directory -> set to `frontend`. Railway will now use
   `frontend/railway.json` for this service instead of the root one.
3. Variables -> add from `frontend/.env.example`:
   - `BACKEND_URL` = the backend's public URL from step 1.6.
4. Networking -> generate a public domain for this service. This is the
   URL users actually visit.

## 3. Verify

- Visit the frontend's public URL, confirm the opportunity list loads
  (proves the frontend -> backend proxy and the DB are both working).
- Visit `<backend-url>/health`, confirm `{"ok": true}`.
- Log into `/admin.html` on the frontend URL with the `ADMIN_USERNAME` /
  `ADMIN_PASSWORD` you set in step 1.4.

That's it — every subsequent push to `main` redeploys both services and
re-runs migrations automatically (safe no-op if nothing changed).

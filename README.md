# GT Campus Opportunity Finder

A searchable directory of Georgia Tech student opportunities — VIP (Vertically
Integrated Projects) teams, research labs, and clubs — in one place, with
full-text search, tag/major filtering, crowdsourced submissions, anonymous
text reviews, and an admin moderation queue.

Most of what's in this repo was built to backfill data (scraping VIP and
Engage/CampusLabs) and to keep everything that reaches the public site
behind human review — nothing scraped or submitted is visible until an
admin approves it.

## How it's put together

```
gtopportunities/
├── backend/            Express + TypeScript API, SQLite (better-sqlite3 + Drizzle ORM)
│   └── src/
│       ├── db/          schema, migrations, data-access layer, tag vocabulary
│       ├── routes/       public.ts / submit.ts / admin.ts
│       ├── scrapers/     vip.ts, engage-scrape.ts, engage-classify.ts
│       └── lib/          auth.ts (admin session auth)
├── frontend/            Static site + a tiny same-origin API proxy (server.js)
│   └── public/           index.html/app.js (public site), admin/ (moderation UI)
├── data/                 Scraper cache (raw HTML/JSON + classification results), gitignored
├── API-CONTRACT.md      Source of truth for every endpoint's request/response shape
├── BUILD_NOTES.md       Handoff notes, deliberate scope exclusions, open reconciliation items
└── SCHEDULING.md        Recommended cadence for re-running the scrapers
```

- **Backend**: Express + TypeScript on top of SQLite (`better-sqlite3`),
  schema and queries via [Drizzle ORM](https://orm.drizzle.team/). Full-text
  search uses SQLite's FTS5 extension over name/description/majors/tag
  labels/`details`.
- **Frontend**: Plain HTML/CSS/vanilla JS, served by a small Express static
  server (`frontend/server.js`) that also proxies `/api/*` to the backend so
  the browser only ever talks to one origin (the backend itself sends no
  CORS headers, by design — see the comment in `server.js`).
- **Data model**: three opportunity `type`s (`vip | lab | club`), each with
  a `status` (`approved | pending | rejected`) and `source`
  (`scraped | curated | user_submitted`). Only `approved` rows are ever
  returned by public endpoints. See `API-CONTRACT.md` for the full
  `OpportunityDTO`/`ReviewDTO`/`ReportDTO` shapes.

## Prerequisites

- Node.js 18+ and npm
- No external database or services required — SQLite is a local file
  (`backend/data/db.sqlite` by default)

## Setup

```bash
# from repo root
npm install

# create the SQLite db and run migrations
npm run migrate

# seed the controlled tag vocabulary (discipline/interest tags used for filtering)
npm run seed:tags
```

## Running locally

Run the backend and frontend in separate terminals:

```bash
# terminal 1 — API on :3000
npm run dev:backend

# terminal 2 — static site + API proxy on :8080
npm run dev:frontend
```

Then open **http://localhost:8080**. The frontend proxies `/api/*` to
`http://localhost:3000` by default (override with `BACKEND_URL` /
`PORT` env vars on `frontend/server.js`).

### Admin login

There is no admin account to configure — a random admin password is
generated fresh every time the backend process starts (`backend/src/lib/auth.ts`).
It's printed to the backend's console on startup and also written to a
gitignored `RUN-STATUS.md` at the repo root, so it's discoverable without
ever being hardcoded or committed. **Restarting the backend invalidates the
previous password.** Log in at `/admin.html` (served by the frontend) with
username `admin` and that password.

## Populating data

The site starts empty. Two scrapers populate it; both write rows as
`pending` review status (except VIP, which is auto-approved on ingest — see
scraper scripts for current behavior) so nothing reaches the public app
without going through `/admin.html`'s review queue first.

```bash
# GT VIP catalog (vip.gatech.edu) — idempotent upsert by VIP entry ID
npm run scrape:vip

# GT Engage/CampusLabs directory (~700+ student orgs)
npm run scrape:engage
npm run classify:engage   # offline LLM classification pass: technical/non-technical + tags
```

Both scraper pipelines cache their raw output under `data/` (gitignored) so
re-runs skip unchanged entries — cheap to run repeatedly. See
`SCHEDULING.md` for recommended re-run cadence (VIP: once per semester;
Engage: monthly, since the directory turns over faster).

## API

Every endpoint, request/response shape, and error format is documented in
[`API-CONTRACT.md`](./API-CONTRACT.md) — treat it as the source of truth
over any code comments. Highlights:

- `GET /api/opportunities` — list/search/filter approved opportunities
  (`type`, `search`, `tags` query params)
- `GET /api/opportunities/:id` — single opportunity + its approved reviews
- `POST /api/opportunities/submit` — public submission form (goes to
  `pending`, needs admin approval)
- `POST /api/opportunities/:id/reviews` — anonymous, text-only review
  submission (no rating field — intentional, see `BUILD_NOTES.md`)
- `POST /api/reviews/:id/report` — flag a published review for re-review
- `GET /api/tags` — full controlled tag vocabulary
- `POST /api/admin/login` + `/api/admin/*` — moderation queues for
  opportunities, reviews, and reports (all require a bearer session token)

## Scripts

Run from the repo root (npm workspaces):

| Command | Description |
|---|---|
| `npm run migrate` | Apply database migrations |
| `npm run seed:tags` | Seed the controlled tag vocabulary |
| `npm run dev:backend` | Start the API in watch mode (`:3000`) |
| `npm run dev:frontend` | Start the static site + API proxy (`:8080`) |
| `npm run scrape:vip` | Scrape/upsert the VIP catalog |
| `npm run scrape:engage` | Scrape the Engage/CampusLabs org directory |
| `npm run classify:engage` | Classify scraped Engage orgs (technical/tags) |

Backend-only (`cd backend`): `npm run smoke` runs a quick end-to-end sanity
check against the database.

## Notable design decisions

- **Nothing reaches the public site without human review.** Scraped and
  user-submitted rows land as `pending`; only the admin approve/reject/edit
  flow (or, for VIP, an intentional auto-approve on ingest) changes that.
- **Reviews are anonymous by construction** — no name, email, IP, or
  user-agent is ever stored alongside a review, and there is deliberately
  no numeric rating field (a single bad semester shouldn't dominate a
  score).
- **No automated moderation** for reviews (no profanity filter, no LLM
  auto-approve) — flagging whether a review reads as "about the
  experience" versus "an accusation about a named individual" is treated as
  a judgment call that needs a human, not a heuristic.

See `BUILD_NOTES.md` for the full reasoning behind these calls and a couple
of known open items (e.g. a `reports` table schema reconciliation pending
against another in-progress branch).

## License

No license file is currently included; treat this repository as all-rights-reserved
until one is added.

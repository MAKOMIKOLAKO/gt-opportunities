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
├── api/                 Vercel serverless functions (one file per route — see API-CONTRACT.md)
│   └── _lib/             shared http/auth helpers (not deployed as routes)
├── backend/             Shared lib: DB schema/migrations/data-access + standalone scrapers
│   └── src/
│       ├── db/            schema, migrations, data-access layer, tag vocabulary (Postgres/Drizzle)
│       ├── scrapers/      vip.ts, engage-scrape.ts, engage-classify.ts (run via tsx, not deployed)
│       └── lib/           auth.ts (admin session auth, framework-agnostic)
├── frontend/            Static site, deployed as-is by Vercel
│   └── public/            index.html/app.js (public site), admin/ (moderation UI)
├── data/                 Scraper cache (raw HTML/JSON + classification results), gitignored
├── vercel.json          Wires /api functions + frontend/public static output into one project
├── API-CONTRACT.md      Source of truth for every endpoint's request/response shape
├── BUILD_NOTES.md       Handoff notes, deliberate scope exclusions, open reconciliation items
└── SCHEDULING.md        Recommended cadence for re-running the scrapers
```

- **Backend**: no long-running server. Every route is a standalone Node.js
  serverless function under `/api` (Vercel's plain `/api` directory
  convention — no framework), sharing DB/auth code from `backend/src/`.
  Schema and queries via [Drizzle ORM](https://orm.drizzle.team/) against
  managed Postgres ([Neon](https://neon.tech)). Full-text search runs at
  query time via Postgres `to_tsvector(...) @@ plainto_tsquery(...)` over
  name/description/majors/tag labels/`details`, backed by a GIN expression
  index.
- **Frontend**: Plain HTML/CSS/vanilla JS, served directly by Vercel as
  static output (`frontend/public`) from the same project as `/api` — same
  origin, so `app.js`'s `fetch("/api/...")` calls need no CORS handling.
  `frontend/server.js` still exists as a local-dev convenience (see its
  header comment) but plays no role in production.
- **Data model**: three opportunity `type`s (`vip | lab | club`), each with
  a `status` (`approved | pending | rejected`) and `source`
  (`scraped | curated | user_submitted`). Only `approved` rows are ever
  returned by public endpoints. See `API-CONTRACT.md` for the full
  `OpportunityDTO`/`ReviewDTO`/`ReportDTO` shapes.

## Prerequisites

- Node.js 18+ and npm
- A Postgres database — [Neon](https://neon.tech) (free tier works) is what
  this is built/documented against. Set `DATABASE_URL` to its pooled
  connection string (see `.env.example`).

## Setup

```bash
# from repo root
npm install

# apply database migrations against DATABASE_URL
npm run migrate

# seed the controlled tag vocabulary (discipline/interest tags used for filtering)
npm run seed:tags
```

## Running locally

```bash
# /api functions + static frontend together, matching production routing
DATABASE_URL="<your neon pooled connection string>" npx vercel dev
```

Then open the URL `vercel dev` prints (typically **http://localhost:3000**).

Alternatively, `node frontend/server.js` still serves the static frontend
alone (see DEPLOY.md's "Local development" section) if you're running the
API some other way.

### Admin login

For local dev, set `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `JWT_SECRET` in a
`.env` file read by `vercel dev` (see `.env.example`) so you have known
credentials to log in with. If left unset, `backend/src/lib/auth.ts`
generates a random password + session secret per cold start instead — usable
for a quick poke around locally, but the value isn't surfaced anywhere
(no more single-process startup log to print it to, now that there's no
long-running server), so setting real values is the practical option even
for local dev. Log in at `/admin.html` (or `/admin/index.html`) with
username `admin` (default) and the password you set.

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
| `npm run build` | Runs migrations (Vercel's build step calls this automatically) |
| `npm run migrate` | Apply database migrations |
| `npm run seed:tags` | Seed the controlled tag vocabulary |
| `npm run dev:frontend` | Start the static-file-only dev server (`:8080`, no `/api`) |
| `npx vercel dev` | Start `/api` functions + static frontend together (matches prod routing) |
| `npm run scrape:vip` | Scrape/upsert the VIP catalog |
| `npm run scrape:engage` | Scrape the Engage/CampusLabs org directory |
| `npm run classify:engage` | Classify scraped Engage orgs (technical/tags) |
| `npm run smoke` | Quick end-to-end sanity check against the database |

All scripts read `DATABASE_URL` from the environment.

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

# Build notes — SEO / crawlability (2026-07-19)

## Audit finding

The frontend (`frontend/public/app.js`) is a pure client-rendered SPA with
**no URL routing at all** — every view (directory, an opportunity's detail,
the submit form) renders into the same `<div id="app">` on the same `/`
URL; `setState()` never touches `history`/`location`. Googlebot fetching any
opportunity link sees a blank shell. This is the worst case the task
described (worse than hash-routing), so Phase 1 (crawlable URLs + real HTML)
was the priority; everything else built on top of it.

## What was built

- **`slug` column** (`backend/src/db/schema.ts`): added `slug` (text, not
  null, default `''`) and `previousSlug` (nullable) to `opportunities`.
  Couldn't be `.unique()` from the start — the table already has ~700 rows
  that would all default to `''` and collide. Split across two migrations:
  `0005_add_opportunity_slug.sql` (plain `ADD COLUMN`s) and
  `0006_backfill_opportunity_slug.sql` (hand-written: SQL-side slugify +
  collision-numbering backfill for every existing row, *then*
  `ADD CONSTRAINT ... UNIQUE`, in that order within one migration file so
  uniqueness is only enforced after every row has a distinct value).
  `schema.ts` declares a matching `uniqueIndex` (not `.unique()` on the
  column) purely so future `drizzle-kit generate` runs see schema and DB
  already agree.
- **`backend/src/lib/slug.ts`**: `slugify()` (pure name → slug, mirrors the
  SQL backfill's transform) and `generateUniqueSlug()` (DB collision check,
  appends `-2`, `-3`, ...). Wired into every opportunity-creation path:
  `insertSubmission()`, `vip.ts`'s insert branch, `engage-classify.ts`'s
  insert branch. Update/re-scrape paths deliberately leave an existing
  slug untouched (no URL churn on every scrape re-run) — `updateOpportunity()`
  and `approveSuggestedEdit()` are the two places a live row's `name` can
  change, and both now regenerate the slug *only* when the name actually
  changes, stamping the old value into `previousSlug` for a 301.
- **`backend/src/routes/seo.ts`** (new): server-rendered, fully-crawlable
  HTML — no client JS involved.
  - `GET /opportunities/:slug` — real `<h1>`/`<h2>` content, majors, tags,
    apply link, additional links, related-orgs as real `<a href>`s,
    breadcrumbs (visible + `BreadcrumbList` JSON-LD), `Organization` JSON-LD
    (`parentOrganization` → Georgia Tech), title/meta description/canonical/
    OG/Twitter tags generated from the DTO. 404s (real HTTP 404, not a 200)
    for unknown/unpublished slugs; redirects renamed slugs 301 via
    `previousSlug`. Links to `/?opportunity=<id>` for the interactive SPA
    (reviews, suggest-edit) — see `app.js` below.
  - `GET /categories/:type` — real intro copy per type (not a bare filtered
    list) + `ItemList` JSON-LD linking every approved listing in that type.
  - `GET /robots.txt` — disallows `/admin`, `/admin/`, `/admin.html`,
    `/api/`; points at the sitemap.
  - `GET /sitemap.xml` — generated live from the DB on every request (not a
    static file), approved opportunities only, `<lastmod>` from
    `updated_at`, plus the homepage and three category pages.
  - Mounted at the app root in `app.ts` (`app.use("/", seoRouter)`), not
    under `/api` — these are meant to be the real public URLs.
- **Hosting wiring**, since this repo has two live deploy paths
  (`DEPLOY.md`): `vercel.json` gained rewrites for
  `/opportunities/(.*)`, `/categories/(.*)`, `/sitemap.xml`, `/robots.txt` →
  the same `/api` serverless function (which already exports the whole
  Express app). `frontend/server.js` (the local-dev / Railway two-service
  proxy) gained matching proxy rules for the same four paths — and its
  proxy stopped overwriting the `Host` header with the backend's internal
  host, since `seo.ts` derives canonical/OG URLs from `req.get("host")` and
  the old override would have baked `localhost:3000` into every canonical
  tag when proxied.
- **`app.js`**: `applyDeepLinkFromUrl()`, read once on boot — `?opportunity=<id>`
  opens that listing's detail view directly (what the SSR page's "open in
  the interactive app" link and now `/?opportunity=123` deep-links target),
  `?search=` / `?type=` pre-fill the directory filters (what the homepage's
  `WebSite`/`SearchAction` JSON-LD's sitelinks-search-box target points at).
- **`index.html`**: canonical, OG, Twitter tags, `WebSite`+`SearchAction`
  JSON-LD, `Organization` JSON-LD for the site itself.
- **`admin.html` / `admin/index.html`**: `<meta name="robots" content="noindex, nofollow">`
  as defense-in-depth alongside the `robots.txt` disallow.
- **`style.css`**: appended `.ssr-*` rules for the new server-rendered pages,
  reusing the existing navy/gold design tokens — deliberately lighter-weight
  than the SPA's own styling; these pages exist to be readable to crawlers
  and no-JS visitors, not to replicate the full interaction design.

## Explicitly not done (flagged, not silently skipped)

- **Live testing against a real Postgres DB** — no `DATABASE_URL` was
  configured in this environment and no local Postgres was available.
  Verified via `tsc --noEmit` (clean) and manual review of the SQL/route
  logic instead; the migrations and routes have **not** been run against a
  live database.
- **Filter/sort query-variant canonicalization** (Phase 1's "canonical tags
  ... filters/search/sort will generate many URL variants") — doesn't apply
  here: the SPA never changes the URL for filters/search/sort (state-only),
  so there are no `?category=research&sort=name`-style indexable variants to
  canonicalize away in the first place. A structural non-issue, not a gap.
- **Core Web Vitals measurement** (Phase 5) — no Lighthouse run; this
  environment has no way to serve the app and audit it live.
- **Structured data validation via Google's Rich Results Test** (Phase 3) —
  needs a live, publicly reachable URL; the JSON-LD shapes were checked by
  hand against current schema.org guidance (confirmed `Organization` +
  `parentOrganization`, not `CollegeOrUniversity`, for individual
  listings — see commit) but not run through the actual tool.
- **www vs non-www / custom domain host consistency** — no production
  domain is configured yet (`.env.example` has no `SITE_URL`-equivalent);
  `seo.ts` derives canonical/OG URLs from the live request's Host header so
  it adapts automatically once a domain is chosen, but the actual
  "pick one host, 301 the other" decision is a DNS/Vercel-domain-settings
  step for whoever owns that account.
- **Google Search Console / Bing Webmaster Tools submission** — inherently
  a manual, authenticated, external step; see the PR description.

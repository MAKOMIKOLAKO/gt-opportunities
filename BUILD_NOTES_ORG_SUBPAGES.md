# Build notes — per-org subpages at /org/:slug (2026-08-09)

## Context

The SSR foundation from `BUILD_NOTES_SEO_SSR.md` (slug column, migrations,
server-rendered detail pages, sitemap) already existed and was live in
production, but under `/opportunities/:slug` — and, critically, **nothing on
the homepage linked to it**. Clicking an org on the live SPA opened an
in-page modal with no URL change; the SSR pages were only reachable by typing
the URL directly or via a search-engine crawl. This build closes that gap and
renames the path to match the originally-specified `/org/:slug` shape.

## What changed

- **Route rename**: `/opportunities/:slug` → `/org/:slug`
  (`backend/src/routes/seo.ts`). All internal links (opportunity cards,
  related-orgs, category `ItemList` JSON-LD, sitemap) updated to match.
  `/opportunities/:slug` is kept as a 301 redirect to `/org/:slug` so
  existing indexed/bookmarked links don't break (module 6).
- **Case-insensitive lookup**: the `/org/:slug` and `/org/:slug/manage`
  handlers lowercase `req.params.slug` before calling `getPublicBySlug()` —
  slugs are always generated lowercase, so this was the missing half of
  "case-insensitive" (generation was already lowercase; lookup wasn't
  normalizing the incoming URL).
- **Explicit `Cache-Control: s-maxage=60, stale-while-revalidate`** added to
  `/org/:slug` (previously unset — relied on Vercel/browser defaults).
- **Homepage link updates** (module 4): `frontend/public/app.js` — the
  directory grid cards, list rows, and related-org cards were `<button
  data-action="open-detail">` elements that only mutated in-memory SPA state.
  Converted to real `<a href="/org/:slug">` elements, so clicking an org now
  does a real navigation with a real URL. The `open-detail` dispatch case was
  removed as dead code. `style.css` gained `text-decoration: none` on
  `.org-card`/`.org-list-row` since anchors default to underlined text where
  buttons didn't. The `?opportunity=<id>` deep-link mechanism (used by the
  SSR page's "review / suggest an edit" link back into the interactive app)
  is unchanged — it's a distinct, still-needed path, not the thing being
  replaced.
- **`/org/:slug/manage`** (module 5, new): thin SSR wrapper around the
  existing session-cookie-driven `frontend/public/leader-edit.js` — that
  script already ignores the URL entirely and resolves "which org" purely
  from the `leader_session` cookie via `requireLeaderSession`
  (`backend/src/routes/leader.ts`). This route's job: 404/301 on a bad or
  renamed slug, `Cache-Control: no-store` (never cached, unlike the public
  page above), and a same-request check that a *present* session cookie's
  `opportunityId` actually matches the slug in the URL — 403s with an
  explanatory page if not, so a leader can't be silently shown a different
  org's editor under a URL that names the wrong one.
  `leader.ts` now exports `parseCookies`/`SESSION_COOKIE_NAME` for this.
- **Admin-editable slug** (data model requirement, was previously only
  possible indirectly via a name change): `PATCH /admin/opportunities/:id`
  now accepts an optional `slug` field. Normalized to lowercase, validated
  against the same character set `slugify()` produces
  (`lib/slug.ts::isValidSlugFormat`), and checked for a case-insensitive
  collision (`isSlugTaken`) — `409 slug_conflict` if taken, `400` if
  malformed. Setting it explicitly stamps the old value into `previousSlug`
  (same 301-on-rename behavior as the name-driven path) and takes priority
  over the name-driven auto-regeneration when both are present in one PATCH.
  `updateOpportunity()`'s return type changed from `OpportunityDTO | null` to
  a discriminated `{ kind: "not_found" | "slug_conflict" | "ok", ... }` to
  carry the new failure mode — its only call site (`routes/admin.ts`) was
  updated to match.
- **`vercel.json`** / **`frontend/server.js`**: both gained routing for
  `/org/(.*)` alongside the still-present `/opportunities/(.*)` (now
  redirect-only) and unchanged `/categories/(.*)`, `/sitemap.xml`,
  `/robots.txt`.

## Explicitly not done

- **Wiring the actual magic-link claim email/click flow to a real page** —
  `admin.ts`'s `buildClaimLinkPath()` has produced `/leader/verify?token=...`
  since the original leader-access build, but no route has ever consumed a
  `?token=` query param from its own URL (`leader-edit.js` only handles the
  self-service login-request recovery flow, not an initial claim link). This
  is a pre-existing gap in the leader-access feature, not something this
  per-org-subpages task introduced or was asked to fix.
- **Live testing against Postgres** — verified via `tsc --noEmit` (clean)
  and direct `curl` against the live production deployment for the
  pre-existing `/opportunities/:slug` behavior; the renamed `/org/:slug`,
  `/org/:slug/manage`, and admin slug-edit paths have not yet been exercised
  against a live DB from this change (no local Postgres in this
  environment).

// Server-rendered, crawlable HTML routes — the whole reason this file
// exists (see BUILD_NOTES.md / the SEO task this shipped under): the
// frontend (frontend/public/app.js) is a pure client-rendered SPA with NO
// url routing at all (every view is the same "/" with in-memory state), so
// Googlebot sees a blank <div id="app"></div> for every opportunity,
// category, and the homepage. These routes serve real, readable HTML with
// real <a href> links, so search engines (and no-JS/slow-JS visitors) get
// full content on first response, independent of whether the SPA's JS ever
// runs.
//
// Mounted at the Express app's root (NOT under /api — see app.ts) so the
// same paths work identically behind the Vercel rewrites and the
// frontend/server.js dev proxy (both forward these specific path prefixes
// to this same backend).
import { Router } from "express";
import {
  getPublic,
  getPublicBySlug,
  getApprovedLinks,
  getRelatedOpportunities,
  getSessionByTokenHash,
} from "../db/data-access.js";
import type { OpportunityDTO } from "../db/data-access.js";
import type { OpportunityType } from "../db/schema.js";
import { hashToken } from "../lib/tokens.js";
import { parseCookies, SESSION_COOKIE_NAME } from "./leader.js";

export const seoRouter = Router();

const TYPE_LABEL: Record<OpportunityType, string> = {
  vip: "VIP Team",
  lab: "Research Lab",
  club: "Student Org",
};

const TYPE_PLURAL: Record<OpportunityType, string> = {
  vip: "VIP Teams",
  lab: "Research Labs",
  club: "Student Orgs",
};

const CATEGORY_INTRO: Record<OpportunityType, string> = {
  vip: "Georgia Tech's Vertically Integrated Projects (VIP) program lets undergraduate and graduate students join a multi-semester, faculty-led research or design team and earn academic credit. Browse every active VIP team below — each listing links to the team's full description, majors sought, and how to apply.",
  lab: "Georgia Tech research labs recruit undergraduate and graduate researchers year-round. Browse active labs below to find one that matches your major and interests, then reach out directly using the contact info on each listing.",
  club: "Georgia Tech's technical student organizations range from competition robotics teams to hackathon clubs to industry-affiliated professional societies. Browse the directory below to find a group to join.",
};

const VALID_TYPES: OpportunityType[] = ["vip", "lab", "club"];

function siteOrigin(req: { protocol: string; get(name: string): string | undefined }): string {
  const forwardedProto = req.get("x-forwarded-proto");
  const proto = forwardedProto ? forwardedProto.split(",")[0].trim() : req.protocol;
  return `${proto}://${req.get("host")}`;
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function truncate(str: string, max: number): string {
  const clean = str.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + "…";
}

function pageShell(opts: {
  title: string;
  description: string;
  canonical: string;
  ogImage?: string | null;
  jsonLd: object[];
  bodyHtml: string;
}): string {
  const { title, description, canonical, ogImage, jsonLd, bodyHtml } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${escapeHtml(canonical)}" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}" />\n` : ""}<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
${ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />\n` : ""}<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'" />
<noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" /></noscript>
<link rel="stylesheet" href="/style.css" />
${jsonLd.map((obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`).join("\n")}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function breadcrumbNav(items: { label: string; href?: string }[]): string {
  const parts = items
    .map((item) =>
      item.href
        ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`
        : `<span aria-current="page">${escapeHtml(item.label)}</span>`
    )
    .join(' <span aria-hidden="true">/</span> ');
  return `<nav class="ssr-breadcrumbs" aria-label="Breadcrumb">${parts}</nav>`;
}

function breadcrumbJsonLd(origin: string, items: { label: string; href?: string }[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.label,
      ...(item.href ? { item: origin + item.href } : {}),
    })),
  };
}

function opportunityCardHtml(o: OpportunityDTO): string {
  return `<li class="ssr-card">
  <a href="/org/${escapeHtml(o.slug)}">
    <h3>${escapeHtml(o.name)}</h3>
    <p>${escapeHtml(truncate(o.description || "", 140))}</p>
  </a>
</li>`;
}

// ---- Homepage-adjacent site nav, shared by every SSR page ----
function siteHeaderHtml(): string {
  return `<header class="ssr-header">
  <nav aria-label="Main">
    <a href="/" class="ssr-brand">GT Opportunity Finder</a>
    <a href="/categories/vip">VIP Teams</a>
    <a href="/categories/lab">Research Labs</a>
    <a href="/categories/club">Student Orgs</a>
  </nav>
</header>`;
}

function siteFooterHtml(): string {
  return `<footer class="ssr-footer">
  <p>GT Opportunity Finder is an independent directory of Georgia Tech VIP teams, research labs, and technical student organizations. Not officially affiliated with Georgia Institute of Technology.</p>
</footer>`;
}

// ---- GET /org/:slug — the crawlable, live-rendered per-org page ----
// Slug lookups are normalized to lowercase here (generateUniqueSlug() /
// slugify() only ever produce lowercase slugs — see lib/slug.ts — so this
// keeps e.g. /org/180-Degrees-Consulting and /org/180-degrees-consulting
// resolving to the same row instead of 404ing one of them) and the response
// is edge-cacheable for a short window: leader edits (routes/leader.ts) hit
// this same live table with no rebuild step, so a long cache would show
// stale data, but a bare `no-store` would send every hit straight to
// Postgres. s-maxage=60 + stale-while-revalidate is the compromise — edits
// show up within ~a minute, and a burst of traffic to one org's page still
// only costs one origin hit per minute.
seoRouter.get("/org/:slug", async (req, res) => {
  const origin = siteOrigin(req);
  const slug = req.params.slug.toLowerCase();
  const result = await getPublicBySlug(slug);

  if (result.kind === "redirect") {
    res.redirect(301, `/org/${result.newSlug}`);
    return;
  }
  if (result.kind === "not_found") {
    res.status(404);
    res.send(
      pageShell({
        title: "Opportunity not found | GT Opportunity Finder",
        description: "This listing doesn't exist or is no longer published.",
        canonical: `${origin}/org/${req.params.slug}`,
        jsonLd: [],
        bodyHtml: `${siteHeaderHtml()}<main class="ssr-main"><h1>Opportunity not found</h1><p>This listing doesn't exist or is no longer published. <a href="/">Browse the full directory</a>.</p></main>${siteFooterHtml()}`,
      })
    );
    return;
  }

  res.set("Cache-Control", "s-maxage=60, stale-while-revalidate");

  const opp = result.opportunity;
  const [links, related] = await Promise.all([
    getApprovedLinks(opp.id),
    getRelatedOpportunities(opp.id),
  ]);

  const typeLabel = TYPE_LABEL[opp.type];
  const canonical = `${origin}/org/${opp.slug}`;
  const title = truncate(`${opp.name} — Georgia Tech ${typeLabel}`, 60) + " | GT Opportunity Finder";
  const description = truncate(
    opp.description || `${opp.name} is a Georgia Tech ${typeLabel.toLowerCase()}.`,
    157
  );

  const breadcrumbItems = [
    { label: "Home", href: "/" },
    { label: TYPE_PLURAL[opp.type], href: `/categories/${opp.type}` },
    { label: opp.name },
  ];

  const applyLink = opp.link
    ? `<p><a class="ssr-apply-link" href="${escapeHtml(opp.link)}" rel="noopener">Apply / learn more ↗</a></p>`
    : "";

  const extraLinks = links.length
    ? `<h2>Additional links</h2><ul>${links
        .map((l) => `<li><a href="${escapeHtml(l.url)}" rel="noopener">${escapeHtml(l.label)}</a></li>`)
        .join("")}</ul>`
    : "";

  const majorsHtml = opp.majors.length
    ? `<h2>Majors</h2><p>${opp.majors.map(escapeHtml).join(", ")}</p>`
    : "";

  const tagsHtml = opp.tags.length
    ? `<h2>Tags</h2><ul class="ssr-tags">${opp.tags.map((t) => `<li>${escapeHtml(t.label)}</li>`).join("")}</ul>`
    : "";

  const relatedHtml = related.length
    ? `<h2>Related organizations</h2><ul class="ssr-related">${related
        .map((r) => `<li><a href="/org/${escapeHtml(r.slug)}">${escapeHtml(r.name)}</a></li>`)
        .join("")}</ul>`
    : "";

  const iconHtml = opp.iconUrl
    ? `<img src="${escapeHtml(opp.iconUrl)}" alt="${escapeHtml(opp.name)} logo" class="ssr-icon" width="64" height="64" />`
    : "";

  const jsonLd: object[] = [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: opp.name,
      description: opp.description || undefined,
      url: canonical,
      ...(opp.iconUrl ? { logo: opp.iconUrl } : {}),
      parentOrganization: {
        "@type": "CollegeOrUniversity",
        name: "Georgia Institute of Technology",
        url: "https://www.gatech.edu",
      },
      ...(opp.link ? { sameAs: [opp.link] } : {}),
    },
    breadcrumbJsonLd(origin, breadcrumbItems),
  ];

  const bodyHtml = `${siteHeaderHtml()}
<main class="ssr-main">
${breadcrumbNav(breadcrumbItems)}
<article>
  <header class="ssr-detail-header">
    ${iconHtml}
    <div>
      <h1>${escapeHtml(opp.name)}</h1>
      <p class="ssr-type-badge">Georgia Tech ${escapeHtml(typeLabel)}</p>
    </div>
  </header>
  ${applyLink}
  <h2>About</h2>
  <p>${escapeHtml(opp.description || "No description available yet.")}</p>
  ${majorsHtml}
  ${tagsHtml}
  <h2>How to apply</h2>
  <p>${opp.link ? `Visit the <a href="${escapeHtml(opp.link)}" rel="noopener">official page</a> to apply or learn more.` : "Contact information is not yet available for this listing."}</p>
  ${extraLinks}
  ${relatedHtml}
  <p class="ssr-app-link"><a href="/?opportunity=${opp.id}">Leave a review or suggest an edit in the interactive app →</a></p>
</article>
</main>
${siteFooterHtml()}`;

  res.send(pageShell({ title, description, canonical, ogImage: opp.iconUrl, jsonLd, bodyHtml }));
});

// ---- GET /opportunities/:slug — legacy path, permanent redirect (module 6) ----
// This was the org detail page's URL before the /org/:slug rename above; kept
// as a 301 so old shared links/bookmarks/anything search engines already
// indexed under the old prefix don't 404.
seoRouter.get("/opportunities/:slug", (req, res) => {
  res.redirect(301, `/org/${req.params.slug}`);
});

function managePageShell(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Manage your listing — Opportunity Finder</title>
<meta name="robots" content="noindex, nofollow" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'" />
<noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" /></noscript>
<link rel="stylesheet" href="/style.css" />
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// ---- GET /org/:slug/manage — leader self-service edit page (module 5) ----
// Deliberately thin: the real editor is the existing static
// frontend/public/leader-edit.js, which is entirely session-cookie-driven —
// it never reads an id/slug out of its own URL, it just calls
// GET/PUT /api/leader/opportunity and lets requireLeaderSession
// (routes/leader.ts) resolve "which org" purely from the leader_session
// cookie. This route's job is narrower:
//   - resolve the slug so a bad/renamed one gets a real 404 or 301, not a
//     silent client-side "not found";
//   - NEVER cache this page (Cache-Control: no-store) — unlike the public
//     /org/:slug page above, which deliberately does cache;
//   - if a session cookie IS present but belongs to a *different* org than
//     the slug in the URL (a leader bookmarks/shares the wrong link, or is
//     logged into two orgs in different tabs), refuse with 403 instead of
//     silently rendering their own (wrong) org's editor under this URL —
//     requireLeaderSession alone can't catch this since it has no idea what
//     URL it's protecting (see its own comment in routes/leader.ts).
seoRouter.get("/org/:slug/manage", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const slug = req.params.slug.toLowerCase();
  const result = await getPublicBySlug(slug);

  if (result.kind === "redirect") {
    res.redirect(301, `/org/${result.newSlug}/manage`);
    return;
  }
  if (result.kind === "not_found") {
    res.status(404).send(
      managePageShell(
        `<main class="ssr-main"><h1>Listing not found</h1><p>This listing doesn't exist or is no longer published.</p></main>`
      )
    );
    return;
  }

  const cookies = parseCookies(req.header("cookie"));
  const raw = cookies[SESSION_COOKIE_NAME];
  if (raw) {
    const session = await getSessionByTokenHash(hashToken(raw));
    const valid = !!session && !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now();
    if (valid && session!.opportunityId !== result.opportunity.id) {
      res.status(403).send(
        managePageShell(
          `<main class="ssr-main"><h1>Wrong organization</h1><p>You're currently logged in to manage a different organization's listing than <strong>${escapeHtml(
            result.opportunity.name
          )}</strong>. Log out and request a new access link for this org to continue.</p></main>`
        )
      );
      return;
    }
  }

  res.send(managePageShell(`<div id="app"></div>\n<script src="/leader-edit.js" defer></script>`));
});

// ---- GET /categories/:type ----
seoRouter.get("/categories/:type", async (req, res) => {
  const origin = siteOrigin(req);
  const type = req.params.type as OpportunityType;
  if (!VALID_TYPES.includes(type)) {
    res.status(404).send(
      pageShell({
        title: "Category not found | GT Opportunity Finder",
        description: "This category doesn't exist.",
        canonical: `${origin}/categories/${req.params.type}`,
        jsonLd: [],
        bodyHtml: `${siteHeaderHtml()}<main class="ssr-main"><h1>Category not found</h1><p><a href="/">Browse the full directory</a>.</p></main>${siteFooterHtml()}`,
      })
    );
    return;
  }

  const results = await getPublic({ type });
  const canonical = `${origin}/categories/${type}`;
  const title = `Georgia Tech ${TYPE_PLURAL[type]} — Full List | GT Opportunity Finder`;
  const description = truncate(
    `Browse every active Georgia Tech ${TYPE_LABEL[type].toLowerCase()} (${results.length} listed). ${CATEGORY_INTRO[type]}`,
    157
  );
  const breadcrumbItems = [{ label: "Home", href: "/" }, { label: TYPE_PLURAL[type] }];

  const jsonLd: object[] = [
    breadcrumbJsonLd(origin, breadcrumbItems),
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: `Georgia Tech ${TYPE_PLURAL[type]}`,
      itemListElement: results.map((o, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${origin}/org/${o.slug}`,
        name: o.name,
      })),
    },
  ];

  const bodyHtml = `${siteHeaderHtml()}
<main class="ssr-main">
${breadcrumbNav(breadcrumbItems)}
<h1>Georgia Tech ${escapeHtml(TYPE_PLURAL[type])}</h1>
<p class="ssr-intro">${escapeHtml(CATEGORY_INTRO[type])}</p>
<ul class="ssr-card-list">
${results.map(opportunityCardHtml).join("\n")}
</ul>
</main>
${siteFooterHtml()}`;

  res.send(pageShell({ title, description, canonical, jsonLd, bodyHtml }));
});

// ---- GET /robots.txt ----
seoRouter.get("/robots.txt", (req, res) => {
  const origin = siteOrigin(req);
  res.type("text/plain").send(
    `User-agent: *
Allow: /
Disallow: /admin
Disallow: /admin.html
Disallow: /admin/
Disallow: /api/

Sitemap: ${origin}/sitemap.xml
`
  );
});

// ---- GET /sitemap.xml ----
// Dynamically generated from the DB on every request (not a static file
// that goes stale) — approved opportunities only, with <lastmod> from
// updatedAt so crawlers know when to re-fetch. Rejected/pending rows and
// admin routes are excluded by construction (getPublic() only ever returns
// approved rows).
seoRouter.get("/sitemap.xml", async (req, res) => {
  const origin = siteOrigin(req);
  const all = await getPublic();

  const staticUrls = [
    { loc: `${origin}/`, changefreq: "daily", priority: "1.0" },
    { loc: `${origin}/categories/vip`, changefreq: "daily", priority: "0.8" },
    { loc: `${origin}/categories/lab`, changefreq: "daily", priority: "0.8" },
    { loc: `${origin}/categories/club`, changefreq: "daily", priority: "0.8" },
  ];

  const urlEntries = [
    ...staticUrls.map((u) => `  <url>\n    <loc>${escapeHtml(u.loc)}</loc>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`),
    ...all.map(
      (o) =>
        `  <url>\n    <loc>${escapeHtml(`${origin}/org/${o.slug}`)}</loc>\n    <lastmod>${new Date(o.updatedAt).toISOString()}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`
    ),
  ];

  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries.join("\n")}\n</urlset>\n`
  );
});

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
} from "../db/data-access.js";
import type { OpportunityDTO } from "../db/data-access.js";
import type { OpportunityType } from "../db/schema.js";

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
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}" />\n` : ""}<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
${ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />\n` : ""}<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
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
  <a href="/opportunities/${escapeHtml(o.slug)}">
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

// ---- GET /opportunities/:slug ----
seoRouter.get("/opportunities/:slug", async (req, res) => {
  const origin = siteOrigin(req);
  const result = await getPublicBySlug(req.params.slug);

  if (result.kind === "redirect") {
    res.redirect(301, `/opportunities/${result.newSlug}`);
    return;
  }
  if (result.kind === "not_found") {
    res.status(404);
    res.send(
      pageShell({
        title: "Opportunity not found | GT Opportunity Finder",
        description: "This listing doesn't exist or is no longer published.",
        canonical: `${origin}/opportunities/${req.params.slug}`,
        jsonLd: [],
        bodyHtml: `${siteHeaderHtml()}<main class="ssr-main"><h1>Opportunity not found</h1><p>This listing doesn't exist or is no longer published. <a href="/">Browse the full directory</a>.</p></main>${siteFooterHtml()}`,
      })
    );
    return;
  }

  const opp = result.opportunity;
  const [links, related] = await Promise.all([
    getApprovedLinks(opp.id),
    getRelatedOpportunities(opp.id),
  ]);

  const typeLabel = TYPE_LABEL[opp.type];
  const canonical = `${origin}/opportunities/${opp.slug}`;
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
        .map((r) => `<li><a href="/opportunities/${escapeHtml(r.slug)}">${escapeHtml(r.name)}</a></li>`)
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
        url: `${origin}/opportunities/${o.slug}`,
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
        `  <url>\n    <loc>${escapeHtml(`${origin}/opportunities/${o.slug}`)}</loc>\n    <lastmod>${new Date(o.updatedAt).toISOString()}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`
    ),
  ];

  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries.join("\n")}\n</urlset>\n`
  );
});

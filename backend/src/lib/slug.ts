// Slug generation for the SEO-facing /org/:slug URL (see
// backend/src/routes/seo.ts). Entry points:
//   - slugify(): pure name -> base-slug transform, also used by the SQL
//     backfill migration (0006_backfill_opportunity_slug.sql) — keep the two
//     in sync if this logic ever changes.
//   - generateUniqueSlug(): slugify() + a DB check that appends "-2", "-3",
//     ... on collision, mirroring the backfill migration's convention (first
//     claimant keeps the bare slug). Used on every auto-generated path
//     (submission, scraper upserts, rename-via-name).
//   - isValidSlugFormat() / isSlugTaken(): used when an admin sets a slug
//     explicitly (routes/admin.ts PATCH /admin/opportunities/:id) instead of
//     letting the name drive it — that path should reject a bad/taken slug
//     outright rather than silently renumbering it out from under the admin.
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "opportunity";
}

// Same character set slugify() ever produces: lowercase alphanumerics
// separated by single hyphens, no leading/trailing hyphen. Enforced here so
// an admin-supplied slug can't introduce characters that would need extra
// escaping/normalizing anywhere a slug is interpolated into a URL.
const SLUG_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSlugFormat(slug: string): boolean {
  return SLUG_FORMAT.test(slug);
}

/** Case-insensitive existence check — slugs are always lowercase, but this
 * guards against an admin submitting mixed-case that would otherwise create
 * a second, differently-cased row reachable at what looks like the same
 * URL (GET /org/:slug lowercases before lookup — see routes/seo.ts). */
export async function isSlugTaken(slug: string, excludeId?: number): Promise<boolean> {
  const rows = await db.execute<{ id: number }>(
    excludeId == null
      ? sql`SELECT id FROM opportunities WHERE lower(slug) = ${slug.toLowerCase()}`
      : sql`SELECT id FROM opportunities WHERE lower(slug) = ${slug.toLowerCase()} AND id != ${excludeId}`
  );
  return rows.rows.length > 0;
}

/**
 * Returns a slug guaranteed unique among `opportunities.slug` (excluding
 * `excludeId`, so re-saving a row without changing its name doesn't collide
 * with itself). Base name -> base-slug via slugify(); on collision, appends
 * "-2", "-3", ... until free.
 */
export async function generateUniqueSlug(name: string, excludeId?: number): Promise<string> {
  const base = slugify(name);
  const rows = await db.execute<{ slug: string }>(
    excludeId == null
      ? sql`SELECT slug FROM opportunities WHERE slug = ${base} OR slug LIKE ${base + "-%"}`
      : sql`SELECT slug FROM opportunities WHERE (slug = ${base} OR slug LIKE ${base + "-%"}) AND id != ${excludeId}`
  );
  const taken = new Set(rows.rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

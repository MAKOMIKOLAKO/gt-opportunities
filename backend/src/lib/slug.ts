// Slug generation for the SEO-facing /opportunities/:slug URL (see
// backend/src/routes/seo.ts). Two entry points:
//   - slugify(): pure name -> base-slug transform, also used by the SQL
//     backfill migration (0006_backfill_opportunity_slug.sql) — keep the two
//     in sync if this logic ever changes.
//   - generateUniqueSlug(): slugify() + a DB check that appends "-2", "-3",
//     ... on collision, mirroring the backfill migration's convention (first
//     claimant keeps the bare slug).
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "opportunity";
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

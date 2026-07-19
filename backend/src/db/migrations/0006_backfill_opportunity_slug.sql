-- Backfill `slug` for every existing row (added as a plain-default '' column
-- in 0005) and then lock in a unique index. Must run as one migration so the
-- backfill happens before uniqueness is enforced — see the comment on
-- `slug` in schema.ts for why this couldn't just be `.unique()` from the
-- start.
--
-- Slug derivation mirrors backend/src/lib/slug.ts's slugify(): lowercase,
-- strip everything but [a-z0-9], collapse runs into single hyphens, trim
-- leading/trailing hyphens. Rows whose name slugifies to '' (e.g.
-- punctuation-only) fall back to "opportunity-<id>". Collisions across rows
-- (two names slugifying to the same base) are disambiguated by appending
-- "-2", "-3", ... in id order — the first row to claim a base slug keeps it
-- bare, matching the collision convention slug.ts uses for new inserts.
WITH base AS (
  SELECT
    id,
    COALESCE(
      NULLIF(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''),
      'opportunity-' || id
    ) AS base_slug
  FROM opportunities
),
numbered AS (
  SELECT
    id,
    base_slug,
    row_number() OVER (PARTITION BY base_slug ORDER BY id) AS rn
  FROM base
)
UPDATE opportunities o
SET slug = CASE WHEN n.rn = 1 THEN n.base_slug ELSE n.base_slug || '-' || n.rn END
FROM numbered n
WHERE o.id = n.id;
--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_slug_unique" UNIQUE ("slug");

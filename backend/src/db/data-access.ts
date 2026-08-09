// Data-access layer. `getPublic` is the ONLY sanctioned read path for
// public-facing routes/tests — it hardcodes status = 'approved' inside the
// query itself, so a caller cannot override it via params (there is no status
// param on its filter type at all). Anything that needs to see
// pending/rejected rows MUST go through `getForAdmin`, which is named to make
// misuse from a public route obvious in review.
//
// Postgres note: every function here is now async (the Neon driver has no
// synchronous mode the way better-sqlite3 did) — see BUILD_NOTES.md. Callers
// (routes, scrapers) must `await` these.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  opportunities,
  opportunityTags,
  tags,
  reviews,
  reports,
  links,
  relatedOpportunities,
  suggestedEdits,
  opportunityAccess,
  accessRequests,
  magicLinks,
  sessions,
  auditLog,
  type OpportunityType,
  type OpportunityStatus,
  type ReviewStatus,
  type ReportCategory,
  type ReportStatus,
  type LinkType,
  type LinkStatus,
  type SuggestedEditStatus,
  type AccessStatus,
  type AccessRequestStatus,
  type MagicLinkPurpose,
} from "./schema.js";
import { getMajors, getMeta, setMajors, setMeta, getDetails, buildSearchBlob } from "./json-columns.js";
import { embedOpportunity } from "../lib/embeddings.js";
import { recomputeRelated } from "../lib/related-opportunities.js";
import { generateUniqueSlug } from "../lib/slug.js";

export interface OpportunityDTO {
  id: number;
  slug: string;
  type: OpportunityType;
  name: string;
  description: string;
  majors: string[];
  link: string | null;
  meta: Record<string, unknown>;
  details: Record<string, unknown>;
  source: string;
  status: OpportunityStatus;
  submittedBy: string | null;
  // Live, publicly-served icon. `iconPendingUrl` (submitted-but-unapproved)
  // is deliberately NOT part of this public DTO — see AdminOpportunityDTO
  // below for the admin-only shape that includes it.
  iconUrl: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  lastVerified: string | null;
  createdAt: string;
  updatedAt: string;
  tags: { slug: string; label: string; category: string }[];
}

/**
 * ADMIN-ONLY DTO — extends OpportunityDTO with `iconPendingUrl`, the
 * submitted-but-not-yet-approved icon. Never returned from a public route.
 */
export type AdminOpportunityDTO = OpportunityDTO & { iconPendingUrl: string | null };

async function attachTags(rows: (typeof opportunities.$inferSelect)[]): Promise<OpportunityDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const tagRows = await db
    .select({
      opportunityId: opportunityTags.opportunityId,
      slug: tags.slug,
      label: tags.label,
      category: tags.category,
    })
    .from(opportunityTags)
    .innerJoin(tags, eq(opportunityTags.tagId, tags.id))
    .where(inArray(opportunityTags.opportunityId, ids));

  const tagsByOpportunity = new Map<number, { slug: string; label: string; category: string }[]>();
  for (const t of tagRows) {
    const list = tagsByOpportunity.get(t.opportunityId) ?? [];
    list.push({ slug: t.slug, label: t.label, category: t.category });
    tagsByOpportunity.set(t.opportunityId, list);
  }

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    type: r.type,
    name: r.name,
    description: r.description,
    majors: getMajors(r.majors),
    link: r.link,
    meta: getMeta(r.meta),
    details: getDetails(r.details),
    source: r.source,
    status: r.status,
    submittedBy: r.submittedBy,
    iconUrl: r.iconUrl,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
    lastVerified: r.lastVerified,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    tags: tagsByOpportunity.get(r.id) ?? [],
  }));
}

// Sanitizes a free-text search string into a Postgres to_tsquery expression:
// each whitespace-separated term becomes a prefix-matched lexeme (`term:*`),
// ANDed together. This is the Postgres equivalent of the old SQLite FTS5
// prefix-match query. Returns null if nothing usable survives sanitization
// (e.g. a punctuation-only query), so callers can fall back.
function tsQueryString(raw: string): string | null {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9_]/g, ""))
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((t) => `${t}:*`).join(" & ");
}

/**
 * Full-text search over the `search_vector` tsvector column (this project's
 * Postgres equivalent of SQLite's FTS5 index — see search_blob/search_vector
 * in schema.ts). Reaches name, description, majors, tag labels, and every
 * string value nested in `details`, not just description.
 *
 * Returns a match -> relevance rank map (via ts_rank) rather than a plain Set
 * so callers can order results by how well they match instead of getting
 * them back in whatever order the base query happened to return rows in
 * (which in practice meant "all VIPs, then all clubs" — insertion order).
 */
async function searchMatchingIds(query: string): Promise<Map<number, number>> {
  const tsQuery = tsQueryString(query);
  if (tsQuery) {
    const rows = await db.execute<{ id: number; rank: number }>(
      sql`SELECT id, ts_rank(search_vector, to_tsquery('english', ${tsQuery})) as rank
          FROM opportunities WHERE search_vector @@ to_tsquery('english', ${tsQuery})`
    );
    return new Map(rows.rows.map((r) => [Number(r.id), Number(r.rank)]));
  }
  // No usable tsquery terms survived sanitization (e.g. punctuation-only
  // query) — fall back to a plain substring match so the endpoint still
  // degrades gracefully instead of returning nothing. No rank signal here,
  // so every match ties at 0 and falls back to the title sort below.
  const needle = query.toLowerCase();
  const rows = await db
    .select({ id: opportunities.id, name: opportunities.name, description: opportunities.description })
    .from(opportunities);
  return new Map(
    rows
      .filter((r) => r.name.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle))
      .map((r) => [r.id, 0])
  );
}

// Shared ordering for both public and admin listings: when a search query is
// present, best relevance match first (ties broken alphabetically); with no
// query, plain alphabetical-by-title so results aren't just insertion order.
function sortByRelevanceThenTitle<T extends { id: number; name: string }>(
  rows: T[],
  ranks?: Map<number, number>
): T[] {
  return [...rows].sort((a, b) => {
    if (ranks) {
      const rankDiff = (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0);
      if (rankDiff !== 0) return rankDiff;
    }
    return a.name.localeCompare(b.name);
  });
}

export interface PublicFilters {
  type?: OpportunityType;
  search?: string;
  tagSlugs?: string[];
}

/**
 * The only sanctioned public-read path. status = 'approved' is hardcoded
 * below and is NOT a filter param — there is structurally no way for a
 * caller of this function to request pending/rejected rows.
 */
export async function getPublic(filters: PublicFilters = {}): Promise<OpportunityDTO[]> {
  const conditions = [eq(opportunities.status, "approved" as const)];

  if (filters.type) {
    conditions.push(eq(opportunities.type, filters.type));
  }

  let rows = await db
    .select()
    .from(opportunities)
    .where(and(...conditions));

  let ranks: Map<number, number> | undefined;
  if (filters.search) {
    ranks = await searchMatchingIds(filters.search);
    rows = rows.filter((r) => ranks!.has(r.id));
  }

  if (filters.tagSlugs && filters.tagSlugs.length > 0) {
    const tagMatchRows = await db
      .select({ opportunityId: opportunityTags.opportunityId })
      .from(opportunityTags)
      .innerJoin(tags, eq(opportunityTags.tagId, tags.id))
      .where(inArray(tags.slug, filters.tagSlugs));
    const matchIds = new Set(tagMatchRows.map((r) => r.opportunityId));
    rows = rows.filter((r) => matchIds.has(r.id));
  }

  return attachTags(sortByRelevanceThenTitle(rows, ranks));
}

export type PublicBySlugResult =
  | { kind: "found"; opportunity: OpportunityDTO }
  | { kind: "redirect"; newSlug: string }
  | { kind: "not_found" };

/**
 * The sanctioned public-read path for the SSR /opportunities/:slug route
 * (see backend/src/routes/seo.ts) — status = 'approved' is hardcoded, same
 * discipline as getPublic(). Falls back to matching `previousSlug` (set by
 * updateOpportunity()/approveSuggestedEdit() on rename) so a renamed
 * opportunity's old URL can 301 to its new one instead of 404ing a link
 * Google or a bookmark still has.
 */
export async function getPublicBySlug(slug: string): Promise<PublicBySlugResult> {
  const rows = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.slug, slug), eq(opportunities.status, "approved" as const)));
  if (rows.length > 0) {
    const [opportunity] = await attachTags(rows);
    return { kind: "found", opportunity };
  }

  const prevRows = await db
    .select({ slug: opportunities.slug })
    .from(opportunities)
    .where(and(eq(opportunities.previousSlug, slug), eq(opportunities.status, "approved" as const)));
  if (prevRows.length > 0) {
    return { kind: "redirect", newSlug: prevRows[0].slug };
  }

  return { kind: "not_found" };
}

export interface AdminFilters {
  status?: OpportunityStatus;
  type?: OpportunityType;
  search?: string;
}

/**
 * ADMIN-ONLY read path — can see all statuses (approved/pending/rejected).
 * Callers MUST gate access to this behind admin auth at the route layer;
 * this function performs no auth check itself.
 */
export async function getForAdmin(filters: AdminFilters = {}): Promise<OpportunityDTO[]> {
  const conditions = [];
  if (filters.status) conditions.push(eq(opportunities.status, filters.status));
  if (filters.type) conditions.push(eq(opportunities.type, filters.type));

  let rows = await db
    .select()
    .from(opportunities)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  let ranks: Map<number, number> | undefined;
  if (filters.search) {
    ranks = await searchMatchingIds(filters.search);
    rows = rows.filter((r) => ranks!.has(r.id));
  }

  return attachTags(sortByRelevanceThenTitle(rows, ranks));
}

export async function getAllTags() {
  return db.select().from(tags);
}

// ---- Mutation helpers (submission + admin review flows) ----
// These are the sanctioned write paths so routes never build drizzle
// queries against `opportunities` inline.

async function tagIdsForSlugs(slugs: string[]): Promise<number[]> {
  if (slugs.length === 0) return [];
  const rows = await db.select({ id: tags.id }).from(tags).where(inArray(tags.slug, slugs));
  return rows.map((r) => r.id);
}

async function replaceTagLinks(opportunityId: number, tagSlugs: string[]): Promise<void> {
  await db.delete(opportunityTags).where(eq(opportunityTags.opportunityId, opportunityId));
  const ids = await tagIdsForSlugs(tagSlugs);
  for (const tagId of ids) {
    await db.insert(opportunityTags).values({ opportunityId, tagId });
  }
}

async function tagLabelsForOpportunity(opportunityId: number): Promise<string[]> {
  const rows = await db
    .select({ label: tags.label })
    .from(opportunityTags)
    .innerJoin(tags, eq(opportunityTags.tagId, tags.id))
    .where(eq(opportunityTags.opportunityId, opportunityId));
  return rows.map((r) => r.label);
}

/**
 * Recomputes and persists `search_blob` + `search_vector` for one row from
 * its current name/description/majors/details/tags. Callers never touch the
 * search columns directly. Exported so scrapers (e.g. vip.ts, which upserts
 * via raw db calls rather than these helpers) can keep newly-scraped rows
 * searchable too.
 */
export async function refreshSearchBlob(opportunityId: number): Promise<void> {
  const rows = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  if (rows.length === 0) return;
  const row = rows[0];
  const blob = buildSearchBlob({
    name: row.name,
    description: row.description,
    majors: getMajors(row.majors),
    details: getDetails(row.details),
    tagLabels: await tagLabelsForOpportunity(opportunityId),
  });
  await db
    .update(opportunities)
    .set({ searchBlob: blob, searchVector: sql`to_tsvector('english', ${blob})` })
    .where(eq(opportunities.id, opportunityId));
}

export interface SubmissionInput {
  type: OpportunityType;
  name: string;
  description: string;
  majors?: string[];
  link?: string | null;
  tagSlugs?: string[];
  submittedBy?: string | null;
}

/** Public submission path: always source='user_submitted', status='pending'. */
export async function insertSubmission(input: SubmissionInput): Promise<number> {
  const slug = await generateUniqueSlug(input.name);
  const [row] = await db
    .insert(opportunities)
    .values({
      slug,
      type: input.type,
      name: input.name,
      description: input.description,
      majors: setMajors(input.majors ?? []),
      link: input.link ?? null,
      meta: setMeta({}),
      source: "user_submitted",
      status: "pending",
      submittedBy: input.submittedBy ?? null,
    })
    .returning({ id: opportunities.id });

  const id = row.id;
  if (input.tagSlugs && input.tagSlugs.length > 0) {
    await replaceTagLinks(id, input.tagSlugs);
  }
  await refreshSearchBlob(id);
  return id;
}

/**
 * ADMIN-ONLY: fetch a single row regardless of status, with `iconPendingUrl`
 * attached (the one field the public DTO never exposes).
 */
export async function getByIdForAdmin(id: number): Promise<AdminOpportunityDTO | null> {
  const rows = await db.select().from(opportunities).where(eq(opportunities.id, id));
  if (rows.length === 0) return null;
  const dto = (await attachTags(rows))[0];
  return { ...dto, iconPendingUrl: rows[0].iconPendingUrl };
}

/**
 * Re-embeds an opportunity and recomputes its related-orgs cache. Called
 * after approve/edit (name/description/tags may have changed) as well as
 * from the scrapers (vip.ts, engage-classify.ts). Deliberately swallows
 * errors — a re-embed/related-orgs failure must never block an approval or
 * edit from completing; see BUILD_NOTES.md and embeddings.ts.
 */
async function reembedAndRecompute(id: number): Promise<void> {
  try {
    if (await embedOpportunity(id)) {
      await recomputeRelated(id);
    }
  } catch (err) {
    console.error(`reembedAndRecompute(${id}) failed:`, (err as Error).message);
  }
}

/** ADMIN-ONLY: approve a pending/rejected row, stamping reviewedBy/reviewedAt. */
export async function approveOpportunity(id: number, reviewedBy: string): Promise<OpportunityDTO | null> {
  const existing = await db.select().from(opportunities).where(eq(opportunities.id, id));
  if (existing.length === 0) return null;
  await db
    .update(opportunities)
    .set({
      status: "approved",
      reviewedBy,
      reviewedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(opportunities.id, id));
  await reembedAndRecompute(id);
  return getByIdForAdmin(id);
}

/** ADMIN-ONLY: reject a row, stamping reviewedBy/reviewedAt, optional reason into meta. */
export async function rejectOpportunity(
  id: number,
  reviewedBy: string,
  reason?: string
): Promise<OpportunityDTO | null> {
  const existing = await db.select().from(opportunities).where(eq(opportunities.id, id));
  if (existing.length === 0) return null;
  const row = existing[0];
  const meta = getMeta(row.meta);
  if (reason) meta.rejectionReason = reason;
  await db
    .update(opportunities)
    .set({
      status: "rejected",
      reviewedBy,
      reviewedAt: sql`now()`,
      updatedAt: sql`now()`,
      meta: setMeta(meta),
    })
    .where(eq(opportunities.id, id));
  return getByIdForAdmin(id);
}

export interface EditFields {
  name?: string;
  description?: string;
  majors?: string[];
  link?: string | null;
  tagSlugs?: string[];
  type?: OpportunityType;
}

/** ADMIN-ONLY: edit fields and, if approve=true, flip status to approved in the same write. */
export async function updateOpportunity(
  id: number,
  fields: EditFields,
  approve: boolean,
  reviewedBy: string
): Promise<OpportunityDTO | null> {
  const existing = await db.select().from(opportunities).where(eq(opportunities.id, id));
  if (existing.length === 0) return null;

  const patch: Record<string, unknown> = { updatedAt: sql`now()` };
  // Renaming a live opportunity would silently break its indexed
  // /opportunities/:slug URL, so regenerate the slug alongside the name and
  // keep the old one in `previousSlug` — seo.ts 301s requests for it to the
  // new slug instead of 404ing a link Google (or a bookmark) already has.
  if (fields.name !== undefined && fields.name !== existing[0].name) {
    patch.name = fields.name;
    patch.slug = await generateUniqueSlug(fields.name, id);
    patch.previousSlug = existing[0].slug;
  } else if (fields.name !== undefined) {
    patch.name = fields.name;
  }
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.majors !== undefined) patch.majors = setMajors(fields.majors);
  if (fields.link !== undefined) patch.link = fields.link;
  if (fields.type !== undefined) patch.type = fields.type;
  if (approve) {
    patch.status = "approved";
    patch.reviewedBy = reviewedBy;
    patch.reviewedAt = sql`now()`;
  }

  await db.transaction(async (tx) => {
    await tx.update(opportunities).set(patch).where(eq(opportunities.id, id));
    if (fields.tagSlugs !== undefined) {
      await tx.delete(opportunityTags).where(eq(opportunityTags.opportunityId, id));
      const idRows = fields.tagSlugs!.length
        ? await tx.select({ id: tags.id }).from(tags).where(inArray(tags.slug, fields.tagSlugs!))
        : [];
      for (const tagRow of idRows) {
        await tx.insert(opportunityTags).values({ opportunityId: id, tagId: tagRow.id });
      }
    }
  });

  await refreshSearchBlob(id);
  // name/description/tags may have just changed — re-embed and recompute
  // related orgs regardless of whether `approve` was true (an edit to an
  // already-approved row should still refresh its related-orgs cache).
  await reembedAndRecompute(id);
  return getByIdForAdmin(id);
}

// ---- Org profile icon (icon submission feature) ----
// Public submission -> admin approve/reject, following the same
// pending-review-lifecycle shape as opportunities/reviews above.

/**
 * Public path: submit a candidate icon URL for an EXISTING (public/approved)
 * opportunity. Sets `iconPendingUrl` only — never touches the live `iconUrl`.
 * Returns false if the opportunity doesn't exist (caller decides how to
 * respond; route layer additionally requires the opportunity be public
 * before calling this, so pending/rejected rows can't be probed via this
 * path either).
 */
export async function submitIconPending(opportunityId: number, url: string): Promise<boolean> {
  const existing = await db.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.id, opportunityId));
  if (existing.length === 0) return false;
  await db
    .update(opportunities)
    .set({ iconPendingUrl: url, updatedAt: sql`now()` })
    .where(eq(opportunities.id, opportunityId));
  return true;
}

/**
 * ADMIN-ONLY: list opportunities with a pending icon submission awaiting
 * review (iconPendingUrl IS NOT NULL).
 */
export async function getPendingIcons(): Promise<
  { id: number; name: string; iconUrl: string | null; iconPendingUrl: string | null }[]
> {
  const rows = await db
    .select({
      id: opportunities.id,
      name: opportunities.name,
      iconUrl: opportunities.iconUrl,
      iconPendingUrl: opportunities.iconPendingUrl,
    })
    .from(opportunities)
    .where(sql`${opportunities.iconPendingUrl} IS NOT NULL`)
    .orderBy(opportunities.name);
  return rows;
}

/**
 * ADMIN-ONLY: promote the pending icon to live, clearing the pending slot.
 * `reviewedBy` is accepted for parity with the other admin mutation helpers
 * (and route-layer stamping conventions) but deliberately does NOT write to
 * the opportunity's own `reviewedBy`/`reviewedAt` columns — those track the
 * opportunity's approve/reject review, a separate lifecycle from icon
 * review, and overwriting them here would clobber that history.
 */
export async function approveIcon(id: number, _reviewedBy: string): Promise<AdminOpportunityDTO | null> {
  const existing = await db.select().from(opportunities).where(eq(opportunities.id, id));
  if (existing.length === 0) return null;
  const pending = existing[0].iconPendingUrl;
  await db
    .update(opportunities)
    .set({
      iconUrl: pending,
      iconPendingUrl: null,
      updatedAt: sql`now()`,
    })
    .where(eq(opportunities.id, id));
  return getByIdForAdmin(id);
}

/** ADMIN-ONLY: discard the pending icon submission without touching the live icon. See approveIcon() note re: reviewedBy. */
export async function rejectIcon(id: number, _reviewedBy: string): Promise<AdminOpportunityDTO | null> {
  const existing = await db.select().from(opportunities).where(eq(opportunities.id, id));
  if (existing.length === 0) return null;
  await db
    .update(opportunities)
    .set({
      iconPendingUrl: null,
      updatedAt: sql`now()`,
    })
    .where(eq(opportunities.id, id));
  return getByIdForAdmin(id);
}

// ---- Reviews (Addition 3) ----
// Anonymous, structured, text-only reviews. No rating field — see
// BUILD_NOTES.md. Follows the same public/admin split as opportunities:
// getApprovedReviews() is the ONLY sanctioned public read path (status is
// hardcoded to 'approved', not a caller-controlled filter) and
// getReviewsForAdmin()/mutation helpers are admin-only.

export interface ReviewDTO {
  id: string;
  opportunityId: number;
  timeCommitment: string;
  beforeApplying: string;
  adviceNewMember: string;
  status: ReviewStatus;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

function toReviewDTO(r: typeof reviews.$inferSelect): ReviewDTO {
  return {
    id: r.id,
    opportunityId: r.opportunityId,
    timeCommitment: r.timeCommitment,
    beforeApplying: r.beforeApplying,
    adviceNewMember: r.adviceNewMember,
    status: r.status,
    createdAt: r.createdAt,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
  };
}

export interface ReviewSubmissionInput {
  opportunityId: number;
  timeCommitment: string;
  beforeApplying: string;
  adviceNewMember: string;
}

/**
 * Public submission path. Deliberately accepts and stores NOTHING that
 * could identify the submitter — no name/email/IP/user-agent field exists
 * on the `reviews` table, so there is structurally nothing here to persist
 * beyond the three text answers.
 */
export async function insertReview(input: ReviewSubmissionInput): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(reviews).values({
    id,
    opportunityId: input.opportunityId,
    timeCommitment: input.timeCommitment,
    beforeApplying: input.beforeApplying,
    adviceNewMember: input.adviceNewMember,
    status: "pending",
  });
  return id;
}

/**
 * The only sanctioned public-read path for reviews. status = 'approved' is
 * hardcoded — there is no way for a caller to request pending/rejected rows.
 * Most-recent-first.
 */
export async function getApprovedReviews(opportunityId: number): Promise<ReviewDTO[]> {
  const rows = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.opportunityId, opportunityId), eq(reviews.status, "approved" as const)))
    .orderBy(desc(reviews.createdAt));
  return rows.map(toReviewDTO);
}

/**
 * The only sanctioned public-read path for a single review by id — used by
 * the dispute/flag endpoint to confirm the target is actually a published
 * (approved) review before accepting a report against it. status =
 * 'approved' is hardcoded, same as getApprovedReviews().
 */
export async function getApprovedReviewById(id: string): Promise<ReviewDTO | null> {
  const rows = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.id, id), eq(reviews.status, "approved" as const)));
  return rows.length ? toReviewDTO(rows[0]) : null;
}

/** ADMIN-ONLY: list reviews for the moderation queue, optionally by status. */
export async function getReviewsForAdmin(
  filters: { status?: ReviewStatus } = {}
): Promise<(ReviewDTO & { opportunityName: string })[]> {
  const conditions = filters.status ? [eq(reviews.status, filters.status)] : [];
  const rows = await db
    .select({
      review: reviews,
      opportunityName: opportunities.name,
    })
    .from(reviews)
    .innerJoin(opportunities, eq(reviews.opportunityId, opportunities.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reviews.createdAt));
  return rows.map((r) => ({ ...toReviewDTO(r.review), opportunityName: r.opportunityName }));
}

async function getReviewById(id: string): Promise<typeof reviews.$inferSelect | null> {
  const rows = await db.select().from(reviews).where(eq(reviews.id, id));
  return rows[0] ?? null;
}

/** ADMIN-ONLY: approve a pending review, stamping reviewedBy/reviewedAt. */
export async function approveReview(id: string, reviewedBy: string): Promise<ReviewDTO | null> {
  if (!(await getReviewById(id))) return null;
  await db
    .update(reviews)
    .set({ status: "approved", reviewedBy, reviewedAt: sql`now()` })
    .where(eq(reviews.id, id));
  return toReviewDTO((await getReviewById(id))!);
}

/** ADMIN-ONLY: reject a review, stamping reviewedBy/reviewedAt. */
export async function rejectReview(id: string, reviewedBy: string): Promise<ReviewDTO | null> {
  if (!(await getReviewById(id))) return null;
  await db
    .update(reviews)
    .set({ status: "rejected", reviewedBy, reviewedAt: sql`now()` })
    .where(eq(reviews.id, id));
  return toReviewDTO((await getReviewById(id))!);
}

// ---- Reports (Addition 3) ----
// Minimal reports mechanism, built now to support the review-dispute flow.
// See BUILD_NOTES.md — this duplicates in-progress work on
// worktree-reports-and-vip-search and will need reconciliation later.

export interface ReportDTO {
  id: number;
  opportunityId: number | null;
  reviewId: string | null;
  category: ReportCategory;
  details: string;
  reporterContact: string | null;
  status: ReportStatus;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

function toReportDTO(r: typeof reports.$inferSelect): ReportDTO {
  return {
    id: r.id,
    opportunityId: r.opportunityId,
    reviewId: r.reviewId,
    category: r.category,
    details: r.details,
    reporterContact: r.reporterContact,
    status: r.status,
    createdAt: r.createdAt,
    resolvedBy: r.resolvedBy,
    resolvedAt: r.resolvedAt,
  };
}

export interface ReportInput {
  opportunityId?: number | null;
  reviewId?: string | null;
  category: ReportCategory;
  details?: string;
  reporterContact?: string | null;
}

/** Public submission path (no auth). Used for both opportunity reports and review disputes. */
export async function insertReport(input: ReportInput): Promise<number> {
  const [row] = await db
    .insert(reports)
    .values({
      opportunityId: input.opportunityId ?? null,
      reviewId: input.reviewId ?? null,
      category: input.category,
      details: input.details ?? "",
      reporterContact: input.reporterContact ?? null,
      status: "open",
    })
    .returning({ id: reports.id });
  return row.id;
}

/** ADMIN-ONLY: list reports for the moderation queue, optionally by status. */
export async function getReportsForAdmin(filters: { status?: ReportStatus } = {}): Promise<ReportDTO[]> {
  const conditions = filters.status ? [eq(reports.status, filters.status)] : [];
  const rows = await db
    .select()
    .from(reports)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reports.createdAt));
  return rows.map(toReportDTO);
}

/** ADMIN-ONLY: mark a report resolved, stamping resolvedBy/resolvedAt. */
export async function resolveReport(id: number, resolvedBy: string): Promise<ReportDTO | null> {
  const existing = await db.select().from(reports).where(eq(reports.id, id));
  if (existing.length === 0) return null;
  await db
    .update(reports)
    .set({ status: "resolved", resolvedBy, resolvedAt: sql`now()` })
    .where(eq(reports.id, id));
  const rows = await db.select().from(reports).where(eq(reports.id, id));
  return toReportDTO(rows[0]);
}

// ---- Links (additional org links beyond "how to apply") ----
// `opportunities.link` remains the single primary "how to apply" link; this
// table holds ADDITIONAL links per opportunity. Follows the same
// public/admin split as reviews: getApprovedLinks() is the ONLY sanctioned
// public read path (status is hardcoded to 'approved', not a
// caller-controlled filter) and getLinksForAdmin()/mutation helpers are
// admin-only.

export interface LinkDTO {
  id: number;
  opportunityId: number;
  label: string;
  url: string;
  type: LinkType;
  status: LinkStatus;
  submittedBy: string | null;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

// ---- Suggested edits (Addition: suggest edits on existing listings) ----
// Public "propose a correction" flow scoped to a single field
// (name|description|link|majors — enforced as a fixed allowlist at the
// route layer, see backend/src/routes/public.ts) on an existing, publicly
// visible opportunity. Same public/admin split as reviews/reports:
// insertSuggestedEdit() is the only sanctioned public write path, and it
// reads the CURRENT field value server-side (never trusts a client-supplied
// oldValue) so the admin queue can show an accurate before/after even if the
// live row changes again before review.

export type SuggestableField = "name" | "description" | "link" | "majors";
export const SUGGESTABLE_FIELDS: SuggestableField[] = ["name", "description", "link", "majors"];

export interface SuggestedEditDTO {
  id: number;
  opportunityId: number;
  field: string;
  oldValue: string | null;
  newValue: string;
  submittedBy: string | null;
  status: SuggestedEditStatus;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

function toLinkDTO(r: typeof links.$inferSelect): LinkDTO {
  return {
    id: r.id,
    opportunityId: r.opportunityId,
    label: r.label,
    url: r.url,
    type: r.type,
    status: r.status,
    submittedBy: r.submittedBy,
    createdAt: r.createdAt,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
  };
}

function toSuggestedEditDTO(r: typeof suggestedEdits.$inferSelect): SuggestedEditDTO {
  return {
    id: r.id,
    opportunityId: r.opportunityId,
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
    submittedBy: r.submittedBy,
    status: r.status,
    createdAt: r.createdAt,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
  };
}

export interface LinkSubmissionInput {
  opportunityId: number;
  label: string;
  url: string;
  type: LinkType;
  submittedBy?: string | null;
}

/**
 * Public submission path: always status='pending'. Callers (routes) MUST
 * validate `type` is one of LINK_TYPES before calling this — no validation
 * happens here.
 */
export async function insertLinkSubmission(input: LinkSubmissionInput): Promise<number> {
  const [row] = await db
    .insert(links)
    .values({
      opportunityId: input.opportunityId,
      label: input.label,
      url: input.url,
      type: input.type,
      status: "pending",
      submittedBy: input.submittedBy ?? null,
    })
    .returning({ id: links.id });
  return row.id;
}

/**
 * The only sanctioned public-read path for links. status = 'approved' is
 * hardcoded — there is no way for a caller to request pending/rejected
 * rows. `apply`-typed rows are ADDITIONAL apply-adjacent links (the primary
 * how-to-apply link lives on `opportunities.link`), ordered first, then by
 * creation order.
 */
export async function getApprovedLinks(opportunityId: number): Promise<LinkDTO[]> {
  const rows = await db
    .select()
    .from(links)
    .where(and(eq(links.opportunityId, opportunityId), eq(links.status, "approved" as const)))
    .orderBy(links.createdAt);
  return rows
    .map(toLinkDTO)
    .sort((a, b) => (a.type === "apply" ? -1 : 0) - (b.type === "apply" ? -1 : 0));
}

/** ADMIN-ONLY: list links for the moderation queue, optionally by status. */
export async function getLinksForAdmin(
  filters: { status?: LinkStatus } = {}
): Promise<(LinkDTO & { opportunityName: string })[]> {
  const conditions = filters.status ? [eq(links.status, filters.status)] : [];
  const rows = await db
    .select({
      link: links,
      opportunityName: opportunities.name,
    })
    .from(links)
    .innerJoin(opportunities, eq(links.opportunityId, opportunities.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(links.createdAt));
  return rows.map((r) => ({ ...toLinkDTO(r.link), opportunityName: r.opportunityName }));
}

async function getLinkById(id: number): Promise<typeof links.$inferSelect | null> {
  const rows = await db.select().from(links).where(eq(links.id, id));
  return rows[0] ?? null;
}

/** ADMIN-ONLY: approve a pending link, stamping reviewedBy/reviewedAt. */
export async function approveLink(id: number, reviewedBy: string): Promise<LinkDTO | null> {
  if (!(await getLinkById(id))) return null;
  await db
    .update(links)
    .set({ status: "approved", reviewedBy, reviewedAt: sql`now()` })
    .where(eq(links.id, id));
  return toLinkDTO((await getLinkById(id))!);
}

/** ADMIN-ONLY: reject a link, stamping reviewedBy/reviewedAt. */
export async function rejectLink(id: number, reviewedBy: string): Promise<LinkDTO | null> {
  if (!(await getLinkById(id))) return null;
  await db
    .update(links)
    .set({ status: "rejected", reviewedBy, reviewedAt: sql`now()` })
    .where(eq(links.id, id));
  return toLinkDTO((await getLinkById(id))!);
}

// ---- Related organizations (embedding-based, cross-category) ----
// Read-only accessor over the `related_opportunities` cache table (see
// schema.ts / backend/src/lib/related-opportunities.ts). Never computed
// live here — recomputeRelated() is the only writer, called on
// create/edit/reclassify (vip.ts, engage-classify.ts, approveOpportunity()/
// updateOpportunity() above).

/**
 * The only sanctioned public-read path for related orgs: joins the cache
 * table to `opportunities` and only returns rows that are currently
 * `approved` — reuses the same approved-only discipline as getPublic(),
 * important because a cached related row can point at an opportunity that
 * was approved when the cache was computed but has since been unpublished.
 * Ordered by rank (1 = most related). Never exposes the raw `embedding`
 * column — same OpportunityDTO shape as every other read path, minus that
 * field (OpportunityDTO never included it to begin with).
 */
export async function getRelatedOpportunities(opportunityId: number): Promise<OpportunityDTO[]> {
  const rows = await db
    .select({ opportunity: opportunities, rank: relatedOpportunities.rank })
    .from(relatedOpportunities)
    .innerJoin(opportunities, eq(relatedOpportunities.relatedOpportunityId, opportunities.id))
    .where(and(eq(relatedOpportunities.opportunityId, opportunityId), eq(opportunities.status, "approved" as const)))
    .orderBy(asc(relatedOpportunities.rank));

  return attachTags(rows.map((r) => r.opportunity));
}

export interface SuggestedEditInput {
  opportunityId: number;
  field: SuggestableField;
  newValue: string;
  submittedBy?: string | null;
}

export type InsertSuggestedEditResult =
  | { ok: true; id: number; status: "pending" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "noop" };

/**
 * Public submission path. Looks up the opportunity via getPublic() (must be
 * approved/publicly visible — same "404, don't leak pending/rejected rows"
 * convention as the reviews submission path) and reads the field's CURRENT
 * value server-side to populate `oldValue`. A submission whose `newValue`
 * exactly matches the current value is rejected as a no-op (the route turns
 * that into a 400) instead of creating a pointless pending row.
 */
export async function insertSuggestedEdit(input: SuggestedEditInput): Promise<InsertSuggestedEditResult> {
  const rows = await db.select().from(opportunities).where(eq(opportunities.id, input.opportunityId));
  const row = rows[0];
  if (!row || row.status !== "approved") return { ok: false, reason: "not_found" };

  // Raw column values are already the on-the-wire representation for every
  // suggestable field (majors is stored TEXT-serialized JSON already, same
  // shape a caller is expected to submit as `newValue`) — no accessor
  // round-trip needed to snapshot `oldValue`.
  const oldValue: string | null = row[input.field] ?? null;

  if (input.newValue === oldValue) return { ok: false, reason: "noop" };

  const [inserted] = await db
    .insert(suggestedEdits)
    .values({
      opportunityId: input.opportunityId,
      field: input.field,
      oldValue,
      newValue: input.newValue,
      submittedBy: input.submittedBy ?? null,
      status: "pending",
    })
    .returning({ id: suggestedEdits.id });

  return { ok: true, id: inserted.id, status: "pending" };
}

/** ADMIN-ONLY: list suggested edits for the moderation queue, optionally by status. */
export async function getSuggestedEditsForAdmin(
  filters: { status?: SuggestedEditStatus } = {}
): Promise<(SuggestedEditDTO & { opportunityName: string })[]> {
  const conditions = filters.status ? [eq(suggestedEdits.status, filters.status)] : [];
  const rows = await db
    .select({
      edit: suggestedEdits,
      opportunityName: opportunities.name,
    })
    .from(suggestedEdits)
    .innerJoin(opportunities, eq(suggestedEdits.opportunityId, opportunities.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(suggestedEdits.createdAt));
  return rows.map((r) => ({ ...toSuggestedEditDTO(r.edit), opportunityName: r.opportunityName }));
}

async function getSuggestedEditById(id: number): Promise<typeof suggestedEdits.$inferSelect | null> {
  const rows = await db.select().from(suggestedEdits).where(eq(suggestedEdits.id, id));
  return rows[0] ?? null;
}

/**
 * ADMIN-ONLY: approve a pending suggested edit — writes `newValue` into the
 * live opportunities row's `field` column (majors round-trips through
 * setMajors/JSON.parse; every other suggestable field is a plain text
 * column write), stamps the suggested_edits row approved, and re-runs
 * refreshSearchBlob() since name/description/majors all feed the search
 * index. The opportunities write + suggested_edits stamp happen in one
 * transaction; refreshSearchBlob runs after (mirrors updateOpportunity()'s
 * shape just above the Reviews section).
 */
export async function approveSuggestedEdit(id: number, reviewedBy: string): Promise<SuggestedEditDTO | null> {
  const existing = await getSuggestedEditById(id);
  if (!existing) return null;

  await db.transaction(async (tx) => {
    const patch: Record<string, unknown> =
      existing.field === "majors" ? { majors: setMajors(JSON.parse(existing.newValue)) } : { [existing.field]: existing.newValue };
    patch.updatedAt = sql`now()`;

    // Same slug-preservation concern as updateOpportunity() above: an
    // approved name-change suggestion must not silently break the live
    // /opportunities/:slug URL.
    if (existing.field === "name") {
      const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, existing.opportunityId));
      if (opp && opp.name !== existing.newValue) {
        patch.slug = await generateUniqueSlug(existing.newValue, existing.opportunityId);
        patch.previousSlug = opp.slug;
      }
    }

    await tx.update(opportunities).set(patch).where(eq(opportunities.id, existing.opportunityId));
    await tx
      .update(suggestedEdits)
      .set({ status: "approved", reviewedBy, reviewedAt: sql`now()` })
      .where(eq(suggestedEdits.id, id));
  });

  await refreshSearchBlob(existing.opportunityId);
  return toSuggestedEditDTO((await getSuggestedEditById(id))!);
}

/** ADMIN-ONLY: reject a pending suggested edit, stamping reviewedBy/reviewedAt. No write to the live row. */
export async function rejectSuggestedEdit(id: number, reviewedBy: string): Promise<SuggestedEditDTO | null> {
  if (!(await getSuggestedEditById(id))) return null;
  await db
    .update(suggestedEdits)
    .set({ status: "rejected", reviewedBy, reviewedAt: sql`now()` })
    .where(eq(suggestedEdits.id, id));
  return toSuggestedEditDTO((await getSuggestedEditById(id))!);
}

// ---- Club/VIP leader access (Module 1 of 7) ----
// Pure data layer for the shared-account-per-org leader access feature: no
// HTTP routes, no token generation/hashing, no business logic — just typed
// CRUD over the six tables added in schema.ts (opportunity_access,
// access_requests, magic_links, sessions, audit_log). Token/session
// generation and route-level auth enforcement belong to later modules; every
// function below trusts its caller to have already produced/verified
// whatever it's passed (e.g. `tokenHash` is assumed to already be a SHA-256
// hex hash, never a raw token).

export interface AccessRequestDTO {
  id: number;
  opportunityId: number;
  requesterName: string;
  requesterContact: string;
  note: string | null;
  status: AccessRequestStatus;
  createdAt: string;
  reviewedAt: string | null;
}

function toAccessRequestDTO(r: typeof accessRequests.$inferSelect): AccessRequestDTO {
  return {
    id: r.id,
    opportunityId: r.opportunityId,
    requesterName: r.requesterName,
    requesterContact: r.requesterContact,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt,
  };
}

export interface AccessRequestInput {
  opportunityId: number;
  requesterName: string;
  requesterContact: string;
  note?: string | null;
}

/** Creates a pending access_requests row. Does not touch opportunity_access. */
export async function createAccessRequest(input: AccessRequestInput): Promise<AccessRequestDTO> {
  const [row] = await db
    .insert(accessRequests)
    .values({
      opportunityId: input.opportunityId,
      requesterName: input.requesterName,
      requesterContact: input.requesterContact,
      note: input.note ?? null,
      status: "pending",
    })
    .returning();
  return toAccessRequestDTO(row);
}

/** Fetches a single access_requests row by id, or null if not found. */
export async function getAccessRequest(id: number): Promise<AccessRequestDTO | null> {
  const rows = await db.select().from(accessRequests).where(eq(accessRequests.id, id));
  return rows.length ? toAccessRequestDTO(rows[0]) : null;
}

/** Lists all access_requests for one opportunity, optionally filtered by status, most-recent-first. */
export async function listAccessRequestsForOpportunity(
  opportunityId: number,
  filters: { status?: AccessRequestStatus } = {}
): Promise<AccessRequestDTO[]> {
  const conditions = [eq(accessRequests.opportunityId, opportunityId)];
  if (filters.status) conditions.push(eq(accessRequests.status, filters.status));
  const rows = await db
    .select()
    .from(accessRequests)
    .where(and(...conditions))
    .orderBy(desc(accessRequests.createdAt));
  return rows.map(toAccessRequestDTO);
}

/** Updates an access_requests row's status, stamping reviewedAt. Returns null if not found. */
export async function updateAccessRequestStatus(
  id: number,
  status: AccessRequestStatus
): Promise<AccessRequestDTO | null> {
  const existing = await getAccessRequest(id);
  if (!existing) return null;
  await db
    .update(accessRequests)
    .set({ status, reviewedAt: sql`now()` })
    .where(eq(accessRequests.id, id));
  return getAccessRequest(id);
}

export interface OpportunityAccessDTO {
  id: number;
  opportunityId: number;
  status: AccessStatus;
  createdAt: string;
  revokedAt: string | null;
}

function toOpportunityAccessDTO(r: typeof opportunityAccess.$inferSelect): OpportunityAccessDTO {
  return {
    id: r.id,
    opportunityId: r.opportunityId,
    status: r.status,
    createdAt: r.createdAt,
    revokedAt: r.revokedAt,
  };
}

/** Creates a new opportunity_access row (defaults to status='active'). Does not dedupe against existing rows for the same opportunity — callers should check getActiveAccessForOpportunity() first if a single shared row is desired. */
export async function createOpportunityAccess(opportunityId: number): Promise<OpportunityAccessDTO> {
  const [row] = await db.insert(opportunityAccess).values({ opportunityId, status: "active" }).returning();
  return toOpportunityAccessDTO(row);
}

/** Fetches the most recently created opportunity_access row for an opportunity, regardless of status, or null if none exists. */
export async function getOpportunityAccess(opportunityId: number): Promise<OpportunityAccessDTO | null> {
  const rows = await db
    .select()
    .from(opportunityAccess)
    .where(eq(opportunityAccess.opportunityId, opportunityId))
    .orderBy(desc(opportunityAccess.createdAt));
  return rows.length ? toOpportunityAccessDTO(rows[0]) : null;
}

/** Flips an opportunity_access row's status (active <-> revoked), stamping revokedAt when revoking. Returns null if not found. */
export async function setOpportunityAccessStatus(
  id: number,
  status: AccessStatus
): Promise<OpportunityAccessDTO | null> {
  const rows = await db.select().from(opportunityAccess).where(eq(opportunityAccess.id, id));
  if (rows.length === 0) return null;
  await db
    .update(opportunityAccess)
    .set({ status, revokedAt: status === "revoked" ? sql`now()` : null })
    .where(eq(opportunityAccess.id, id));
  const updated = await db.select().from(opportunityAccess).where(eq(opportunityAccess.id, id));
  return toOpportunityAccessDTO(updated[0]);
}

/** Helper: the currently-active opportunity_access row for an opportunity, or null if none/all revoked. */
export async function getActiveAccessForOpportunity(opportunityId: number): Promise<OpportunityAccessDTO | null> {
  const rows = await db
    .select()
    .from(opportunityAccess)
    .where(and(eq(opportunityAccess.opportunityId, opportunityId), eq(opportunityAccess.status, "active" as const)))
    .orderBy(desc(opportunityAccess.createdAt));
  return rows.length ? toOpportunityAccessDTO(rows[0]) : null;
}

/** Helper: true if the opportunity currently has an active opportunity_access row. */
export async function hasActiveAccess(opportunityId: number): Promise<boolean> {
  return (await getActiveAccessForOpportunity(opportunityId)) !== null;
}

/** Helper: all pending access_requests for an opportunity, most-recent-first. */
export async function getPendingRequestsForOpportunity(opportunityId: number): Promise<AccessRequestDTO[]> {
  return listAccessRequestsForOpportunity(opportunityId, { status: "pending" });
}

export interface MagicLinkDTO {
  id: number;
  opportunityId: number;
  tokenHash: string;
  purpose: MagicLinkPurpose;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

function toMagicLinkDTO(r: typeof magicLinks.$inferSelect): MagicLinkDTO {
  return {
    id: r.id,
    opportunityId: r.opportunityId,
    tokenHash: r.tokenHash,
    purpose: r.purpose,
    expiresAt: r.expiresAt,
    usedAt: r.usedAt,
    createdAt: r.createdAt,
  };
}

export interface MagicLinkInput {
  opportunityId: number;
  tokenHash: string;
  purpose: MagicLinkPurpose;
  expiresAt: string;
}

/** Creates a magic_links row. `tokenHash` must already be the SHA-256 hex hash of the raw token — hashing is not this module's job. */
export async function createMagicLink(input: MagicLinkInput): Promise<MagicLinkDTO> {
  const [row] = await db
    .insert(magicLinks)
    .values({
      opportunityId: input.opportunityId,
      tokenHash: input.tokenHash,
      purpose: input.purpose,
      expiresAt: input.expiresAt,
    })
    .returning();
  return toMagicLinkDTO(row);
}

/** Looks up a magic_links row by its token hash (unique). Callers are responsible for checking expiresAt/usedAt themselves. */
export async function getMagicLinkByTokenHash(tokenHash: string): Promise<MagicLinkDTO | null> {
  const rows = await db.select().from(magicLinks).where(eq(magicLinks.tokenHash, tokenHash));
  return rows.length ? toMagicLinkDTO(rows[0]) : null;
}

/** Stamps a magic_links row as used (usedAt = now). Returns null if not found. */
export async function markMagicLinkUsed(id: number): Promise<MagicLinkDTO | null> {
  const rows = await db.select().from(magicLinks).where(eq(magicLinks.id, id));
  if (rows.length === 0) return null;
  await db.update(magicLinks).set({ usedAt: sql`now()` }).where(eq(magicLinks.id, id));
  const updated = await db.select().from(magicLinks).where(eq(magicLinks.id, id));
  return toMagicLinkDTO(updated[0]);
}

export interface SessionDTO {
  id: number;
  opportunityId: number;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

function toSessionDTO(r: typeof sessions.$inferSelect): SessionDTO {
  return {
    id: r.id,
    opportunityId: r.opportunityId,
    tokenHash: r.tokenHash,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  };
}

export interface SessionInput {
  opportunityId: number;
  tokenHash: string;
  expiresAt: string;
}

/** Creates a sessions row. `tokenHash` must already be the SHA-256 hex hash of the raw session token. */
export async function createSession(input: SessionInput): Promise<SessionDTO> {
  const [row] = await db
    .insert(sessions)
    .values({
      opportunityId: input.opportunityId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    })
    .returning();
  return toSessionDTO(row);
}

/** Looks up a sessions row by its token hash (unique). Callers are responsible for checking expiresAt/revokedAt themselves. */
export async function getSessionByTokenHash(tokenHash: string): Promise<SessionDTO | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash));
  return rows.length ? toSessionDTO(rows[0]) : null;
}

/** Revokes a single session by id, stamping revokedAt. Returns null if not found. */
export async function revokeSession(id: number): Promise<SessionDTO | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, id));
  if (rows.length === 0) return null;
  await db.update(sessions).set({ revokedAt: sql`now()` }).where(eq(sessions.id, id));
  const updated = await db.select().from(sessions).where(eq(sessions.id, id));
  return toSessionDTO(updated[0]);
}

/** Revokes every currently-unrevoked session for an opportunity (e.g. on access revocation). Returns the count revoked. */
export async function revokeAllSessionsForOpportunity(opportunityId: number): Promise<number> {
  const result = await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.opportunityId, opportunityId), sql`${sessions.revokedAt} IS NULL`))
    .returning({ id: sessions.id });
  return result.length;
}

/** Lists sessions for an opportunity that are neither revoked nor expired, most-recent-first. */
export async function listActiveSessionsForOpportunity(opportunityId: number): Promise<SessionDTO[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.opportunityId, opportunityId),
        sql`${sessions.revokedAt} IS NULL`,
        sql`${sessions.expiresAt} > now()`
      )
    )
    .orderBy(desc(sessions.createdAt));
  return rows.map(toSessionDTO);
}

export interface AuditLogDTO {
  id: number;
  opportunityId: number;
  actor: string;
  action: string;
  fieldChanged: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

function toAuditLogDTO(r: typeof auditLog.$inferSelect): AuditLogDTO {
  return {
    id: r.id,
    opportunityId: r.opportunityId,
    actor: r.actor,
    action: r.action,
    fieldChanged: r.fieldChanged,
    oldValue: r.oldValue,
    newValue: r.newValue,
    createdAt: r.createdAt,
  };
}

export interface AuditLogInput {
  opportunityId: number;
  actor: string;
  action: string;
  fieldChanged?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
}

/** Append-only: inserts one audit_log row. Never updates/deletes existing rows. */
export async function appendAuditLog(input: AuditLogInput): Promise<AuditLogDTO> {
  const [row] = await db
    .insert(auditLog)
    .values({
      opportunityId: input.opportunityId,
      actor: input.actor,
      action: input.action,
      fieldChanged: input.fieldChanged ?? null,
      oldValue: input.oldValue ?? null,
      newValue: input.newValue ?? null,
    })
    .returning();
  return toAuditLogDTO(row);
}

/** Lists audit_log rows for an opportunity, most-recent-first, optionally filtered by actor and/or action. */
export async function listAuditLogForOpportunity(
  opportunityId: number,
  filters: { actor?: string; action?: string } = {}
): Promise<AuditLogDTO[]> {
  const conditions = [eq(auditLog.opportunityId, opportunityId)];
  if (filters.actor) conditions.push(eq(auditLog.actor, filters.actor));
  if (filters.action) conditions.push(eq(auditLog.action, filters.action));
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt));
  return rows.map(toAuditLogDTO);
}

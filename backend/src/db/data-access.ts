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
  type OpportunityType,
  type OpportunityStatus,
  type ReviewStatus,
  type ReportCategory,
  type ReportStatus,
  type LinkType,
  type LinkStatus,
  type SuggestedEditStatus,
} from "./schema.js";
import { getMajors, getMeta, setMajors, setMeta, getDetails, buildSearchBlob } from "./json-columns.js";
import { embedOpportunity } from "../lib/embeddings.js";
import { recomputeRelated } from "../lib/related-opportunities.js";

export interface OpportunityDTO {
  id: number;
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
  const [row] = await db
    .insert(opportunities)
    .values({
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
  if (fields.name !== undefined) patch.name = fields.name;
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

// Data-access layer. `getPublic` is the ONLY sanctioned read path for
// public-facing routes/tests — it hardcodes status = 'approved' inside the
// query itself, so a caller cannot override it via params (there is no status
// param on its filter type at all). Anything that needs to see
// pending/rejected rows MUST go through `getForAdmin`, which is named to make
// misuse from a public route obvious in review.
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  opportunities,
  opportunityTags,
  tags,
  reviews,
  reports,
  type OpportunityType,
  type OpportunityStatus,
  type ReviewStatus,
  type ReportCategory,
  type ReportStatus,
} from "./schema.js";
import { getMajors, getMeta, setMajors, setMeta } from "./json-columns.js";

export interface OpportunityDTO {
  id: number;
  type: OpportunityType;
  name: string;
  description: string;
  majors: string[];
  link: string | null;
  meta: Record<string, unknown>;
  source: string;
  status: OpportunityStatus;
  submittedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  lastVerified: string | null;
  createdAt: string;
  updatedAt: string;
  tags: { slug: string; label: string; category: string }[];
}

function attachTags(rows: (typeof opportunities.$inferSelect)[]): OpportunityDTO[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const tagRows = db
    .select({
      opportunityId: opportunityTags.opportunityId,
      slug: tags.slug,
      label: tags.label,
      category: tags.category,
    })
    .from(opportunityTags)
    .innerJoin(tags, eq(opportunityTags.tagId, tags.id))
    .where(inArray(opportunityTags.opportunityId, ids))
    .all();

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
    source: r.source,
    status: r.status,
    submittedBy: r.submittedBy,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
    lastVerified: r.lastVerified,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    tags: tagsByOpportunity.get(r.id) ?? [],
  }));
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
export function getPublic(filters: PublicFilters = {}): OpportunityDTO[] {
  const conditions = [eq(opportunities.status, "approved" as const)];

  if (filters.type) {
    conditions.push(eq(opportunities.type, filters.type));
  }
  if (filters.search) {
    const needle = `%${filters.search}%`;
    conditions.push(
      or(like(opportunities.name, needle), like(opportunities.description, needle))!
    );
  }

  let rows = db
    .select()
    .from(opportunities)
    .where(and(...conditions))
    .all();

  if (filters.tagSlugs && filters.tagSlugs.length > 0) {
    const matchIds = new Set(
      db
        .select({ opportunityId: opportunityTags.opportunityId })
        .from(opportunityTags)
        .innerJoin(tags, eq(opportunityTags.tagId, tags.id))
        .where(inArray(tags.slug, filters.tagSlugs))
        .all()
        .map((r) => r.opportunityId)
    );
    rows = rows.filter((r) => matchIds.has(r.id));
  }

  return attachTags(rows);
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
export function getForAdmin(filters: AdminFilters = {}): OpportunityDTO[] {
  const conditions = [];
  if (filters.status) conditions.push(eq(opportunities.status, filters.status));
  if (filters.type) conditions.push(eq(opportunities.type, filters.type));
  if (filters.search) {
    const needle = `%${filters.search}%`;
    conditions.push(
      or(like(opportunities.name, needle), like(opportunities.description, needle))!
    );
  }

  const rows = db
    .select()
    .from(opportunities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .all();

  return attachTags(rows);
}

export function getAllTags() {
  return db.select().from(tags).all();
}

// ---- Mutation helpers (submission + admin review flows) ----
// These are the sanctioned write paths so routes never build drizzle
// queries against `opportunities` inline.

function tagIdsForSlugs(slugs: string[]): number[] {
  if (slugs.length === 0) return [];
  return db
    .select({ id: tags.id })
    .from(tags)
    .where(inArray(tags.slug, slugs))
    .all()
    .map((r) => r.id);
}

function replaceTagLinks(opportunityId: number, tagSlugs: string[]): void {
  db.delete(opportunityTags).where(eq(opportunityTags.opportunityId, opportunityId)).run();
  const ids = tagIdsForSlugs(tagSlugs);
  for (const tagId of ids) {
    db.insert(opportunityTags).values({ opportunityId, tagId }).run();
  }
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
export function insertSubmission(input: SubmissionInput): number {
  const result = db
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
    .run();

  const id = Number(result.lastInsertRowid);
  if (input.tagSlugs && input.tagSlugs.length > 0) {
    replaceTagLinks(id, input.tagSlugs);
  }
  return id;
}

/** ADMIN-ONLY: fetch a single row regardless of status. */
export function getByIdForAdmin(id: number): OpportunityDTO | null {
  const rows = db.select().from(opportunities).where(eq(opportunities.id, id)).all();
  if (rows.length === 0) return null;
  return attachTags(rows)[0];
}

/** ADMIN-ONLY: approve a pending/rejected row, stamping reviewedBy/reviewedAt. */
export function approveOpportunity(id: number, reviewedBy: string): OpportunityDTO | null {
  const existing = db.select().from(opportunities).where(eq(opportunities.id, id)).all();
  if (existing.length === 0) return null;
  db.update(opportunities)
    .set({
      status: "approved",
      reviewedBy,
      reviewedAt: sql`(CURRENT_TIMESTAMP)`,
      updatedAt: sql`(CURRENT_TIMESTAMP)`,
    })
    .where(eq(opportunities.id, id))
    .run();
  return getByIdForAdmin(id);
}

/** ADMIN-ONLY: reject a row, stamping reviewedBy/reviewedAt, optional reason into meta. */
export function rejectOpportunity(id: number, reviewedBy: string, reason?: string): OpportunityDTO | null {
  const existing = db.select().from(opportunities).where(eq(opportunities.id, id)).all();
  if (existing.length === 0) return null;
  const row = existing[0];
  const meta = getMeta(row.meta);
  if (reason) meta.rejectionReason = reason;
  db.update(opportunities)
    .set({
      status: "rejected",
      reviewedBy,
      reviewedAt: sql`(CURRENT_TIMESTAMP)`,
      updatedAt: sql`(CURRENT_TIMESTAMP)`,
      meta: setMeta(meta),
    })
    .where(eq(opportunities.id, id))
    .run();
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
export function updateOpportunity(
  id: number,
  fields: EditFields,
  approve: boolean,
  reviewedBy: string
): OpportunityDTO | null {
  const existing = db.select().from(opportunities).where(eq(opportunities.id, id)).all();
  if (existing.length === 0) return null;

  const patch: Record<string, unknown> = { updatedAt: sql`(CURRENT_TIMESTAMP)` };
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.majors !== undefined) patch.majors = setMajors(fields.majors);
  if (fields.link !== undefined) patch.link = fields.link;
  if (fields.type !== undefined) patch.type = fields.type;
  if (approve) {
    patch.status = "approved";
    patch.reviewedBy = reviewedBy;
    patch.reviewedAt = sql`(CURRENT_TIMESTAMP)`;
  }

  db.transaction((tx) => {
    tx.update(opportunities).set(patch).where(eq(opportunities.id, id)).run();
    if (fields.tagSlugs !== undefined) {
      tx.delete(opportunityTags).where(eq(opportunityTags.opportunityId, id)).run();
      const ids = tagIdsForSlugs(fields.tagSlugs!);
      for (const tagId of ids) {
        tx.insert(opportunityTags).values({ opportunityId: id, tagId }).run();
      }
    }
  });

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
export function insertReview(input: ReviewSubmissionInput): string {
  const id = crypto.randomUUID();
  db.insert(reviews)
    .values({
      id,
      opportunityId: input.opportunityId,
      timeCommitment: input.timeCommitment,
      beforeApplying: input.beforeApplying,
      adviceNewMember: input.adviceNewMember,
      status: "pending",
    })
    .run();
  return id;
}

/**
 * The only sanctioned public-read path for reviews. status = 'approved' is
 * hardcoded — there is no way for a caller to request pending/rejected rows.
 * Most-recent-first.
 */
export function getApprovedReviews(opportunityId: number): ReviewDTO[] {
  const rows = db
    .select()
    .from(reviews)
    .where(and(eq(reviews.opportunityId, opportunityId), eq(reviews.status, "approved" as const)))
    .orderBy(desc(reviews.createdAt))
    .all();
  return rows.map(toReviewDTO);
}

/**
 * The only sanctioned public-read path for a single review by id — used by
 * the dispute/flag endpoint to confirm the target is actually a published
 * (approved) review before accepting a report against it. status =
 * 'approved' is hardcoded, same as getApprovedReviews().
 */
export function getApprovedReviewById(id: string): ReviewDTO | null {
  const rows = db
    .select()
    .from(reviews)
    .where(and(eq(reviews.id, id), eq(reviews.status, "approved" as const)))
    .all();
  return rows.length ? toReviewDTO(rows[0]) : null;
}

/** ADMIN-ONLY: list reviews for the moderation queue, optionally by status. */
export function getReviewsForAdmin(filters: { status?: ReviewStatus } = {}): (ReviewDTO & {
  opportunityName: string;
})[] {
  const conditions = filters.status ? [eq(reviews.status, filters.status)] : [];
  const rows = db
    .select({
      review: reviews,
      opportunityName: opportunities.name,
    })
    .from(reviews)
    .innerJoin(opportunities, eq(reviews.opportunityId, opportunities.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reviews.createdAt))
    .all();
  return rows.map((r) => ({ ...toReviewDTO(r.review), opportunityName: r.opportunityName }));
}

function getReviewById(id: string): typeof reviews.$inferSelect | null {
  const rows = db.select().from(reviews).where(eq(reviews.id, id)).all();
  return rows[0] ?? null;
}

/** ADMIN-ONLY: approve a pending review, stamping reviewedBy/reviewedAt. */
export function approveReview(id: string, reviewedBy: string): ReviewDTO | null {
  if (!getReviewById(id)) return null;
  db.update(reviews)
    .set({ status: "approved", reviewedBy, reviewedAt: sql`(CURRENT_TIMESTAMP)` })
    .where(eq(reviews.id, id))
    .run();
  return toReviewDTO(getReviewById(id)!);
}

/** ADMIN-ONLY: reject a review, stamping reviewedBy/reviewedAt. */
export function rejectReview(id: string, reviewedBy: string): ReviewDTO | null {
  if (!getReviewById(id)) return null;
  db.update(reviews)
    .set({ status: "rejected", reviewedBy, reviewedAt: sql`(CURRENT_TIMESTAMP)` })
    .where(eq(reviews.id, id))
    .run();
  return toReviewDTO(getReviewById(id)!);
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
export function insertReport(input: ReportInput): number {
  const result = db
    .insert(reports)
    .values({
      opportunityId: input.opportunityId ?? null,
      reviewId: input.reviewId ?? null,
      category: input.category,
      details: input.details ?? "",
      reporterContact: input.reporterContact ?? null,
      status: "open",
    })
    .run();
  return Number(result.lastInsertRowid);
}

/** ADMIN-ONLY: list reports for the moderation queue, optionally by status. */
export function getReportsForAdmin(filters: { status?: ReportStatus } = {}): ReportDTO[] {
  const conditions = filters.status ? [eq(reports.status, filters.status)] : [];
  const rows = db
    .select()
    .from(reports)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reports.createdAt))
    .all();
  return rows.map(toReportDTO);
}

/** ADMIN-ONLY: mark a report resolved, stamping resolvedBy/resolvedAt. */
export function resolveReport(id: number, resolvedBy: string): ReportDTO | null {
  const existing = db.select().from(reports).where(eq(reports.id, id)).all();
  if (existing.length === 0) return null;
  db.update(reports)
    .set({ status: "resolved", resolvedBy, resolvedAt: sql`(CURRENT_TIMESTAMP)` })
    .where(eq(reports.id, id))
    .run();
  const rows = db.select().from(reports).where(eq(reports.id, id)).all();
  return toReportDTO(rows[0]);
}

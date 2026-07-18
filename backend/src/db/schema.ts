// Drizzle schema for the GT Campus Opportunity Finder.
//
// Dialect note: this targets SQLite (via better-sqlite3) for the overnight build,
// but is written to be mechanically portable to Postgres later:
//   - No SQLite-only types are used.
//   - Array/jsonb-shaped columns (`majors`, `meta`) are stored as TEXT-serialized
//     JSON here, but callers must NEVER JSON.parse/stringify them directly —
//     always go through the typed accessors in `./json-columns.ts`, which is the
//     single place that would change (to native array/jsonb) on a Postgres move.
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const OPPORTUNITY_TYPES = ["vip", "lab", "club"] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const OPPORTUNITY_SOURCES = ["scraped", "curated", "user_submitted"] as const;
export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];

export const OPPORTUNITY_STATUSES = ["approved", "pending", "rejected"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const opportunities = sqliteTable("opportunities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type", { enum: OPPORTUNITY_TYPES }).notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  // TEXT-serialized JSON array of strings. Access via getMajors()/setMajors() in json-columns.ts.
  majors: text("majors").notNull().default("[]"),
  link: text("link"),
  // TEXT-serialized JSON object (jsonb-equivalent). Access via getMeta()/setMeta().
  meta: text("meta").notNull().default("{}"),
  // TEXT-serialized JSON object (jsonb-equivalent) for type-specific structured
  // fields that don't apply across vip/lab/club (e.g. VIP's advisor_email,
  // methods_technologies). Access via getDetails()/setDetails(). Kept separate
  // from `meta` (scraper/admin bookkeeping) because `details` holds
  // human-facing content that also feeds the search index below.
  details: text("details").notNull().default("{}"),
  // Denormalized, precomputed blob of all searchable text (name + description +
  // majors + tag labels + flattened `details` values), kept in sync by the
  // mutation helpers in data-access.ts. This is the SQLite stand-in for a
  // Postgres tsvector generated column: `opportunities_fts` (an FTS5 virtual
  // table, see migrations/0002) indexes this column so search reaches into
  // `details` instead of just `description`.
  searchBlob: text("search_blob").notNull().default(""),
  source: text("source", { enum: OPPORTUNITY_SOURCES }).notNull(),
  status: text("status", { enum: OPPORTUNITY_STATUSES }).notNull().default("pending"),
  submittedBy: text("submitted_by"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: text("reviewed_at"),
  lastVerified: text("last_verified"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
  category: text("category").notNull(),
});

export const opportunityTags = sqliteTable(
  "opportunity_tags",
  {
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.opportunityId, table.tagId] }),
  })
);

// ---- Reviews (Addition 3) ----
// Anonymous, structured, text-only reviews of an opportunity. Deliberately
// NO numeric rating field — see BUILD_NOTES.md for why that's a considered
// omission, not an oversight. Uses a text/uuid PK (crypto.randomUUID()) per
// spec, which deviates from the integer-PK convention used elsewhere.
export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  opportunityId: integer("opportunity_id")
    .notNull()
    .references(() => opportunities.id, { onDelete: "cascade" }),
  timeCommitment: text("time_commitment").notNull(),
  beforeApplying: text("before_applying").notNull(),
  adviceNewMember: text("advice_new_member").notNull(),
  status: text("status", { enum: REVIEW_STATUSES }).notNull().default("pending"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  reviewedBy: text("reviewed_by"),
  reviewedAt: text("reviewed_at"),
});

// ---- Reports (Addition 3) ----
// NOTE: a `reports` table is also being prototyped, independently and not
// yet merged, on `worktree-reports-and-vip-search`. This copy was created
// here because the review-dispute flow needed it wired now. Shape matches
// that branch's prototype as closely as possible (plus a nullable
// `review_id` column this feature needs) to ease future reconciliation —
// see BUILD_NOTES.md.
export const REPORT_CATEGORIES = ["outdated_info", "broken_link", "wrong_contact", "other"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_STATUSES = ["open", "resolved"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  opportunityId: integer("opportunity_id").references(() => opportunities.id, { onDelete: "cascade" }),
  reviewId: text("review_id").references(() => reviews.id, { onDelete: "cascade" }),
  category: text("category", { enum: REPORT_CATEGORIES }).notNull(),
  details: text("details").notNull().default(""),
  reporterContact: text("reporter_contact"), // optional, no login required
  status: text("status", { enum: REPORT_STATUSES }).notNull().default("open"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  resolvedBy: text("resolved_by"),
  resolvedAt: text("resolved_at"),
});

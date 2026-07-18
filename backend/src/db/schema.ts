// Drizzle schema for the GT Campus Opportunity Finder — Postgres (Neon) dialect.
//
// Ported from the original SQLite schema (see git history / BUILD_NOTES.md
// "Addition 5: Railway deployment" for why that port was originally
// deferred). Notes on the port:
//   - `majors` / `meta` / `details` are native `jsonb` here (were
//     TEXT-serialized JSON under SQLite). Callers must still never touch
//     these columns' shape directly — go through the typed accessors in
//     `./json-columns.ts`, which now just normalize jsonb values that the
//     driver already parses/serializes for us.
//   - Timestamps use Postgres `timestamp` columns in `{ mode: "string" }` so
//     the rest of the codebase (DTOs typed as `string`) is unaffected.
//   - There is no Postgres equivalent of SQLite's FTS5 virtual table wired
//     up here; full-text search now runs at query time against
//     `search_blob` via `to_tsvector(...) @@ plainto_tsquery(...)` in
//     `data-access.ts`, backed by a GIN expression index (see migrations).
import { pgTable, text, integer, timestamp, jsonb, primaryKey, serial, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const OPPORTUNITY_TYPES = ["vip", "lab", "club"] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const OPPORTUNITY_SOURCES = ["scraped", "curated", "user_submitted"] as const;
export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];

export const OPPORTUNITY_STATUSES = ["approved", "pending", "rejected"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const opportunities = pgTable(
  "opportunities",
  {
    id: serial("id").primaryKey(),
    type: text("type", { enum: OPPORTUNITY_TYPES }).notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // jsonb array of strings. Access via getMajors()/setMajors() in json-columns.ts.
    majors: jsonb("majors").notNull().default(sql`'[]'::jsonb`),
    link: text("link"),
    // jsonb object. Access via getMeta()/setMeta().
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    // jsonb object for type-specific structured fields that don't apply
    // across vip/lab/club (e.g. VIP's advisor_email, methods_technologies).
    // Access via getDetails()/setDetails(). Kept separate from `meta`
    // (scraper/admin bookkeeping) because `details` holds human-facing
    // content that also feeds the search index below.
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    // Denormalized, precomputed blob of all searchable text (name + description +
    // majors + tag labels + flattened `details` values), kept in sync by the
    // mutation helpers in data-access.ts. Indexed by the GIN expression index
    // below over `to_tsvector('english', search_blob)`.
    searchBlob: text("search_blob").notNull().default(""),
    source: text("source", { enum: OPPORTUNITY_SOURCES }).notNull(),
    status: text("status", { enum: OPPORTUNITY_STATUSES }).notNull().default("pending"),
    submittedBy: text("submitted_by"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { mode: "string" }),
    lastVerified: timestamp("last_verified", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => ({
    // This project's Postgres stand-in for the old SQLite FTS5 virtual
    // table: a GIN index over a tsvector expression, queried via
    // `to_tsvector('english', search_blob) @@ plainto_tsquery('english', $1)`
    // in data-access.ts's searchMatchingIds().
    searchBlobFtsIdx: index("opportunities_search_blob_fts_idx").using(
      "gin",
      sql`to_tsvector('english', ${table.searchBlob})`
    ),
  })
);

export const tags = pgTable("tags", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
  category: text("category").notNull(),
});

export const opportunityTags = pgTable(
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

export const reviews = pgTable("reviews", {
  id: text("id").primaryKey(),
  opportunityId: integer("opportunity_id")
    .notNull()
    .references(() => opportunities.id, { onDelete: "cascade" }),
  timeCommitment: text("time_commitment").notNull(),
  beforeApplying: text("before_applying").notNull(),
  adviceNewMember: text("advice_new_member").notNull(),
  status: text("status", { enum: REVIEW_STATUSES }).notNull().default("pending"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { mode: "string" }),
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

export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").references(() => opportunities.id, { onDelete: "cascade" }),
  reviewId: text("review_id").references(() => reviews.id, { onDelete: "cascade" }),
  category: text("category", { enum: REPORT_CATEGORIES }).notNull(),
  details: text("details").notNull().default(""),
  reporterContact: text("reporter_contact"), // optional, no login required
  status: text("status", { enum: REPORT_STATUSES }).notNull().default("open"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at", { mode: "string" }),
});

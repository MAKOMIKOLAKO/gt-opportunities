// Drizzle schema for the GT Campus Opportunity Finder.
//
// Postgres (Neon) dialect. Previously targeted SQLite for the overnight
// build; migrated per the deployment task (see BUILD_NOTES.md). Notes on
// the port:
//   - `majors` / `meta` / `details` stay TEXT-serialized JSON (unchanged
//     contract with json-columns.ts) rather than moving to native jsonb —
//     no caller needed jsonb query operators, so this keeps the diff
//     minimal. A future move to native jsonb is still a one-file change
//     (json-columns.ts) if ever needed.
//   - `created_at` / `updated_at` / `reviewed_at` / etc. are Postgres
//     `timestamp` columns using drizzle's `{ mode: "string" }`, so the
//     app-level contract (ISO strings in `OpportunityDTO`/`ReviewDTO`) is
//     unchanged from the SQLite version — only the storage type changed.
//   - `search_blob` (plain text, app-maintained) is kept as the
//     human-debuggable denormalized blob; `search_vector` is a new
//     `tsvector` column (Postgres's real full-text index type, replacing
//     SQLite's FTS5 virtual table + triggers) with a GIN index, kept in
//     sync by `refreshSearchBlob()` in data-access.ts on every write.
import { pgTable, text, integer, serial, timestamp, primaryKey, index, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Postgres `tsvector` type — drizzle-orm has no built-in column helper for
// it, so it's defined via customType. Only ever written through a raw
// `to_tsvector(...)` SQL expression (see refreshSearchBlob in
// data-access.ts) and read through `@@` match queries; never touched as a
// plain JS string.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

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
    type: text("type").$type<OpportunityType>().notNull(),
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
    // mutation helpers in data-access.ts.
    searchBlob: text("search_blob").notNull().default(""),
    // Real Postgres full-text index, derived from `searchBlob` on every write
    // (see refreshSearchBlob). Nullable because it's populated by app code,
    // not a generated column.
    searchVector: tsvector("search_vector"),
    source: text("source").$type<OpportunitySource>().notNull(),
    status: text("status").$type<OpportunityStatus>().notNull().default("pending"),
    submittedBy: text("submitted_by"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { mode: "string" }),
    lastVerified: timestamp("last_verified", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().default(sql`now()`),
  },
  (table) => ({
    searchVectorIdx: index("opportunities_search_vector_idx").using("gin", table.searchVector),
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
  status: text("status").$type<ReviewStatus>().notNull().default("pending"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { mode: "string" }),
});

// ---- Suggested edits (Addition: suggest edits on existing listings) ----
// Public, anonymous-friendly "propose a correction" flow for a single field
// on an existing opportunity, reviewed by an admin before it touches the
// live row. Deliberately field-scoped (one row per proposed change to one
// field) rather than a full-row diff, matching the narrow public surface
// (`name | description | link | majors`) the route layer allowlists —
// see backend/src/routes/public.ts.
export const SUGGESTED_EDIT_STATUSES = ["pending", "approved", "rejected"] as const;
export type SuggestedEditStatus = (typeof SUGGESTED_EDIT_STATUSES)[number];

export const suggestedEdits = pgTable("suggested_edits", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id")
    .notNull()
    .references(() => opportunities.id, { onDelete: "cascade" }),
  // Which opportunities.* column is being proposed for change. Free-text
  // column here, but the route layer enforces a fixed allowlist server-side
  // (name|description|link|majors) — never trust a client-supplied field.
  field: text("field").notNull(),
  // Snapshot of the field's value at submission time, captured server-side
  // (not client-supplied) so admins can see the delta even if the live row
  // changes again before this suggestion is reviewed. Nullable because
  // `link` itself is nullable on the live row.
  oldValue: text("old_value"),
  newValue: text("new_value").notNull(),
  submittedBy: text("submitted_by"),
  status: text("status").$type<SuggestedEditStatus>().notNull().default("pending"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
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
  category: text("category").$type<ReportCategory>().notNull(),
  details: text("details").notNull().default(""),
  reporterContact: text("reporter_contact"), // optional, no login required
  status: text("status").$type<ReportStatus>().notNull().default("open"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at", { mode: "string" }),
});

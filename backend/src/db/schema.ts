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
//     app-level contract (ISO strings in `OpportunityDTO`) is
//     unchanged from the SQLite version — only the storage type changed.
//   - `search_blob` (plain text, app-maintained) is kept as the
//     human-debuggable denormalized blob; `search_vector` is a new
//     `tsvector` column (Postgres's real full-text index type, replacing
//     SQLite's FTS5 virtual table + triggers) with a GIN index, kept in
//     sync by `refreshSearchBlob()` in data-access.ts on every write.
import { pgTable, text, integer, real, serial, timestamp, primaryKey, index, uniqueIndex, customType } from "drizzle-orm/pg-core";
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

// pgvector's `vector(n)` type — same customType escape hatch as `tsvector`
// above (drizzle-orm has no built-in pgvector helper either). Dimension is
// fixed at 3072 to match OpenAI's `text-embedding-3-large` output (see
// backend/src/lib/embeddings.ts). Only ever written through a raw pgvector
// literal string (`[0.1,0.2,...]`, see embedOpportunity()) and read through
// the `<=>` cosine-distance operator in raw `sql` (see
// backend/src/lib/related-opportunities.ts) — never touched as a plain JS
// array by drizzle's query builder.
const vector3072 = customType<{ data: string }>({
  dataType() {
    return "vector(3072)";
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
    // SEO-facing slug (e.g. "vip-autonomous-vehicles-lab"), used for the
    // crawlable /opportunities/:slug URL — see backend/src/routes/seo.ts and
    // backend/src/lib/slug.ts. Uniqueness is enforced by a Postgres unique
    // index added (after backfill) in
    // migrations/0006_backfill_opportunity_slug.sql rather than `.unique()`
    // here, since this column is being added to a table that already has
    // ~700 rows all defaulting to '' — the index can only be created once
    // the backfill step has given every row a distinct value.
    slug: text("slug").notNull().default(""),
    // Prior slug, retained for one rename so seo.ts can 301 the old URL
    // instead of 404ing it. Null until a row's slug is ever regenerated.
    previousSlug: text("previous_slug"),
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
    // Semantic embedding of name + description + tag labels, used for
    // cross-category "related organizations" matching (see
    // backend/src/lib/embeddings.ts / related-opportunities.ts). Nullable:
    // populated by app code (embedOpportunity()) whenever OPENAI_API_KEY is
    // set, NOT a generated column, and legitimately null until a live key
    // is configured or the one-off backfill script is run.
    embedding: vector3072("embedding"),
    source: text("source").$type<OpportunitySource>().notNull(),
    status: text("status").$type<OpportunityStatus>().notNull().default("pending"),
    submittedBy: text("submitted_by"),
    // ---- Org profile icon (icon submission feature) ----
    // `iconUrl` is the live, publicly-served icon (exposed to public DTOs).
    // `iconPendingUrl` is a submitted-but-not-yet-approved replacement,
    // admin-only — never exposed on the public read path. Both nullable,
    // additive columns; see migrations/ for the generated ALTER TABLE.
    iconUrl: text("icon_url"),
    iconPendingUrl: text("icon_pending_url"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { mode: "string" }),
    lastVerified: timestamp("last_verified", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "string" }).notNull().default(sql`now()`),
  },
  (table) => ({
    searchVectorIdx: index("opportunities_search_vector_idx").using("gin", table.searchVector),
    // Matches the UNIQUE CONSTRAINT added by hand in
    // migrations/0006_backfill_opportunity_slug.sql (added post-backfill, so
    // it couldn't be expressed as `.unique()` on the column itself — see
    // that migration's comment). Declared here purely so `drizzle-kit
    // generate` sees the schema and the live DB already agree and doesn't
    // propose a redundant index on the next diff.
    slugUniqueIdx: uniqueIndex("opportunities_slug_unique").on(table.slug),
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

// ---- Links (Additional org links beyond "how to apply") ----
// `opportunities.link` remains the single primary "how to apply" link. This
// table holds ADDITIONAL links per opportunity (apply-adjacent, homepage,
// social, other), submitted either standalone (public link-submission route)
// or alongside a new opportunity submission. `type` is a plain text column
// with app-level enum validation (not a Postgres native enum type),
// deliberately extensible later — matches how the rest of this schema
// handles small closed vocabularies (see OPPORTUNITY_TYPES). Follows the
// same pending -> admin-review -> approved lifecycle as suggestedEdits;
// LINK_STATUSES intentionally mirrors SUGGESTED_EDIT_STATUSES's shape
// rather than importing it, since links are their own domain.
export const LINK_TYPES = ["apply", "homepage", "social", "other"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const LINK_STATUSES = ["pending", "approved", "rejected"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const links = pgTable("links", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id")
    .notNull()
    .references(() => opportunities.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  url: text("url").notNull(),
  type: text("type").$type<LinkType>().notNull(),
  status: text("status").$type<LinkStatus>().notNull().default("pending"),
  submittedBy: text("submitted_by"),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { mode: "string" }),
});

// ---- Related organizations (embedding-based, cross-category) ----
// Precomputed cache of "related organizations" per opportunity, keyed on
// cosine similarity between `opportunities.embedding` vectors, with a small
// tag-overlap boost (see backend/src/lib/related-opportunities.ts). Deliberately
// NEVER computed live per page view — recomputeRelated() replaces a given
// opportunity's rows here, and callers just read the cache back
// (getRelatedOpportunities() in data-access.ts). No same-`type` bonus is
// ever applied here or in the scoring logic — cross-category matches (e.g.
// a VIP robotics team <-> an Engage robotics club) are a hard requirement.
export const relatedOpportunities = pgTable(
  "related_opportunities",
  {
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    relatedOpportunityId: integer("related_opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    // Blended score: (1 - cosine_distance) + tag-overlap boost. Not a raw
    // cosine similarity alone — see recomputeRelated().
    score: real("score").notNull(),
    // 1-based position of `relatedOpportunityId` within `opportunityId`'s
    // related list, most-similar first. Drives ORDER BY on read.
    rank: integer("rank").notNull(),
    computedAt: timestamp("computed_at", { mode: "string" }).notNull().default(sql`now()`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.opportunityId, table.relatedOpportunityId] }),
  })
);

// ---- Club/VIP leader access (Module 1 of 7) ----
// Schema + data-access layer only, for a shared-account-per-org "leader
// access" feature: a club/VIP can be granted a single shared login (no
// per-person editor accounts — one shared account per org, intentional, see
// task notes) to edit their own listing. This module lays down the six
// supporting tables; token generation/hashing and HTTP routes are later
// modules.

export const ACCESS_STATUSES = ["active", "revoked"] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

// One row per opportunity that currently has (or has ever had) leader
// access granted. `status` flips to 'revoked' rather than deleting the row,
// so history is preserved (no destructive access-loss). Multiple
// `access_requests` rows for the same opportunity all resolve to this single
// shared row once approved (see access_requests below) — there is
// intentionally no per-person editor table.
export const opportunityAccess = pgTable(
  "opportunity_access",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    status: text("status").$type<AccessStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
    revokedAt: timestamp("revoked_at", { mode: "string" }),
  },
  (table) => ({
    opportunityIdIdx: index("opportunity_access_opportunity_id_idx").on(table.opportunityId),
    statusIdx: index("opportunity_access_status_idx").on(table.status),
  })
);

export const ACCESS_REQUEST_STATUSES = ["pending", "approved", "denied"] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

// Public "claim my org" request, reviewed by an admin before it grants (or
// reuses) an `opportunity_access` row. Many requests can point at the same
// `opportunity_id` (e.g. two officers both file a claim) — all approved
// requests for a given opportunity resolve to the SAME shared
// opportunity_access row, not one row each.
export const accessRequests = pgTable(
  "access_requests",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    requesterName: text("requester_name").notNull(),
    // Free text: email or phone, not split into separate columns — matches
    // this schema's convention elsewhere of not over-modeling contact info
    // (see reports.reporterContact).
    requesterContact: text("requester_contact").notNull(),
    note: text("note"),
    status: text("status").$type<AccessRequestStatus>().notNull().default("pending"),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
    reviewedAt: timestamp("reviewed_at", { mode: "string" }),
  },
  (table) => ({
    opportunityIdIdx: index("access_requests_opportunity_id_idx").on(table.opportunityId),
    statusIdx: index("access_requests_status_idx").on(table.status),
  })
);

export const MAGIC_LINK_PURPOSES = ["claim", "login"] as const;
export type MagicLinkPurpose = (typeof MAGIC_LINK_PURPOSES)[number];

// One-time login/claim links. Only the SHA-256 hash of the raw token is ever
// persisted here (`tokenHash`) — the raw token itself is never stored, only
// ever emailed/shown once at issuance time by a later module. Hashing/token
// generation is intentionally NOT part of this module.
export const magicLinks = pgTable(
  "magic_links",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    purpose: text("purpose").$type<MagicLinkPurpose>().notNull(),
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    usedAt: timestamp("used_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
  },
  (table) => ({
    opportunityIdIdx: index("magic_links_opportunity_id_idx").on(table.opportunityId),
    tokenHashIdx: uniqueIndex("magic_links_token_hash_idx").on(table.tokenHash),
  })
);

// Live/expired session tokens for the shared org login. Same "hash only,
// never the raw token" discipline as magic_links.
export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { mode: "string" }),
  },
  (table) => ({
    opportunityIdIdx: index("sessions_opportunity_id_idx").on(table.opportunityId),
    tokenHashIdx: uniqueIndex("sessions_token_hash_idx").on(table.tokenHash),
  })
);

// Append-only audit trail for everything done via the leader-access surface
// (edits, grants, revokes, request denials, etc). `actor` is free text
// because it can hold either the literal 'admin' or an opportunity id (an
// org acting as itself) — not modeled as a FK/enum on purpose. `action` is
// also free text (not a Postgres enum / $type union) since the action
// vocabulary is expected to grow as later modules add more mutation types;
// this deliberately deviates from the $type<...>-enum-as-text convention
// used for closed vocabularies elsewhere in this file (see OPPORTUNITY_TYPES,
// AccessStatus, etc.) because this vocabulary is NOT closed.
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    fieldChanged: text("field_changed"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    createdAt: timestamp("created_at", { mode: "string" }).notNull().default(sql`now()`),
  },
  (table) => ({
    opportunityIdIdx: index("audit_log_opportunity_id_idx").on(table.opportunityId),
    createdAtIdx: index("audit_log_created_at_idx").on(table.createdAt),
  })
);

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

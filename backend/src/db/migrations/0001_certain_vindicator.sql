-- pgvector extension, required for the `vector(1536)` column type below
-- (opportunities.embedding) — see backend/src/db/schema.ts's `vector1536`
-- customType and BUILD_NOTES.md. Idempotent: safe to re-run.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "related_opportunities" (
	"opportunity_id" integer NOT NULL,
	"related_opportunity_id" integer NOT NULL,
	"score" real NOT NULL,
	"rank" integer NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "related_opportunities_opportunity_id_related_opportunity_id_pk" PRIMARY KEY("opportunity_id","related_opportunity_id")
);
--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "related_opportunities" ADD CONSTRAINT "related_opportunities_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "related_opportunities" ADD CONSTRAINT "related_opportunities_related_opportunity_id_opportunities_id_fk" FOREIGN KEY ("related_opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;
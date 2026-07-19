ALTER TABLE "opportunities" ADD COLUMN "slug" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "previous_slug" text;
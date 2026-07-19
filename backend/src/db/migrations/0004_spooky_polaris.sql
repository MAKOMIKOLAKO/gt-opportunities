-- Model switch (text-embedding-3-small -> text-embedding-3-large) changes both
-- the vector space and the dimension count, so existing 1536-dim embeddings
-- are semantically invalid under the new model, not just the wrong shape.
-- Null them out here rather than attempting an in-place cast (which would
-- fail anyway on a dimension mismatch); the existing nightly
-- embeddings-backfill workflow/script already re-embeds every row where
-- `embedding IS NULL`, so this is a self-healing no-op step for that job.
UPDATE "opportunities" SET "embedding" = NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ALTER COLUMN "embedding" SET DATA TYPE vector(3072);
// One-off backfill for rows written before OPENAI_API_KEY was ever
// configured (i.e. all of them, as of this feature's initial build — see
// BUILD_NOTES.md). Loops every opportunity with a null `embedding`, embeds
// it, and recomputes its related-orgs cache. Run once the first time a real
// OPENAI_API_KEY is set against existing scraped/approved data:
//
//   npm run backfill:embeddings --workspace backend
//
// Safe to re-run: rows that already have an embedding are skipped, and
// recomputeRelated() always fully replaces (not appends to) a row's cached
// related-orgs, so re-running this is a harmless no-op for already-backfilled
// rows and a normal top-up for anything new.
//
// If OPENAI_API_KEY is still unset when this runs, embedOpportunity() logs
// its one-time warning and returns false for every row — this script will
// report 0/N backfilled rather than erroring, which is the correct behavior
// (nothing to do yet).
//
// Embedding and related-orgs recompute are deliberately done in two SEPARATE
// passes, not interleaved row-by-row. recomputeRelated() only considers
// candidates that already have a non-null embedding (see
// related-opportunities.ts), and on a full re-backfill (e.g. right after a
// model-migration null-out) almost every row starts with no embedding. If we
// recomputed a row's related-orgs immediately after embedding it, the first
// rows processed in the loop would see a nearly-empty candidate pool and get
// stuck with an empty/tiny related-orgs cache forever — this is exactly what
// happened to the VIP rows after the text-embedding-3-large migration, since
// they landed early in the scan order. Embedding ALL rows first, then
// recomputing related-orgs for all of them once every embedding exists,
// avoids that ordering bug.
import { isNull } from "drizzle-orm";
import { appendFile } from "node:fs/promises";
import { db, closePool } from "./client.js";
import { opportunities } from "./schema.js";
import { embedOpportunity } from "../lib/embeddings.js";
import { recomputeRelated } from "../lib/related-opportunities.js";

async function main() {
  const rows = await db
    .select({ id: opportunities.id, name: opportunities.name })
    .from(opportunities)
    .where(isNull(opportunities.embedding));

  console.log(`${rows.length} opportunity row(s) missing an embedding. Backfilling...`);

  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  const embeddedIds: number[] = [];
  for (const row of rows) {
    try {
      const ok = await embedOpportunity(row.id);
      if (!ok) {
        skipped++;
        continue;
      }
      embedded++;
      embeddedIds.push(row.id);
      console.log(`  [embedded] ${row.id}: ${row.name}`);
    } catch (err) {
      failed++;
      console.error(`  [failed] ${row.id}: ${row.name} —`, (err as Error).message);
    }
  }

  console.log(`\nRecomputing related-orgs for ${embeddedIds.length} newly-embedded row(s)...`);
  for (const id of embeddedIds) {
    try {
      await recomputeRelated(id);
    } catch (err) {
      console.error(`  [related-orgs failed] ${id} —`, (err as Error).message);
    }
  }

  const summary = `Done. embedded=${embedded} skipped=${skipped} failed=${failed} total=${rows.length}`;
  console.log(`\n${summary}`);
  if (skipped > 0 && embedded === 0 && failed === 0) {
    console.log("(0 embedded — check that OPENAI_API_KEY is set in this environment.)");
  }

  // In CI (GitHub Actions sets this), also surface the summary as part of
  // the job's own Summary tab, not just buried in the raw log output.
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Embeddings backfill\n\n- Embedded: ${embedded}\n- Skipped: ${skipped}\n- Failed: ${failed}\n- Total considered: ${rows.length}\n`
    );
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

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
import { isNull } from "drizzle-orm";
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
  for (const row of rows) {
    const ok = await embedOpportunity(row.id);
    if (!ok) {
      skipped++;
      continue;
    }
    await recomputeRelated(row.id);
    embedded++;
    console.log(`  [embedded] ${row.id}: ${row.name}`);
  }

  console.log(`\nDone. embedded=${embedded} skipped=${skipped} total=${rows.length}`);
  if (skipped > 0 && embedded === 0) {
    console.log("(0 embedded — check that OPENAI_API_KEY is set in this environment.)");
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

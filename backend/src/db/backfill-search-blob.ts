// One-off backfill for rows written before scrapers called refreshSearchBlob()
// (e.g. club rows from engage-classify.ts before it wired that call in) —
// their search_blob was stuck at its empty default, so they never matched
// any full-text search, including their own name. Safe to re-run: recomputing
// an already-correct blob is a harmless no-op.
import { db, closePool } from "./client.js";
import { opportunities } from "./schema.js";
import { refreshSearchBlob } from "./data-access.js";

async function main() {
  const rows = await db
    .select({ id: opportunities.id, searchBlob: opportunities.searchBlob })
    .from(opportunities);
  const stale = rows.filter((r) => !r.searchBlob || r.searchBlob.trim() === "");

  console.log(`${stale.length}/${rows.length} row(s) have an empty search_blob. Backfilling...`);
  for (const row of stale) {
    await refreshSearchBlob(row.id);
  }
  console.log(`Backfilled search_blob for ${stale.length} row(s).`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

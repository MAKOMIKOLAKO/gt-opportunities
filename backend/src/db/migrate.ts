// Idempotent migration runner. drizzle's `migrate()` tracks applied migration
// files in a `drizzle.__drizzle_migrations` bookkeeping table inside the
// target DB, so re-running this against an already-migrated DB is a safe
// no-op (no errors, no duplicate tables/rows). Wired to run automatically on
// every Vercel deploy — see the root `build` script in package.json, which
// runs this before Vercel packages the `/api` functions.
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";
import { opportunities } from "./schema.js";
import { refreshSearchBlob } from "./data-access.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migrationsFolder = path.resolve(__dirname, "migrations");

async function main() {
  console.log(`Running migrations against DATABASE_URL ...`);
  await migrate(db, { migrationsFolder });
  console.log("Migrations complete.");

  // Backfill search_blob for every row. Cheap and idempotent — this covers
  // rows that predate the search_blob column, and is a harmless no-op
  // re-run for rows already backfilled. Unlike the old SQLite FTS5 setup,
  // there are no triggers/virtual tables to keep in sync here: search runs
  // directly against `search_blob` at query time via to_tsvector(...), so
  // backfilling the column is all that's needed.
  const rows = await db.select({ id: opportunities.id }).from(opportunities);
  for (const row of rows) {
    await refreshSearchBlob(row.id);
  }
  console.log(`Backfilled search_blob for ${rows.length} row(s).`);

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

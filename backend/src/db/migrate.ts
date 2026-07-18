// Idempotent migration runner. drizzle's `migrate()` tracks applied migration
// files in a `__drizzle_migrations` bookkeeping table inside the target DB, so
// re-running this against an already-migrated DB is a safe no-op (no errors,
// no duplicate tables/rows).
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite, DB_PATH } from "./client.js";
import { refreshSearchBlob } from "./data-access.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migrationsFolder = path.resolve(__dirname, "migrations");

console.log(`Running migrations against ${DB_PATH} ...`);
migrate(db, { migrationsFolder });
console.log("Migrations complete.");

// Backfill search_blob (and the opportunities_fts index it feeds, via the
// opportunities_au trigger) for every row. Cheap and idempotent — this
// covers rows that predate the search_blob column/migration, and is a
// harmless no-op re-run for rows already backfilled.
const ids = (sqlite.prepare(`SELECT id FROM opportunities`).all() as { id: number }[]).map((r) => r.id);
for (const id of ids) refreshSearchBlob(id);
console.log(`Backfilled search_blob for ${ids.length} row(s).`);

sqlite.close();

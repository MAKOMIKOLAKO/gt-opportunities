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

// Backfill search_blob for every row. Cheap and idempotent — this covers
// rows that predate the search_blob column/migration, and is a harmless
// no-op re-run for rows already backfilled.
//
// The opportunities_ai/ad/au triggers are dropped first: refreshSearchBlob()
// issues plain UPDATEs, and the au trigger's "delete old entry from
// opportunities_fts" fires unconditionally on every UPDATE. For rows that
// predate the FTS index (i.e. right after the table is first created), that
// delete targets a rowid the index has never seen, which FTS5 treats as a
// consistency violation (SQLITE_CORRUPT_VTAB) rather than a no-op. Dropping
// the triggers during backfill avoids touching the index at all; the
// 'rebuild' command below then repopulates it from scratch in one pass, and
// the triggers are recreated so future inserts/updates/deletes stay synced.
const ids = (sqlite.prepare(`SELECT id FROM opportunities`).all() as { id: number }[]).map((r) => r.id);
sqlite.exec(`DROP TRIGGER IF EXISTS opportunities_ai`);
sqlite.exec(`DROP TRIGGER IF EXISTS opportunities_ad`);
sqlite.exec(`DROP TRIGGER IF EXISTS opportunities_au`);
for (const id of ids) refreshSearchBlob(id);
sqlite.exec(`INSERT INTO opportunities_fts(opportunities_fts) VALUES('rebuild')`);
sqlite.exec(`
  CREATE TRIGGER opportunities_ai AFTER INSERT ON opportunities BEGIN
    INSERT INTO opportunities_fts(rowid, search_blob) VALUES (new.id, new.search_blob);
  END
`);
sqlite.exec(`
  CREATE TRIGGER opportunities_ad AFTER DELETE ON opportunities BEGIN
    INSERT INTO opportunities_fts(opportunities_fts, rowid, search_blob) VALUES('delete', old.id, old.search_blob);
  END
`);
sqlite.exec(`
  CREATE TRIGGER opportunities_au AFTER UPDATE ON opportunities BEGIN
    INSERT INTO opportunities_fts(opportunities_fts, rowid, search_blob) VALUES('delete', old.id, old.search_blob);
    INSERT INTO opportunities_fts(rowid, search_blob) VALUES (new.id, new.search_blob);
  END
`);
console.log(`Backfilled search_blob for ${ids.length} row(s) and rebuilt the FTS index.`);

sqlite.close();

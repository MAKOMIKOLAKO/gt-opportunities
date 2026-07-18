// Idempotent migration runner. drizzle's `migrate()` tracks applied migration
// files in a `__drizzle_migrations` bookkeeping table inside the target DB, so
// re-running this against an already-migrated DB is a safe no-op (no errors,
// no duplicate tables/rows).
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite, DB_PATH } from "./client.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migrationsFolder = path.resolve(__dirname, "migrations");

console.log(`Running migrations against ${DB_PATH} ...`);
migrate(db, { migrationsFolder });
console.log("Migrations complete.");

sqlite.close();

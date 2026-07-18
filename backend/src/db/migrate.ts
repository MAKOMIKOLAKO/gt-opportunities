// Idempotent migration runner. drizzle's `migrate()` tracks applied migration
// files in a `__drizzle_migrations` bookkeeping table inside the target DB, so
// re-running this against an already-migrated DB is a safe no-op (no errors,
// no duplicate tables/rows). This is wired into the Vercel build command
// (see vercel.json) so it runs automatically on every deploy.
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { sql } from "drizzle-orm";
import { db, closePool } from "./client.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "migrations");

async function main() {
  console.log("Running migrations against Neon Postgres...");
  await migrate(db, { migrationsFolder });
  console.log("Migrations complete.");

  // Backfill search_vector for any row where it's still null — covers rows
  // that predate the search_vector column, and is a harmless no-op re-run
  // for rows already backfilled (refreshSearchBlob() in data-access.ts
  // keeps it current for every row written after this point).
  const result = await db.execute(
    sql`UPDATE opportunities SET search_vector = to_tsvector('english', search_blob) WHERE search_vector IS NULL`
  );
  console.log(`Backfilled search_vector for ${result.rowCount ?? 0} row(s).`);
}

main()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

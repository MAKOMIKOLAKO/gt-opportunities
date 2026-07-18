// Postgres (Neon) connection, shared by every /api handler, the migration
// runner, and the standalone scraper scripts. Uses `pg` (node-postgres) via
// `drizzle-orm/node-postgres` rather than `@neondatabase/serverless` +
// `drizzle-orm/neon-http` — see BUILD_NOTES.md for why: this codebase's
// admin edit-then-approve flow (`updateOpportunity` in data-access.ts) needs
// a real interactive transaction, which the neon-http HTTP driver does not
// support. `pg` talks standard Postgres wire protocol, which Neon's pooled
// ("pgbouncer") connection string supports directly, and works fine from
// Vercel's Node.js (non-Edge) serverless runtime.
//
// A single `Pool` is created per cold start and reused across invocations
// within the same warm lambda instance (module-level singleton), which is
// the standard pattern for serverless + node-postgres.
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Set it to your Neon pooled connection string (see .env.example)."
  );
}

export const pool = new Pool({ connectionString: DATABASE_URL });

export const db = drizzle(pool, { schema });

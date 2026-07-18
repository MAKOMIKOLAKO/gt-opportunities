// Neon Postgres client. Uses drizzle-orm/node-postgres (plain `pg.Pool`
// over a real TCP connection) rather than drizzle-orm/neon-serverless
// (a Pool over Neon's WebSocket proxy) — the WebSocket driver was hanging
// indefinitely inside Vercel's Node.js serverless runtime (functions timing
// out at 300s with zero response), a known class of issue with that driver
// in some Vercel environments. Plain `pg` over TCP against Neon's POOLED
// connection string (PgBouncer) is a supported, standard combination and
// still gives us real multi-statement transactions for updateOpportunity()
// in data-access.ts (neon-http, the other alternative, is one-HTTP-request-
// per-query and does not support db.transaction()). See BUILD_NOTES.md.
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const { Pool } = pg;

// DATABASE_URL must be Neon's POOLED connection string (the one with
// `-pooler` in the hostname) — see .env.example. Vercel functions are
// short-lived and can spin up many concurrent instances; going through
// Neon's pooler (PgBouncer) keeps that from exhausting Postgres' own
// connection limit.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL environment variable is required (Neon pooled Postgres connection string) — see .env.example."
  );
}

export const pool = new Pool({ connectionString: DATABASE_URL });
export const db = drizzle(pool, { schema });

/** Closes the underlying connection pool. Only call this from short-lived
 * scripts (migrate.ts, scrapers, seed-tags, smoke-test) — never from the
 * long-lived Express app / Vercel function, which should keep the pool
 * open across warm invocations. */
export async function closePool(): Promise<void> {
  await pool.end();
}

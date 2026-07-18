// Neon Postgres client. Uses drizzle-orm/neon-serverless (a `Pool` over
// Neon's WebSocket proxy) rather than drizzle-orm/neon-http, because
// updateOpportunity() in data-access.ts needs a real multi-statement
// transaction (update a row + replace its tag links atomically) — the
// neon-http driver is one-HTTP-request-per-query and does not support
// db.transaction(). neon-serverless's Pool is still designed for
// short-lived serverless environments (Vercel functions included): it
// speaks Neon's connection-pooler protocol over WebSockets instead of
// holding a raw TCP connection, so it doesn't exhaust Postgres' connection
// limit the way a naive `pg.Pool` against an unpooled connection string
// would. See BUILD_NOTES.md for the full driver tradeoff writeup.
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema.js";

// Node.js (unlike browsers/edge runtimes/Node 22+) doesn't have a global
// WebSocket by default on older Node major versions still in use by some
// CI/deploy targets — wire up the `ws` package explicitly so this works
// consistently everywhere this code runs (local dev, GitHub Actions,
// Vercel serverless functions).
neonConfig.webSocketConstructor = ws;

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

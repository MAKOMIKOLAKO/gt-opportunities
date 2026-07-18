import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    // Only needed for `drizzle-kit migrate`/`studio` (introspection against a
    // live DB); `drizzle-kit generate` diffs schema files locally and works
    // without a reachable DATABASE_URL.
    url: process.env.DATABASE_URL ?? "",
  },
});

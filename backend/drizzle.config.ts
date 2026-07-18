import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    // Neon pooled connection string. Required — see .env.example.
    url: process.env.DATABASE_URL ?? "",
  },
});

// Idempotent seed: upserts the starter tag vocabulary by slug. Safe to re-run
// — existing tags are updated in place (label/category), never duplicated.
import { db, closePool } from "./client.js";
import { tags } from "./schema.js";
import { TAG_VOCABULARY } from "./tag-vocabulary.js";
import { sql } from "drizzle-orm";

async function main() {
  for (const tag of TAG_VOCABULARY) {
    await db
      .insert(tags)
      .values(tag)
      .onConflictDoUpdate({
        target: tags.slug,
        set: { label: tag.label, category: tag.category },
      });
  }

  const [{ c }] = await db.select({ c: sql<number>`count(*)` }).from(tags);
  console.log(`Tag vocabulary seeded. Total tags in DB: ${c}`);
}

main()
  .catch((err) => {
    console.error("Failed to seed tags:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

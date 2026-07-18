// Idempotent seed: upserts the starter tag vocabulary by slug. Safe to re-run
// — existing tags are updated in place (label/category), never duplicated.
import { db, sqlite } from "./client.js";
import { tags } from "./schema.js";
import { TAG_VOCABULARY } from "./tag-vocabulary.js";
import { sql } from "drizzle-orm";

for (const tag of TAG_VOCABULARY) {
  db.insert(tags)
    .values(tag)
    .onConflictDoUpdate({
      target: tags.slug,
      set: { label: tag.label, category: tag.category },
    })
    .run();
}

const count = db.select({ c: sql<number>`count(*)` }).from(tags).get();
console.log(`Tag vocabulary seeded. Total tags in DB: ${count?.c}`);

sqlite.close();

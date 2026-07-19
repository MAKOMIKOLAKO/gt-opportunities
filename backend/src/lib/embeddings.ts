// Embedding generation for the "related organizations" feature (cross-
// category matching over `opportunities.embedding`, a pgvector column — see
// schema.ts). Uses OpenAI's `text-embedding-3-large` model (3072 dims) via
// plain `fetch` — no SDK dependency needed for a single endpoint.
//
// OPENAI_API_KEY is optional at the infrastructure level: if it's unset,
// embedText() logs one warning and returns null instead of throwing, so the
// rest of the ingestion pipeline (scrapers, admin approve/edit) keeps
// working end-to-end with embeddings simply staying null / related-orgs
// caches staying empty until a real key is configured. See BUILD_NOTES.md.
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { opportunities, opportunityTags, tags } from "../db/schema.js";

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 3072;
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

let warnedMissingKey = false;

function warnMissingKeyOnce(): void {
  if (warnedMissingKey) return;
  warnedMissingKey = true;
  console.warn(
    "WARNING: OPENAI_API_KEY is not set — embedding generation (and the related-organizations feature it " +
      "feeds) is inert. The app still functions normally; opportunities.embedding stays null and " +
      "relatedOrgs will be an empty array everywhere until OPENAI_API_KEY is configured. See .env.example " +
      "and BUILD_NOTES.md. Once a key is set, run `npm run backfill:embeddings` (from backend/) to " +
      "populate embeddings for any rows scraped/created before the key existed."
  );
}

/**
 * Concatenates the fields that feed an opportunity's embedding into a single
 * string. Deliberately simple (no weighting/truncation beyond what the
 * OpenAI endpoint itself enforces) — name + description + tag labels is
 * enough signal for cosine-similarity matching across vip/lab/club rows
 * that use very different tagging vocabularies.
 */
export function buildEmbeddingInput(name: string, description: string, tagLabels: string[]): string {
  return `${name}\n\n${description}\n\nTags: ${tagLabels.join(", ")}`;
}

/**
 * Calls OpenAI's embeddings endpoint for a single input string. Returns
 * `null` (never throws) if OPENAI_API_KEY is unset or the request fails —
 * callers treat null as "no embedding available yet," not an error to
 * propagate. This is a deliberate design choice: embedding failures must
 * never block a scrape/classify/approve/edit from completing.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    warnMissingKeyOnce();
    return null;
  }

  try {
    const res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`OpenAI embeddings request failed: HTTP ${res.status} ${body}`);
      return null;
    }
    const data = (await res.json()) as { data?: { embedding?: number[] }[] };
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      console.error(
        `OpenAI embeddings response had unexpected shape (expected ${EMBEDDING_DIMENSIONS} dims); got ${
          embedding?.length ?? "none"
        }.`
      );
      return null;
    }
    return embedding;
  } catch (err) {
    console.error("OpenAI embeddings request threw:", (err as Error).message);
    return null;
  }
}

/** Serializes a JS number array into a pgvector literal string, e.g. "[0.1,0.2,...]". */
function toPgvectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Loads an opportunity's current name/description/tags, builds the
 * embedding input, calls the embeddings API, and — if a vector came back —
 * persists it to `opportunities.embedding` via a raw pgvector literal
 * (drizzle has no query-builder support for the custom vector type).
 *
 * No-ops (returns false) if the row doesn't exist or embedText() returned
 * null (no API key / request failure) — never throws, per the "embedding
 * failures must not block ingestion" rule described on embedText().
 */
export async function embedOpportunity(opportunityId: number): Promise<boolean> {
  const rows = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  if (rows.length === 0) return false;
  const row = rows[0];

  const tagRows = await db
    .select({ label: tags.label })
    .from(opportunityTags)
    .innerJoin(tags, eq(opportunityTags.tagId, tags.id))
    .where(eq(opportunityTags.opportunityId, opportunityId));
  const tagLabels = tagRows.map((t) => t.label);

  const input = buildEmbeddingInput(row.name, row.description, tagLabels);
  const embedding = await embedText(input);
  if (!embedding) return false;

  const literal = toPgvectorLiteral(embedding);
  await db
    .update(opportunities)
    .set({ embedding: sql`${literal}::vector` })
    .where(eq(opportunities.id, opportunityId));

  return true;
}

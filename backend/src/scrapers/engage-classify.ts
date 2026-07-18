// Stage 2 of the Engage pipeline: classify.
//
// Reads every org cached by engage-scrape.ts under data/raw-cache/engage/,
// determines an is-technical flag + zero-or-more controlled vocabulary tags
// + a confidence score (see engage-classify-rules.ts for the methodology),
// caches the classification per-org keyed on (org id + sha256 of its
// description) under data/classification-cache/engage/ so re-runs skip
// unchanged orgs, and upserts *technical* orgs into the `opportunities`
// table (source='scraped', type='club', status='pending' — always; never
// auto-approved). Non-technical orgs are classified and cached (for audit /
// future re-review) but are NOT inserted into opportunities, since the
// public product only wants technical orgs — see NOTES-FOR-REVIEW.md for
// this design choice.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, closePool } from "../db/client.js";
import { opportunities, opportunityTags, tags } from "../db/schema.js";
import { setMajors, setMeta } from "../db/json-columns.js";
import { TAG_VOCABULARY } from "../db/tag-vocabulary.js";
import { classifyOrg } from "./engage-classify-rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_CACHE_DIR = path.resolve(__dirname, "../../../data/raw-cache/engage");
const CLASSIFICATION_CACHE_DIR = path.resolve(__dirname, "../../../data/classification-cache/engage");

interface RawOrgRecord {
  id: string;
  name: string;
  shortName: string | null;
  websiteKey: string;
  description: string;
  categoryNames: string[];
  status: string;
  visibility: string;
  link: string;
  scrapedAt: string;
}

interface ClassificationRecord {
  orgId: string;
  name: string;
  descriptionHash: string;
  isTechnical: boolean;
  tags: string[];
  confidence: number;
  reasoning: string;
  classifiedAt: string;
}

function hashDescription(description: string): string {
  return crypto.createHash("sha256").update(description).digest("hex").slice(0, 16);
}

function loadRawOrgs(): RawOrgRecord[] {
  const files = fs.readdirSync(RAW_CACHE_DIR).filter((f) => f.endsWith(".json") && f !== "_index.json");
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(RAW_CACHE_DIR, f), "utf-8")) as RawOrgRecord);
}

function cachePath(orgId: string): string {
  return path.join(CLASSIFICATION_CACHE_DIR, `${orgId}.json`);
}

function loadCached(orgId: string): ClassificationRecord | null {
  const p = cachePath(orgId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ClassificationRecord;
  } catch {
    return null;
  }
}

async function ensureTagIds(): Promise<Map<string, number>> {
  const rows = await db.select().from(tags);
  const bySlug = new Map(rows.map((r) => [r.slug, r.id]));
  // Sanity: every vocabulary slug we might assign must exist in the tags table
  // (seed-tags.ts is responsible for that; we just fail loudly if it's stale).
  for (const t of TAG_VOCABULARY) {
    if (!bySlug.has(t.slug)) {
      console.warn(`WARNING: tag slug "${t.slug}" is in TAG_VOCABULARY but missing from the tags table. Run npm run seed:tags.`);
    }
  }
  return bySlug;
}

async function upsertOpportunity(
  org: RawOrgRecord,
  classification: ClassificationRecord,
  tagIdBySlug: Map<string, number>
) {
  const majorTags = classification.tags
    .map((slug) => TAG_VOCABULARY.find((t) => t.slug === slug))
    .filter((t): t is (typeof TAG_VOCABULARY)[number] => !!t && t.category === "major")
    .map((t) => t.label);

  const meta = {
    engageId: org.id,
    engageWebsiteKey: org.websiteKey,
    engageCategoryNames: org.categoryNames,
    isTechnical: classification.isTechnical,
    classificationConfidence: classification.confidence,
    classificationReasoning: classification.reasoning,
    classifiedAt: classification.classifiedAt,
  };

  const existing = await db.select().from(opportunities).where(eq(opportunities.link, org.link));

  let opportunityId: number;
  if (existing.length > 0) {
    opportunityId = existing[0].id;
    // Requested one-off: also force approved on update, overriding the
    // usual "never touch status on re-classify" rule.
    await db
      .update(opportunities)
      .set({
        name: org.name,
        description: org.description,
        majors: setMajors(majorTags),
        link: org.link,
        meta: setMeta(meta),
        status: "approved",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(opportunities.id, opportunityId));
    await db.delete(opportunityTags).where(eq(opportunityTags.opportunityId, opportunityId));
  } else {
    const [row] = await db
      .insert(opportunities)
      .values({
        type: "club",
        name: org.name,
        description: org.description,
        majors: setMajors(majorTags),
        link: org.link,
        meta: setMeta(meta),
        source: "scraped",
        status: "approved", // Requested one-off: auto-approve on insert.
      })
      .returning({ id: opportunities.id });
    opportunityId = row.id;
  }

  for (const slug of classification.tags) {
    const tagId = tagIdBySlug.get(slug);
    if (tagId == null) continue; // already warned above if vocabulary/table are out of sync
    await db.insert(opportunityTags).values({ opportunityId, tagId });
  }

  return opportunityId;
}

async function main() {
  fs.mkdirSync(CLASSIFICATION_CACHE_DIR, { recursive: true });

  const orgs = loadRawOrgs();
  console.log(`Loaded ${orgs.length} scraped orgs from raw cache.`);

  let cacheHits = 0;
  let freshlyClassified = 0;
  const classifications: ClassificationRecord[] = [];

  for (const org of orgs) {
    const descriptionHash = hashDescription(org.description);
    const cached = loadCached(org.id);

    if (cached && cached.descriptionHash === descriptionHash) {
      cacheHits++;
      classifications.push(cached);
      continue;
    }

    const result = classifyOrg(org.name, org.description, org.categoryNames);
    const record: ClassificationRecord = {
      orgId: org.id,
      name: org.name,
      descriptionHash,
      isTechnical: result.isTechnical,
      tags: result.tags,
      confidence: result.confidence,
      reasoning: result.reasoning,
      classifiedAt: new Date().toISOString(),
    };
    fs.writeFileSync(cachePath(org.id), JSON.stringify(record, null, 2));
    classifications.push(record);
    freshlyClassified++;
  }

  console.log(`Classification cache: ${cacheHits} hits (skipped), ${freshlyClassified} freshly classified.`);

  const technical = classifications.filter((c) => c.isTechnical);
  console.log(`${technical.length}/${classifications.length} orgs classified as technical.`);

  const tagIdBySlug = await ensureTagIds();
  const orgById = new Map(orgs.map((o) => [o.id, o]));

  // Requested one-off: insert every scraped org, not just ones classified
  // technical. isTechnical/confidence/reasoning are still recorded in each
  // row's meta for later filtering in the review queue.
  let inserted = 0;
  let updated = 0;
  for (const c of classifications) {
    const org = orgById.get(c.orgId);
    if (!org) continue;
    const existingBefore = await db.select().from(opportunities).where(eq(opportunities.link, org.link));
    await upsertOpportunity(org, c, tagIdBySlug);
    if (existingBefore.length > 0) updated++;
    else inserted++;
  }

  console.log(`Opportunities upserted: ${inserted} inserted, ${updated} updated (all scraped orgs).`);
}

main()
  .catch((err) => {
    console.error("Fatal error running Engage classification:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

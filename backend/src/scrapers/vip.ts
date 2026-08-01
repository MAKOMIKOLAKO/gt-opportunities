// Scraper for the GT VIP (Vertically Integrated Projects) catalog.
//
// Source: https://vip.gatech.edu/teams-all-in-one/ lists every team; each team
// has a detail page at https://vip.gatech.edu/teams-all-in-one/entry/<id>/
// (WordPress + Formidable Forms). This scraper:
//   1. Fetches the listing page to enumerate entry ids.
//   2. Fetches each entry's detail page (cached to disk for politeness/
//      resilience, but always re-fetched so updates are picked up).
//   3. Parses each detail page with cheerio and upserts into `opportunities`,
//      keyed on `meta.vipEntryId` so re-runs UPDATE rather than duplicate.
//
// Run: npm run scrape:vip (from backend/)
//
// Scheduling: run once per semester (roughly Jan and Aug, ahead of add/drop).
// The VIP catalog changes rarely mid-semester, so more frequent runs are not
// needed. See /docs or root SCHEDULING.md for the cron/Task Scheduler entry.
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, closePool } from "../db/client.js";
import { opportunities } from "../db/schema.js";
import { getMeta, setMajors, setMeta, setDetails } from "../db/json-columns.js";
import { refreshSearchBlob } from "../db/data-access.js";
import { embedOpportunity } from "../lib/embeddings.js";
import { recomputeRelated } from "../lib/related-opportunities.js";
import { generateUniqueSlug } from "../lib/slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LISTING_URL = "https://vip.gatech.edu/teams-all-in-one/";
const USER_AGENT =
  "GT-Opportunity-Finder-Bot/0.1 (student project; contact: reachmaako@gmail.com)";

// repo-root/data/raw-cache/vip
const CACHE_DIR = path.resolve(__dirname, "../../../data/raw-cache/vip");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs = 300, maxMs = 800) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

async function fetchHtml(url: string, cachePath: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const html = await res.text();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, html, "utf-8");
    return html;
  } catch (err) {
    if (fs.existsSync(cachePath)) {
      console.warn(`  fetch failed for ${url} (${(err as Error).message}); using cached copy`);
      return fs.readFileSync(cachePath, "utf-8");
    }
    throw err;
  }
}

function entryIdsFromListing(html: string): string[] {
  const ids = new Set<string>();
  const re = /teams-all-in-one\/entry\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    ids.add(m[1]);
  }
  return [...ids];
}

interface SectionTarget {
  type: "frm9" | "advisors";
  el: ReturnType<CheerioAPI>;
}

// Given an <h4> label element, find its associated content based on the
// two markup shapes the site uses: label(frm3) + content(frm9) siblings, or
// label(frm3) + repeated frm3 "person card" siblings (used for Advisors).
function sectionAfterLabel($: CheerioAPI, h4: ReturnType<CheerioAPI>): SectionTarget | null {
  const parent = h4.parent();
  if (!parent.hasClass("frm3")) return null;
  const frm9 = parent.next("div.frm9");
  if (frm9.length) return { type: "frm9", el: frm9 };
  const siblingCards = parent.siblings("div.frm3");
  if (siblingCards.length) return { type: "advisors", el: siblingCards };
  return null;
}

// Goals / Issues Involved / Partners-Sponsors: the <h4> label sits directly
// among its content <p> siblings inside the same container (no frm3/frm9 split).
function inlineTextAfterLabel($: CheerioAPI, h4: ReturnType<CheerioAPI>): string {
  const parent = h4.parent();
  if (parent.hasClass("frm3")) return ""; // handled by sectionAfterLabel instead
  const following = h4.nextUntil("h4");
  const parts: string[] = [];
  following.each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t) parts.push(t);
  });
  return parts.join("\n\n");
}

function frm9Text($: CheerioAPI, el: ReturnType<CheerioAPI>): string {
  const clone = el.clone();
  clone.find("br").replaceWith("\n");
  clone.find("li").each((_, li) => {
    $(li).prepend("- ");
  });
  return clone
    .text()
    .split("\n")
    .map((s) => s.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

interface Advisor {
  name: string;
  raw: string;
  email: string | null;
  department: string | null;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

function parseAdvisors($: CheerioAPI, cards: ReturnType<CheerioAPI>): Advisor[] {
  const advisors: Advisor[] = [];
  cards.each((_, card) => {
    const $card = $(card);
    if (!$card.text().trim()) return;

    // Emails are always inside an <a> (mailto: href, or just a bare address
    // as both href and text) — extract from the anchor itself rather than
    // regexing the card's flattened text, which sometimes concatenates the
    // preceding department line directly onto the email with no separator
    // (source markup omits a <br/> there), corrupting a naive text match.
    const $emailLink = $card
      .find("a")
      .filter((_, a) => {
        const href = $(a).attr("href") ?? "";
        return href.includes("@") || $(a).text().includes("@");
      })
      .first();
    const email =
      $emailLink.text().match(EMAIL_RE)?.[0] ??
      $emailLink.attr("href")?.replace(/^mailto:/, "").match(EMAIL_RE)?.[0] ??
      null;

    // Remove the email anchor before splitting into lines so it can't get
    // glued onto the department text above.
    const clone = $card.clone();
    clone.find("a").each((_, a) => {
      const $a = $(a);
      if (($a.attr("href") ?? "").includes("@") || $a.text().includes("@")) $a.remove();
    });
    clone.find("br").replaceWith("\n");
    const lines = clone
      .text()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const name = $card.find("strong").first().text().trim() || lines[0] || "";
    // Cards are name / [department] / email, but department is sometimes
    // omitted (a duplicate of the name instead) — drop lines that are the
    // name repeated.
    const department = lines.filter((l) => l.toLowerCase() !== name.toLowerCase()).join("; ");

    if (!name && !email) return;
    advisors.push({
      name,
      raw: [...lines, email].filter(Boolean).join(" | "),
      email,
      department: department || null,
    });
  });
  return advisors;
}

interface MajorsResult {
  majors: string[];
  byCategory: Record<string, string[]>;
}

function parseMajors($: CheerioAPI, frm9El: ReturnType<CheerioAPI>): MajorsResult {
  const majors: string[] = [];
  const byCategory: Record<string, string[]> = {};
  frm9El.find("p").each((_, p) => {
    const $p = $(p);
    const category = $p.find("strong").first().text().replace(/:\s*$/, "").trim();
    const clone = $p.clone();
    clone.find("strong").remove();
    const rest = clone.text().trim();
    const items = rest
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length === 0) return;
    if (category) byCategory[category] = items;
    majors.push(...items);
  });
  return { majors, byCategory };
}

export interface ParsedVipEntry {
  vipEntryId: string;
  name: string;
  description: string;
  goals: string;
  majors: string[];
  majorsByCategory: Record<string, string[]>;
  advisors: Advisor[];
  methods: string;
  preferredPrep: string;
  meetingInfo: string;
  partners: string;
  issues: string;
  link: string;
}

export function parseEntryHtml(html: string, vipEntryId: string, link: string): ParsedVipEntry {
  const $ = cheerio.load(html);
  const content = $(".entry-content").first();

  const name = content.find("h1 p").first().text().trim() || content.find("h1").first().text().trim();

  let goals = "";
  let issues = "";
  let partners = "";
  let methods = "";
  let majors: string[] = [];
  let majorsByCategory: Record<string, string[]> = {};
  let preferredPrep = "";
  let advisors: Advisor[] = [];
  let meetingInfo = "";

  content.find("h4").each((_, h4El) => {
    const $h4 = $(h4El);
    const label = $h4.text().trim();
    const section = sectionAfterLabel($, $h4);

    if (/^goals$/i.test(label)) {
      goals = inlineTextAfterLabel($, $h4);
    } else if (/^issues involved/i.test(label)) {
      issues = inlineTextAfterLabel($, $h4);
    } else if (/^partners\/?sponsors$/i.test(label)) {
      partners = inlineTextAfterLabel($, $h4);
    } else if (/^methods and technologies$/i.test(label) && section?.type === "frm9") {
      methods = frm9Text($, section.el);
    } else if (/^majors sought$/i.test(label) && section?.type === "frm9") {
      const parsed = parseMajors($, section.el);
      majors = parsed.majors;
      majorsByCategory = parsed.byCategory;
    } else if (/^preferred interests/i.test(label) && section?.type === "frm9") {
      preferredPrep = frm9Text($, section.el);
    } else if (/^advisors$/i.test(label) && section?.type === "advisors") {
      advisors = parseAdvisors($, section.el);
    } else if (/^day,?\s*time/i.test(label) && section?.type === "frm9") {
      meetingInfo = frm9Text($, section.el);
    }
  });

  const description = [goals, issues].filter(Boolean).join("\n\n");

  return {
    vipEntryId,
    name,
    description,
    goals,
    majors,
    majorsByCategory,
    advisors,
    methods,
    preferredPrep,
    meetingInfo,
    partners,
    issues,
    link,
  };
}

async function findExistingByVipId(vipEntryId: string) {
  const rows = await db.select().from(opportunities).where(eq(opportunities.type, "vip"));
  return rows.find((r) => getMeta(r.meta).vipEntryId === vipEntryId);
}

async function upsertEntry(entry: ParsedVipEntry) {
  const now = new Date().toISOString();
  const existing = await findExistingByVipId(entry.vipEntryId);
  // Scraper bookkeeping only (used to key upserts) — human-facing scraped
  // content goes in `details` below, since that's what feeds search.
  const meta = { vipEntryId: entry.vipEntryId };

  const details = {
    goals: entry.goals,
    issues_addressed: entry.issues,
    partners_sponsors: entry.partners,
    methods_technologies: entry.methods,
    majors_by_category: entry.majorsByCategory,
    preferred_interests: entry.preferredPrep,
    advisor_name: entry.advisors.map((a) => a.name).join("; "),
    advisor_email: entry.advisors.map((a) => a.email).filter(Boolean).join("; "),
    advisor_department: entry.advisors.map((a) => a.department).filter(Boolean).join("; "),
    meeting_info: entry.meetingInfo,
  };

  const values = {
    type: "vip" as const,
    name: entry.name || `VIP Team ${entry.vipEntryId}`,
    description: entry.description,
    majors: setMajors(entry.majors),
    link: entry.link,
    meta: setMeta(meta),
    details: setDetails(details),
    source: "scraped" as const,
    status: "approved" as const,
    lastVerified: now,
    updatedAt: now,
  };

  let id: number;
  let action: "inserted" | "updated";
  if (existing) {
    // Slug intentionally untouched on re-scrape/update — VIP entry names
    // rarely change, and regenerating it on every scrape run would churn
    // (or 404) an already-indexed URL for no reason. Renames go through
    // updateOpportunity()'s explicit slug-regeneration path instead.
    await db.update(opportunities).set(values).where(eq(opportunities.id, existing.id));
    id = existing.id;
    action = "updated";
  } else {
    const slug = await generateUniqueSlug(values.name);
    const [row] = await db.insert(opportunities).values({ ...values, slug }).returning({ id: opportunities.id });
    id = row.id;
    action = "inserted";
  }
  await refreshSearchBlob(id);

  // Re-embed and recompute related orgs for this team. Wrapped so a failure
  // here (or a missing OPENAI_API_KEY, in which case embedOpportunity()
  // just returns false) never fails the scrape run — see BUILD_NOTES.md.
  try {
    if (await embedOpportunity(id)) {
      await recomputeRelated(id);
    }
  } catch (err) {
    console.error(`  embedding/related-orgs step failed for entry ${id}:`, (err as Error).message);
  }

  return { action, id };
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`Fetching listing page: ${LISTING_URL}`);
  const listingHtml = await fetchHtml(LISTING_URL, path.join(CACHE_DIR, "_listing.html"));
  const ids = entryIdsFromListing(listingHtml);
  console.log(`Found ${ids.length} VIP team entries.`);

  let inserted = 0;
  let updated = 0;
  let failed = 0;

  for (const id of ids) {
    const link = `https://vip.gatech.edu/teams-all-in-one/entry/${id}/`;
    const cachePath = path.join(CACHE_DIR, `${id}.html`);
    try {
      const html = await fetchHtml(link, cachePath);
      const entry = parseEntryHtml(html, id, link);
      const { action } = await upsertEntry(entry);
      if (action === "inserted") inserted++;
      else updated++;
      console.log(`  [${action}] ${id}: ${entry.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAILED entry ${id}: ${(err as Error).message}`);
    }
    await randomDelay();
  }

  console.log(`\nDone. inserted=${inserted} updated=${updated} failed=${failed} total=${ids.length}`);
  await closePool();
}

main().catch(async (err) => {
  console.error("Fatal error running VIP scraper:", err);
  await closePool();
  process.exit(1);
});

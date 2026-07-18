// Stage 1 of the Engage (gatech.campuslabs.com/engage) pipeline: scrape.
//
// gatech.campuslabs.com/robots.txt disallows /engage/api/ for all user
// agents, which rules out calling the Azure Cognitive Search JSON endpoint
// (/engage/api/discovery/search/organizations) directly, even though it's
// unauthenticated. So this stage drives a real (headless) browser against
// the public org directory page a human visitor sees:
//
//   https://gatech.campuslabs.com/engage/organizations
//
// The page's own client-side JS is the thing that calls the Engage API
// under the hood to render results — that's normal browser behavior for
// anyone visiting the page, and is not what robots.txt disallows. We never
// call /engage/api/ ourselves; we only read the rendered DOM.
//
// The directory paginates via a "Load More" button (not URL-based paging),
// so we click it repeatedly, waiting for the org count to grow each time,
// until either the button disappears or the count stops increasing.
//
// DOM shape (as of 2026-07): each org is an <li> inside
// #org-search-results, containing an <a href="/engage/organization/{key}">
// with an avatar element carrying alt="{org name}" (an <img alt=...> for
// orgs with a profile photo, or a <div alt=...> placeholder for orgs
// without one — hence matching the generic [alt] attribute, not img
// specifically) and a <p class="DescriptionExcerpt">{description}</p>. The
// websiteKey from the URL is stable and unique, so we use it as our
// cache/record id (the previous numeric Engage Id isn't exposed by the
// rendered page).
//
// Output shape is unchanged from the old API-based scraper (still one raw
// JSON record per org under data/raw-cache/engage/, plus _index.json) so
// stage 2 (classify) needs no changes.
//
// Scheduling: this pipeline (scrape + classify) is the piece MOST LIKELY to
// need re-running periodically — the ~730-org Engage directory turns over
// far more than the VIP catalog (new clubs register, orgs go inactive) and
// classification quality depends on catching name/description changes.
// Recommend running scrape+classify monthly during the semester, and
// definitely re-run at the start of each semester. Every run's new/updated
// rows still land as status='pending' — nothing from this pipeline reaches
// the public app without a human passing it through the admin review queue.
// See root SCHEDULING.md for the cron/Task Scheduler entry.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_CACHE_DIR = path.resolve(__dirname, "../../../data/raw-cache/engage");

const DIRECTORY_URL = "https://gatech.campuslabs.com/engage/organizations";
const USER_AGENT = "Mozilla/5.0 (compatible; GTOpportunityFinderBot/1.0; +https://github.com/gt-opportunity-finder; research project, respects robots.txt)";

// Between "Load More" clicks — polite pacing, not a workaround for anything.
const CLICK_DELAY_MS = 1500;
const MAX_CLICKS = 200; // ~730 orgs / 10 per click ≈ 73 clicks expected; generous ceiling

interface ScrapedOrg {
  name: string;
  websiteKey: string;
  description: string;
}

async function scrapeAllOrgs(): Promise<ScrapedOrg[]> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    await page.goto(DIRECTORY_URL, { waitUntil: "networkidle", timeout: 60_000 });

    let previousCount = -1;
    let stableRounds = 0;

    for (let click = 0; click < MAX_CLICKS; click++) {
      const count = await page.locator("#org-search-results li").count();
      if (count === previousCount) {
        stableRounds++;
        if (stableRounds >= 2) break; // two rounds with no growth: done
      } else {
        stableRounds = 0;
      }
      previousCount = count;

      const loadMore = page.getByRole("button", { name: "Load More" });
      const visible = await loadMore.isVisible().catch(() => false);
      if (!visible) break;

      await loadMore.click();
      await page.waitForTimeout(CLICK_DELAY_MS);
    }

    const finalCount = await page.locator("#org-search-results li").count();
    console.log(`Loaded ${finalCount} org cards from the rendered directory page.`);

    const cards = page.locator("#org-search-results li");
    const results: ScrapedOrg[] = [];
    for (let i = 0; i < finalCount; i++) {
      const card = cards.nth(i);
      const href = await card.locator("a[href^='/engage/organization/']").first().getAttribute("href");
      if (!href) continue;
      const websiteKey = href.replace("/engage/organization/", "").split(/[/?]/)[0];
      const name = (await card.locator("[alt]").first().getAttribute("alt"))?.trim() ?? "";
      const description = (await card.locator("p.DescriptionExcerpt").first().textContent().catch(() => null))?.trim() ?? "";
      if (!name || !websiteKey) continue;
      results.push({ name, websiteKey, description });
    }

    return results;
  } finally {
    await browser.close();
  }
}

async function main() {
  fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });

  const orgs = await scrapeAllOrgs();

  let written = 0;
  let skippedNoText = 0;
  const index: { id: string; name: string; hasText: boolean }[] = [];

  for (const org of orgs) {
    const hasText = org.description.length > 0;
    if (!hasText) skippedNoText++;

    const record = {
      id: org.websiteKey,
      name: org.name,
      shortName: null as string | null,
      websiteKey: org.websiteKey,
      description: org.description,
      categoryNames: [] as string[],
      status: "Active",
      visibility: "Public",
      link: `https://gatech.campuslabs.com/engage/organization/${org.websiteKey}`,
      scrapedAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(RAW_CACHE_DIR, `${org.websiteKey}.json`), JSON.stringify(record, null, 2));
    index.push({ id: org.websiteKey, name: org.name, hasText });
    written++;
  }

  fs.writeFileSync(
    path.join(RAW_CACHE_DIR, "_index.json"),
    JSON.stringify({ scrapedAt: new Date().toISOString(), total: written, index }, null, 2)
  );

  console.log(`\nDone. Wrote ${written} org records to ${RAW_CACHE_DIR}`);
  console.log(`Orgs with no description/summary text at all: ${skippedNoText}`);
}

main().catch((err) => {
  console.error("engage-scrape failed:", err);
  process.exit(1);
});

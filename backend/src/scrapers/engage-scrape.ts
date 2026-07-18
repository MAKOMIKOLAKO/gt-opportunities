// Stage 1 of the Engage (gatech.campuslabs.com/engage) pipeline: scrape.
//
// Discovery: gatech.campuslabs.com/engage is a CampusLabs "Engage" platform
// instance. Its organization directory is backed by an Azure Cognitive
// Search index exposed at a JSON endpoint (found via WebFetch + curl probing,
// no auth required, no JS rendering needed):
//
//   GET https://gatech.campuslabs.com/engage/api/discovery/search/organizations?top=200&skip=<N>
//
// Response shape: { "@odata.count": <total>, "value": [ { Id, Name,
// WebsiteKey, Description (HTML, often null), Summary (plain text,
// sometimes the only text available), CategoryNames, Status, Visibility,
// ... } ] }
//
// We page through with top=200 (the practical page size that works
// reliably) until skip >= @odata.count, and write one raw-cache JSON file
// per organization keyed by its Id so stage 2 (classify) can cache
// classification results per-org without re-fetching.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_CACHE_DIR = path.resolve(__dirname, "../../../data/raw-cache/engage");

const API_BASE = "https://gatech.campuslabs.com/engage/api/discovery/search/organizations";
const PAGE_SIZE = 200;

interface RawOrg {
  Id: string;
  Name: string;
  ShortName: string | null;
  WebsiteKey: string;
  Description: string | null;
  Summary: string | null;
  CategoryNames: string[];
  Status: string;
  Visibility: string;
}

interface OrgSearchResponse {
  "@odata.count": number;
  value: RawOrg[];
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPage(skip: number): Promise<OrgSearchResponse> {
  const url = `${API_BASE}?top=${PAGE_SIZE}&skip=${skip}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Engage API request failed: ${res.status} ${res.statusText} (${url})`);
  }
  return (await res.json()) as OrgSearchResponse;
}

async function main() {
  fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });

  let skip = 0;
  let total = Infinity;
  const allOrgs: RawOrg[] = [];

  while (skip < total) {
    const page = await fetchPage(skip);
    total = page["@odata.count"];
    allOrgs.push(...page.value);
    console.log(`Fetched ${allOrgs.length}/${total} orgs (skip=${skip})`);
    skip += PAGE_SIZE;
    if (page.value.length === 0) break; // safety against infinite loop
  }

  let written = 0;
  let skippedNoText = 0;
  const index: { id: string; name: string; hasText: boolean }[] = [];

  for (const org of allOrgs) {
    const description = org.Description ? stripHtml(org.Description) : org.Summary ? org.Summary.trim() : "";
    const hasText = description.length > 0;
    if (!hasText) skippedNoText++;

    const record = {
      id: org.Id,
      name: org.Name,
      shortName: org.ShortName,
      websiteKey: org.WebsiteKey,
      description,
      categoryNames: org.CategoryNames ?? [],
      status: org.Status,
      visibility: org.Visibility,
      link: `https://gatech.campuslabs.com/engage/organization/${org.WebsiteKey}`,
      scrapedAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(RAW_CACHE_DIR, `${org.Id}.json`), JSON.stringify(record, null, 2));
    index.push({ id: org.Id, name: org.Name, hasText });
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

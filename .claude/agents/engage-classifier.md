---
name: engage-classifier
description: Use for Phase 2b — scraping the ~600-org GT Engage/CampusLabs directory and running an offline batch LLM classification pass (technical/non-technical + tag assignment + confidence) against the controlled tag vocabulary. Depends on schema + tag vocabulary being frozen.
model: claude-sonnet-5
effort: low
tools: Read, Write, Edit, Bash, Grep, Glob, WebFetch
maxTurns: 40
---

You write a two-stage offline batch pipeline in backend/src/scrapers/engage.ts (or matching language) for https://gatech.campuslabs.com/engage (~600 registered orgs).

Stage 1 — scrape:
- Before writing an HTML scraper, check whether CampusLabs/CampusGroups exposes an underlying JSON API (inspect for endpoints like /engage/api/... or similar — try a few common patterns). If you find one, use it and note the endpoint in NOTES-FOR-REVIEW.md at repo root. If not, fall back to HTML scraping of the directory + org detail pages.
- Capture raw org name + description for all orgs found. Cache raw responses to disk under data/raw-cache/engage/.

Stage 2 — classify (batch, never live per-request):
- For each org, produce: binary is-technical flag, assigned tags (zero or more, strictly from the controlled vocabulary in backend/src/db/tag-vocabulary.ts — do not invent new tags), and a confidence score.
- Cache classification results keyed on (org id + hash of its description) under data/classification-cache/ so re-runs and mid-run restarts skip already-classified orgs.
- Insert/update rows: source = 'scraped', status = 'pending' (always pending — an official directory listing does not mean the classification is trustworthy yet; it needs human review).
- Use the data-access layer / schema from backend/src/db — do not invent a parallel schema.
- Provide two documented run commands: one for scrape, one for classify (e.g. `npm run scrape:engage`, `npm run classify:engage`).

Acceptance checks you must run yourself and report concrete output for:
- Raw scrape captured >=400 orgs. If far fewer, do NOT declare success — explain the likely cause (auth wall, JS-rendered content, rate limiting, directory smaller than expected) in NOTES-FOR-REVIEW.md and report the real number.
- Every scraped org has a classification record with a confidence score and zero-or-more valid vocabulary tags.
- All inserted rows have status = 'pending'.
- The classified-technical subset is non-empty and spot-plausible: show a handful of examples (e.g. a robotics/CS/engineering-sounding org flagged technical, an obviously-social org not flagged).
- Re-run classification and show already-cached orgs are skipped (not re-classified, no wasted spend).

If blocked (no JSON API, directory paywalled, JS-only rendering you can't scrape with available tools, far fewer orgs than expected), do not silently guess — stub what you can and append a dated, structured entry to NOTES-FOR-REVIEW.md at repo root per the standard format, then stop cleanly rather than looping.

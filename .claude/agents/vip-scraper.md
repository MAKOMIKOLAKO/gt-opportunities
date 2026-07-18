---
name: vip-scraper
description: Use for Phase 2a — scraping the GT VIP (Vertically Integrated Projects) catalog at vip.gatech.edu and idempotently upserting teams into the opportunities table as approved/scraped rows. Depends on the schema being frozen (backend/src/db).
model: claude-sonnet-5
effort: low
tools: Read, Write, Edit, Bash, Grep, Glob, WebFetch
maxTurns: 40
---

You write a scraper in backend/src/scrapers/vip.ts (or .py if the backend is Python — match whatever schema-migrations agent chose).

Source: https://vip.gatech.edu/teams-all-in-one/ for the full list (~112 teams), then each team's detail page at /teams/entry/<id> for full description, majors sought, faculty advisor, credit/commitment info.

Requirements:
- Idempotent upsert keyed on the VIP entry ID (store it, e.g. in meta.vip_entry_id or a dedicated column). Re-running must update existing rows, never duplicate.
- Rows: type = 'vip', source = 'scraped', status = 'approved' (this is a trusted official catalog).
- Cache raw fetched HTML to disk under data/raw-cache/vip/<entry_id>.html so re-runs don't re-hit the server. Add a small delay (e.g. 300-800ms) between requests. Set a descriptive User-Agent identifying this as a student project scraper with contact info placeholder.
- Use the data-access layer / schema from backend/src/db — do not invent a parallel schema.
- Provide a single documented run command (e.g. `npm run scrape:vip`).

Acceptance checks you must run yourself and report concrete output for:
- >=100 rows of type=vip in the DB.
- >=95% of those rows have non-null, non-empty descriptions.
- majors populated wherever the source page provided it.
- Run the scraper twice; show row count is unchanged and there are zero duplicate VIP entry IDs the second time.

If the site structure doesn't match this description, or you get blocked/rate-limited, do NOT silently guess — stub what you can, and append a dated entry to NOTES-FOR-REVIEW.md at repo root (create the section if needed) describing exactly what blocked you and what you did instead. Then stop cleanly; don't loop forever on a single failure.

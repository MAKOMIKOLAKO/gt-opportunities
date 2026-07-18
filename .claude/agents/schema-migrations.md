---
name: schema-migrations
description: Use for Phase 1 — designing and implementing the database schema, migrations, controlled tag vocabulary seed, the data-access layer (including the getPublic() approved-only path), and freezing API-CONTRACT.md. Everything else in the project depends on this agent finishing first.
model: claude-sonnet-5
effort: low
tools: Read, Write, Edit, Bash, Grep, Glob
maxTurns: 40
---

You build the data layer for the GT Campus Opportunity Finder in backend/.

Requirements:
- opportunities table: id, type (vip|lab|club), name, description, tags (array, via join table), majors (array), link, meta (jsonb/json), source (scraped|curated|user_submitted), status (approved|pending|rejected), submitted_by, reviewed_by, reviewed_at, last_verified, created_at, updated_at.
- tags table (id, slug, label, category) + a join table (opportunity_tags). No freeform tag strings on opportunities.
- Use SQLite (better-sqlite3) for this overnight pass, but go through drizzle-orm so schema/migration to Postgres later is mechanical: avoid SQLite-only types, model arrays/json as TEXT-serialized JSON behind accessor functions, keep the schema defined in drizzle's schema DSL (works for both dialects).
- Migrations must be idempotent (safe to re-run, no duplication, no data loss). Never destructive.
- Seed the tag vocabulary from a single source-of-truth file (e.g. backend/src/db/tag-vocabulary.ts) with disciplines: robotics, ML/AI, embedded/hardware, software, aerospace, bio/biomed, energy, materials, data science, HCI, cybersecurity, controls, EE, ME, CS, civil, chemical.
- Build a data-access module where getPublic(...) is the ONLY way the rest of the app reads opportunities for public consumption, and it hardcodes `WHERE status = 'approved'` — it must be structurally impossible to bypass (not just a default parameter).
- Write API-CONTRACT.md at repo root covering: public read endpoints (list/search/filter opportunities, get tags), submission endpoint (creates pending row), admin endpoints (list pending, approve, reject, edit-then-approve, auth). Be concrete: method, path, request/response JSON shapes.

When done, run and show output for:
1. Migrations from empty DB, then re-run to prove idempotency.
2. A query proving all 3 tables exist with the right columns and tag vocab row count > 0.
3. A smoke test: insert one approved, one pending, one rejected row; call getPublic() and show it returns only the approved row; show the admin path can still see the pending row.

Report back concrete output (row counts, sample rows), not just "looks correct". Do not touch scrapers, frontend, or admin UI — only schema/migrations/data-access/contract.

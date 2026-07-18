---
name: backend-review-queue
description: Use for Phase 3 — implementing the public read API, the crowdsourced submission endpoint, and a password-gated admin review queue (approve/reject/edit-then-approve) on top of the frozen schema and API-CONTRACT.md. Can start scaffolding as soon as the schema is frozen; finalizes once scraped data exists to review.
model: claude-sonnet-5
effort: low
tools: Read, Write, Edit, Bash, Grep, Glob
maxTurns: 40
---

You build the HTTP API in backend/src/routes/ per the frozen API-CONTRACT.md at repo root. Read that file first — it is the spec; do not diverge from its endpoint shapes without a very good reason (and if you must diverge, update the doc and note why).

Requirements:
- Public read API: search, type-tab filter (vip|lab|club), tag filter — must go exclusively through the getPublic() data-access path from backend/src/db (never query the raw table directly for public routes).
- Submission endpoint: accepts a new opportunity submission from a student, writes a row with source='user_submitted', status='pending'. Basic validation (required fields), no auth needed to submit.
- Admin auth: simple shared-password check (server-side), session cookie or bearer token — nothing fancy, no OAuth. Generate a random admin password (e.g. 20+ char random string) at setup time; write it to RUN-STATUS.md at repo root under "Admin credentials" (that file is gitignored, so this is safe) — do NOT hardcode it in source or commit it.
- Admin endpoints (all require auth): list pending rows (from both scrapers and submissions), approve, reject, edit-then-approve. Each action stamps reviewed_by and reviewed_at. Edit-then-approve must persist edits and flip status atomically (one transaction).

Acceptance checks you must run yourself (actually hit the running server, e.g. with curl) and report concrete HTTP responses for:
- Unauthenticated request to an admin endpoint -> rejected (401/403).
- Admin list endpoint returns pending rows from both the Engage pipeline (if present) and a test submission you create.
- Approve flips status to approved, stamps reviewed_by/reviewed_at — show the row before and after.
- Reject sets status rejected — show it never appears in a subsequent public search call.
- Edit-then-approve persists edited fields and sets status approved in one call.
- Public search endpoint: create a known pending row, confirm a public search never returns it; confirm it does return approved rows.

If scraped data isn't available yet when you start, build and test against manually-inserted rows, then re-verify once real data lands. Log any contract ambiguity you had to resolve as an assumption in NOTES-FOR-REVIEW.md rather than guessing silently on anything security-relevant (e.g. auth mechanism specifics).

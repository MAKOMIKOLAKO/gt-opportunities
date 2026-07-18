# Build Notes

Notes from adding the reviews feature (Addition 3) that need human
attention or future reconciliation. Not a full changelog — see git log /
API-CONTRACT.md for that.

## `reports` table duplicates in-progress work on another worktree

`worktree-reports-and-vip-search` (not merged as of this writing) is
independently prototyping a `reports` table for a general opportunity-report
flow. The review-dispute requirement in Addition 3 needed a reports
mechanism wired *now*, so this branch creates its own `reports` table in
`backend/src/db/schema.ts`, matching that branch's prototyped shape as
closely as possible:

```ts
export const REPORT_CATEGORIES = ["outdated_info", "broken_link", "wrong_contact", "other"] as const;
export const REPORT_STATUSES = ["open", "resolved"] as const;
export const reports = sqliteTable("reports", { ... });
```

Two deltas from the other branch's shape, both required for the
review-dispute flow:
- `reviewId` (nullable text, FK -> `reviews.id`) — lets a report target a
  specific review instead of/alongside an opportunity.
- `opportunityId` is nullable here (rather than `.notNull()`) so a report
  can be purely about a review; when a report *is* about a review, this
  branch still populates `opportunityId` from the review for context.

**When `worktree-reports-and-vip-search` merges, these two schema
definitions will collide** (two migrations creating a `reports` table).
Reconciliation needed:
1. Diff the two `reports` table definitions and pick one canonical shape
   (this branch's superset — with `reviewId` — is probably the right base).
2. Merge `insertReport`/`getReportsForAdmin`/`resolveReport` in
   `backend/src/db/data-access.ts` with whatever that branch built for
   general opportunity reporting (broken links, outdated info, etc.) —
   avoid ending up with two parallel "reports" concepts.
3. Squash the two migrations that both `CREATE TABLE reports` into one.

Per instructions, the other worktree was left untouched — this note is the
handoff.

## No rating field on reviews — this is permanent, not deferred

The spec explicitly excludes a numeric rating field: a score invites direct
comparison between labs/PIs, and a single bad semester could unfairly
dominate it. Reviews are three structured short-answer prompts only
(time commitment / before applying / advice for a new member). **Do not
add a rating field as a follow-on "easy win" without explicit human
sign-off** — if this idea comes up again, it needs a real product decision,
not an engineering shortcut.

## No auto-approval for reviews — logged for a human decision, not implemented

Two auto-approval mechanisms were explicitly *not* built, per spec:
- Keyword/profanity screening on review text.
- An LLM-based auto-approve step (e.g. asking a model to judge whether a
  review reads as "about the experience" vs. "an accusation about a named
  individual" and auto-approving/rejecting on that basis).

Both are plausible ways to reduce moderation burden as review volume grows,
but both also carry real risk of getting hard moderation calls wrong
without a human in the loop, especially the "named individual" distinction,
which is exactly the kind of judgment call that's hard to encode reliably.
This is deliberately left as **pending admin review only**, with the
moderation guidance text surfaced in the admin UI (`GET /api/admin/reviews`
`guidance` field, rendered in `frontend/public/admin.js`). If someone wants
to revisit auto-approval, it needs an explicit decision from a human owner
first — not a follow-on PR.

## Acceptance checks — all four passed

Verified manually against a running instance (see commit history / PR
description for the exact commands):

1. **No reviewer-identifying data stored anywhere.** Confirmed via direct
   sqlite inspection of the `reviews` row after submission — the table has
   no name/email/IP/user-agent column at all, and nothing in
   `backend/src/routes/public.ts` reads or logs request IP/UA for the
   review endpoints.
2. **Admin queue lists pending reviews linked to their opportunity.**
   `GET /api/admin/reviews?status=pending` joins through to
   `opportunities.name`, returning `opportunityId` + `opportunityName` on
   every row (`getReviewsForAdmin()` in `backend/src/db/data-access.ts`).
3. **Approve -> visible on detail; reject -> stays out of public view.**
   Verified via the actual `getPublic()`/`getApprovedReviews()` read path
   (not by eyeballing): a rejected review's id does not appear in
   `GET /api/opportunities/:id`'s `reviews` array; an approved one does.
4. **Flagging a published review creates a linked, visible admin entry.**
   `POST /api/reviews/:id/report` (review must currently be approved, via
   `getApprovedReviewById()`) creates a `reports` row with `reviewId` set
   and `opportunityId` carried through for context; it shows up in
   `GET /api/admin/reports?status=open`.

No partial/broken paths were shipped — everything above was exercised
end-to-end against a real sqlite db before this note was written.

## Frontend admin panel is net-new

There was no admin frontend anywhere in the repo before this change (only
the backend `/api/admin/*` routes existed, unused by any UI). This branch
adds a minimal `frontend/public/admin.html` + `admin.js`: login form, a
pending-reviews queue with the moderation guidance surfaced inline, and a
reports/disputes queue. It intentionally does **not** build UI for the
existing opportunity-approval queue (`GET/POST /api/admin/opportunities/*`)
— that's a working API with no consumer, but building its UI wasn't in
scope for the reviews addition and would have been scope creep.

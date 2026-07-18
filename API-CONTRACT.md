# API Contract — GT Campus Opportunity Finder

Backend: Express + TypeScript. All request/response bodies are JSON
(`Content-Type: application/json`). Base path: `/api`.

Data model reference: `backend/src/db/schema.ts` (source of truth for field
names/types). The `Opportunity` shape returned by every endpoint below is the
`OpportunityDTO` produced by `backend/src/db/data-access.ts`:

```json
{
  "id": 1,
  "type": "vip",
  "name": "String",
  "description": "String",
  "majors": ["CS", "EE"],
  "link": "https://example.com",
  "meta": { "any": "extra scraped/curated fields go here" },
  "source": "scraped",
  "status": "approved",
  "submittedBy": null,
  "reviewedBy": null,
  "reviewedAt": null,
  "lastVerified": "2026-07-01",
  "createdAt": "2026-07-01 12:00:00",
  "updatedAt": "2026-07-01 12:00:00",
  "tags": [{ "slug": "robotics", "label": "Robotics", "category": "discipline" }]
}
```

`type` is one of `vip | lab | club`. `source` is one of
`scraped | curated | user_submitted`. `status` is one of
`approved | pending | rejected`.

### Review shape (`ReviewDTO`, Addition 3)

Anonymous, structured, text-only. **No numeric rating field — this is
intentional, not a gap; see `BUILD_NOTES.md`.**

```json
{
  "id": "ec1a65ba-fe22-436d-9954-ab80a17189a5",
  "opportunityId": 1,
  "timeCommitment": "About 8 hrs/week",
  "beforeApplying": "Know some Python",
  "adviceNewMember": "Ask questions early",
  "status": "approved",
  "createdAt": "2026-07-18 13:44:53",
  "reviewedBy": null,
  "reviewedAt": null
}
```

`id` is a UUID (text), unlike the integer PKs used elsewhere — required by
spec. `status` is one of `pending | approved | rejected`. Nothing on this
row identifies the submitter: no name/email/IP/user-agent field exists on
the table.

### Report shape (`ReportDTO`, Addition 3)

```json
{
  "id": 1,
  "opportunityId": 1,
  "reviewId": "ec1a65ba-fe22-436d-9954-ab80a17189a5",
  "category": "other",
  "details": "Contains an accusation about a specific officer",
  "reporterContact": null,
  "status": "open",
  "createdAt": "2026-07-18 13:45:12",
  "resolvedBy": null,
  "resolvedAt": null
}
```

`category` is one of `outdated_info | broken_link | wrong_contact | other`.
`status` is one of `open | resolved`. `reviewId` is set when the report is a
dispute against a specific review (as opposed to a general report about the
opportunity itself); `opportunityId` is still carried for context in that
case. `reporterContact` is optional and never required.

---

## Public endpoints

### `GET /api/opportunities`

List/search/filter approved opportunities. Backed by
`getPublic()` — status is always `approved`; there is no way to request other
statuses through this endpoint.

Query params (all optional, combinable):

| param | type | notes |
|---|---|---|
| `type` | `vip \| lab \| club` | exact match |
| `search` | string | substring match against name + description |
| `tags` | comma-separated tag slugs, e.g. `robotics,ml-ai` | opportunity must have at least one matching tag |

Example: `GET /api/opportunities?type=vip&tags=robotics,ml-ai&search=drone`

Response `200`:
```json
{
  "results": [ /* array of Opportunity, shape above */ ],
  "count": 1
}
```

### `GET /api/opportunities/:id`

Fetch a single approved opportunity by id.

Response `200`: `{ "result": Opportunity }` — `Opportunity` here includes a
`reviews` array (Addition 3): approved reviews for this opportunity only,
most-recent-first. Backed by `getApprovedReviews()` — structurally cannot
include pending/rejected reviews.
Response `404`: `{ "error": "not_found" }` (also returned if the row exists
but is not approved — public callers must not be able to distinguish
"pending/rejected" from "doesn't exist").

### `POST /api/opportunities/:id/reviews`

Public review submission (Addition 3). No auth, no identifying info
collected or stored. Creates a `status = "pending"` review — never directly
visible until an admin approves it.

Request body — exactly the three structured prompts, all required
non-empty strings, **no rating field**:
```json
{
  "timeCommitment": "About 8 hrs/week",
  "beforeApplying": "Know some Python",
  "adviceNewMember": "Ask questions early"
}
```
Response `201`: `{ "result": { "id": "uuid", "status": "pending" } }`
Response `400`: `{ "error": "validation_error", "details": [...] }`
Response `404`: `{ "error": "not_found" }` if the opportunity isn't
publicly visible (approved).

### `POST /api/reviews/:id/report`

Dispute/flag a specific **published** review for re-review (Addition 3).
No auth required — a PI/advisor/club leader flagging a review doesn't need
an account. Extends the reports mechanism with `reviewId` set.

Request body:
```json
{
  "category": "other",
  "details": "Contains an accusation about a specific officer",
  "reporterContact": "optional, e.g. an email to follow up with"
}
```
`category` is one of `outdated_info | broken_link | wrong_contact | other`.
Response `201`: `{ "result": { "id": 1, "status": "open" } }`
Response `400`: `{ "error": "validation_error", "details": [...] }`
Response `404`: `{ "error": "not_found" }` if `:id` isn't a currently
approved review.

### `GET /api/tags`

List the full tag vocabulary (for building filter UI).

Response `200`:
```json
{
  "results": [
    { "id": 1, "slug": "robotics", "label": "Robotics", "category": "discipline" }
  ]
}
```

### `POST /api/opportunities/submit`

Public submission form. Creates a new opportunity row with
`source = "user_submitted"` and `status = "pending"` — never directly
approved.

Request body:
```json
{
  "type": "club",
  "name": "String (required)",
  "description": "String (required)",
  "majors": ["CS"],
  "link": "https://example.com",
  "tagSlugs": ["robotics"],
  "submittedBy": "gtusername@gatech.edu"
}
```

Response `201`:
```json
{ "result": { "id": 42, "status": "pending" } }
```
Response `400`: `{ "error": "validation_error", "details": ["name is required"] }`

---

## Admin endpoints

All admin endpoints require authentication. Session is established via
`POST /api/admin/login` and then either a cookie (`connect.sid`-style
session) or a bearer token is sent as `Authorization: Bearer <token>` on
subsequent requests — implementation detail for Phase 3, but every admin
route below returns `401 { "error": "unauthorized" }` if the credential is
missing/invalid, and these routes must call `getForAdmin()` /
admin-only mutation helpers, never `getPublic()`.

### `POST /api/admin/login`

Request:
```json
{ "username": "admin", "password": "string" }
```
Response `200`: `{ "token": "opaque-session-token" }`
Response `401`: `{ "error": "invalid_credentials" }`

### `GET /api/admin/opportunities?status=pending`

List opportunities for the review queue. Backed by `getForAdmin()`.
`status` query param optional (`approved | pending | rejected`); omitted =
all statuses. Same `type`/`search` params as the public list endpoint are
also supported.

Response `200`: `{ "results": [ /* Opportunity[] */ ], "count": 3 }`

### `POST /api/admin/opportunities/:id/approve`

Marks a pending (or rejected) row `approved`, stamping `reviewedBy` and
`reviewedAt`.

Request body: `{}` (no body required)
Response `200`: `{ "result": Opportunity }`
Response `404`: `{ "error": "not_found" }`

### `POST /api/admin/opportunities/:id/reject`

Marks a row `rejected`, stamping `reviewedBy`/`reviewedAt`.

Request body (optional reason, stored in `meta.rejectionReason`):
```json
{ "reason": "duplicate listing" }
```
Response `200`: `{ "result": Opportunity }`

### `PATCH /api/admin/opportunities/:id`

Edit-then-approve flow: updates any editable fields and, if
`approve: true` is passed, also flips status to `approved` in the same
request (stamping `reviewedBy`/`reviewedAt`).

Request body (all fields optional except none required):
```json
{
  "name": "Corrected Name",
  "description": "Corrected description",
  "majors": ["CS", "ME"],
  "link": "https://corrected.example.com",
  "tagSlugs": ["robotics", "controls"],
  "approve": true
}
```
Response `200`: `{ "result": Opportunity }`
Response `404`: `{ "error": "not_found" }`
Response `400`: `{ "error": "validation_error", "details": ["..."] }`

### `GET /api/admin/reviews?status=pending` (Addition 3)

List reviews for the moderation queue, each linked to its opportunity via
`opportunityId` **and** `opportunityName` (so the queue never needs a
second lookup to show what's being reviewed). Backed by
`getReviewsForAdmin()`. `status` optional (`pending | approved | rejected`);
omitted = all statuses.

Response `200` also includes a fixed `guidance` string — the moderation
guidance the admin UI must surface near the approve/reject controls:
> Approve accounts of the experience (workload, structure, onboarding,
> culture). Reject or send back for edit anything that reads as a specific
> accusation about a named individual's conduct. This is a judgment call
> per review — not automatable.

There is deliberately no keyword/profanity auto-screening and no LLM
auto-approve step (see `BUILD_NOTES.md`).

```json
{
  "results": [
    {
      "id": "uuid",
      "opportunityId": 1,
      "opportunityName": "Test Robotics Club",
      "timeCommitment": "...",
      "beforeApplying": "...",
      "adviceNewMember": "...",
      "status": "pending",
      "createdAt": "...",
      "reviewedBy": null,
      "reviewedAt": null
    }
  ],
  "count": 1,
  "guidance": "..."
}
```

### `POST /api/admin/reviews/:id/approve`

Marks a review `approved`, stamping `reviewedBy`/`reviewedAt`. Makes it
visible on the opportunity's public detail response.

Response `200`: `{ "result": Review }`
Response `404`: `{ "error": "not_found" }`

### `POST /api/admin/reviews/:id/reject`

Marks a review `rejected`, stamping `reviewedBy`/`reviewedAt`. Never
appears in any public response.

Response `200`: `{ "result": Review }`
Response `404`: `{ "error": "not_found" }`

### `GET /api/admin/reports?status=open` (Addition 3)

List reports/disputes for the moderation queue — both general opportunity
reports and review disputes (`reviewId` set). Backed by
`getReportsForAdmin()`. `status` optional (`open | resolved`); omitted =
all statuses.

Response `200`: `{ "results": [ /* Report[] */ ], "count": 1 }`

### `POST /api/admin/reports/:id/resolve`

Marks a report `resolved`, stamping `resolvedBy`/`resolvedAt`.

Response `200`: `{ "result": Report }`
Response `404`: `{ "error": "not_found" }`

---

## Error shape (all endpoints)

Non-2xx responses always return:
```json
{ "error": "machine_readable_code", "details": ["optional", "human strings"] }
```

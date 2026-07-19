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
  "meta": { "any": "scraper/admin bookkeeping (e.g. vipEntryId, rejectionReason)" },
  "details": {
    "goals": "...",
    "issues_addressed": "...",
    "partners_sponsors": "...",
    "methods_technologies": "...",
    "majors_by_category": { "Engineering": ["Computer Engineering"] },
    "preferred_interests": "...",
    "advisor_name": "...",
    "advisor_email": "...",
    "advisor_department": "...",
    "meeting_info": "..."
  },
  "source": "scraped",
  "status": "approved",
  "submittedBy": null,
  "iconUrl": null,
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

`iconUrl` (org profile icon feature) is the live, publicly-served icon URL,
or `null` if none has been approved yet — frontend falls back to a
colored-initials placeholder when it's null. There is also an admin-only
`iconPendingUrl` field (a submitted-but-not-yet-approved replacement icon)
that is **only** present on admin responses (`getByIdForAdmin`/the pending
icons queue below) — it is never included in any public response, including
`GET /api/opportunities` and `GET /api/opportunities/:id`.

`details` is a free-form JSON object (jsonb-equivalent, like `meta`) for
type-specific structured fields that don't apply across vip/lab/club rows —
the keys above are what the VIP scraper populates; lab/club rows may have an
empty `details: {}` or different keys entirely. Every string value nested in
`details` (plus `name`/`description`/`majors`/tag labels) feeds a combined
full-text search index (SQLite FTS5, this project's tsvector equivalent) —
`GET /api/opportunities?search=` and the admin equivalent both query it, so a
search for a term that only appears in `details` (e.g. a methods/technologies
entry or an advisor's name) still surfaces the right opportunity.

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

### Link shape (`LinkDTO`, Additional org links)

Additional org links beyond "how to apply" — `opportunities.link` remains
the single primary how-to-apply link; this is a proper child table for
everything else (apply-adjacent, homepage, social, other), following the
same pending -> admin-review -> approved lifecycle as reviews/reports.

```json
{
  "id": 1,
  "opportunityId": 1,
  "label": "Team Instagram",
  "url": "https://instagram.com/example",
  "type": "social",
  "status": "approved",
  "submittedBy": null,
  "createdAt": "2026-07-18 13:44:53",
  "reviewedBy": null,
  "reviewedAt": null
}
```

`type` is one of `apply | homepage | social | other` — a plain text column
with app-level validation, deliberately extensible later. `status` is one
of `pending | approved | rejected`.

### Suggested edit shape (`SuggestedEditDTO`, Addition: suggest edits on existing listings)

A proposed correction to a single field on an existing opportunity, awaiting
admin review.

```json
{
  "id": 1,
  "opportunityId": 1,
  "field": "description",
  "oldValue": "Old description text",
  "newValue": "Corrected description text",
  "submittedBy": "gtusername@gatech.edu",
  "status": "pending",
  "createdAt": "2026-07-19 09:00:00",
  "reviewedBy": null,
  "reviewedAt": null
}
```

`field` is one of `name | description | link | majors` — a fixed
server-side allowlist (`SUGGESTABLE_FIELDS` in
`backend/src/db/data-access.ts`); arbitrary/internal fields (`status`,
`source`, `meta`, `id`, etc.) can never be suggested. `oldValue` is a
server-captured snapshot of the field's value at submission time (never
client-supplied) — nullable because `link` itself is nullable. For the
`majors` field, both `oldValue` and `newValue` are the JSON-serialized array
string, matching how `majors` is stored on the opportunity row. `status` is
one of `pending | approved | rejected`.

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
| `search` | string | full-text match against name, description, majors, tag labels, and every string value in `details` (not just description) |
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
include pending/rejected reviews. It also includes a `links` array
(additional org links): approved links only, `apply`-typed rows first, then
creation order. Backed by `getApprovedLinks()` — structurally cannot
include pending/rejected links.

Also includes a `relatedOrgs` array (Related Organizations feature):
0-8 other approved `Opportunity` objects (same shape as above, minus
`reviews`/`relatedOrgs` themselves — no nesting), ordered most-related
first. Backed by a precomputed cache (`related_opportunities` table),
never computed live per request — see `BUILD_NOTES.md`. Matching is
embedding-based (cosine similarity over `text-embedding-3-large`
embeddings of name + description + tag labels) with a small tag-overlap
boost on top; matching is deliberately **cross-category** — `type`
(vip/lab/club) is never used as a scoring signal, so a VIP team and an
Engage club can appear in each other's `relatedOrgs` with zero shared
tags. **`relatedOrgs` is `[]` until `OPENAI_API_KEY` is configured and
embeddings have been generated** (see `.env.example`) — the field is
always present, just empty until then.

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

### `POST /api/opportunities/:id/links`

Public submission of an additional org link (Additional org links). No
auth. Creates a `status = "pending"` link — never directly visible until
an admin approves it.

Request body:
```json
{
  "label": "Team Instagram",
  "url": "https://instagram.com/example",
  "type": "social",
  "submittedBy": "optional, e.g. gtusername@gatech.edu"
}
```
`type` is required, one of `apply | homepage | social | other`.
Response `201`: `{ "result": { "id": 1, "status": "pending" } }`
Response `400`: `{ "error": "validation_error", "details": [...] }`
Response `404`: `{ "error": "not_found" }` if the opportunity isn't
publicly visible (approved).

### `POST /api/opportunities/:id/suggest-edit`

Suggest a correction to a single field on an existing, publicly visible
opportunity (Addition: suggest edits on existing listings). No auth
required. Creates a `status = "pending"` row in the Suggested Edits admin
queue — never applied to the live listing until an admin approves it.

Request body:
```json
{
  "field": "description",
  "newValue": "Corrected description text",
  "submittedBy": "gtusername@gatech.edu"
}
```
`field` is required and must be one of `name | description | link | majors`
(server-enforced allowlist — any other value is rejected, not silently
mapped). For `field: "majors"`, `newValue` must be the JSON-serialized array
string (e.g. `"[\"CS\",\"ME\"]"`), matching the stored representation.
`submittedBy` is optional, free text (e.g. an email), never validated as an
identity.

`oldValue` is NOT accepted from the client — the server reads the field's
current value itself before inserting the suggestion, and rejects the
request as a no-op if `newValue` is identical to the current value.

Response `201`: `{ "result": { "id": 1, "status": "pending" } }`
Response `400`: `{ "error": "validation_error", "details": [...] }` — bad/missing
`field`, missing `newValue`, or `newValue` identical to the current value.
Response `404`: `{ "error": "not_found" }` if the opportunity isn't publicly
visible (approved).

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
  "submittedBy": "gtusername@gatech.edu",
  "links": [
    { "label": "Team Instagram", "url": "https://instagram.com/example", "type": "social" }
  ]
}
```
`links` is optional — an array of additional org links to create alongside
the opportunity (each becomes a `status = "pending"` row in the same way as
`POST /api/opportunities/:id/links`). Each entry is validated individually;
a malformed entry (missing `label`/`url`, or an invalid `type`) is silently
skipped rather than failing the whole submission.

Response `201`:
```json
{ "result": { "id": 42, "status": "pending" } }
```
Response `400`: `{ "error": "validation_error", "details": ["name is required"] }`

### `POST /api/opportunities/:id/icon` (org profile icon feature)

Public submission of a candidate icon/logo URL for an **existing, publicly
visible (approved)** opportunity — there is no id to attach an icon to until
an org has been approved, so this only makes sense from the org detail page,
not the "submit an org" form. Sets `iconPendingUrl` only; never touches the
live `iconUrl`. Accepts a URL, not a file upload — there's no object storage
configured in this app.

Request body:
```json
{ "url": "https://example.com/logo.png" }
```
Validation: `url` required, `https://` only, max 2048 chars, must end in
`.png|.jpg|.jpeg|.gif|.webp|.svg` (optionally followed by a `?query`). This
is a best-effort format check, not a fetch-and-verify of the actual image
content/type — see `BUILD_NOTES.md` for why (SSRF considerations).

Response `201`: `{ "result": { "id": 42, "iconPendingUrl": "https://example.com/logo.png" } }`
Response `400`: `{ "error": "validation_error", "details": ["url must be an https:// link ending in .png, .jpg, .jpeg, .gif, .webp, or .svg"] }`
Response `404`: `{ "error": "not_found" }` — same "public callers can't
distinguish pending/rejected from doesn't-exist" convention as other public
routes.

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

### `GET /api/admin/icons/pending` (org profile icon feature)

List opportunities with a pending icon submission awaiting review
(`iconPendingUrl IS NOT NULL`). Backed by `getPendingIcons()`.

Response `200`:
```json
{
  "results": [
    { "id": 1, "name": "Test Robotics Club", "iconUrl": null, "iconPendingUrl": "https://example.com/logo.png" }
  ],
  "count": 1
}
```

### `POST /api/admin/opportunities/:id/icon/approve`

Promotes the pending icon to live: copies `iconPendingUrl` → `iconUrl`,
clears `iconPendingUrl`, stamps `updatedAt`. Does **not** touch the
opportunity's own `reviewedBy`/`reviewedAt` — those track the separate
opportunity approve/reject lifecycle.

Request body: `{}` (no body required)
Response `200`: `{ "result": Opportunity }` (admin variant, includes `iconPendingUrl: null`)
Response `404`: `{ "error": "not_found" }`

### `POST /api/admin/opportunities/:id/icon/reject`

Discards the pending icon submission (`iconPendingUrl = null`) without
touching the live `iconUrl`.

Request body: `{}` (no body required)
Response `200`: `{ "result": Opportunity }`
Response `404`: `{ "error": "not_found" }`

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

### `GET /api/admin/links?status=pending` (Additional org links)

List additional-org-link submissions for the moderation queue, each linked
to its opportunity via `opportunityId` **and** `opportunityName`. Backed by
`getLinksForAdmin()`. `status` optional (`pending | approved | rejected`);
omitted = all statuses.

Response `200`: `{ "results": [ /* (Link & { opportunityName }) [] */ ], "count": 1 }`

### `POST /api/admin/links/:id/approve`

Marks a link `approved`, stamping `reviewedBy`/`reviewedAt`. Makes it
visible on the opportunity's public detail response (`links` array).

Response `200`: `{ "result": Link }`
Response `404`: `{ "error": "not_found" }`

### `POST /api/admin/links/:id/reject`

Marks a link `rejected`, stamping `reviewedBy`/`reviewedAt`. Never appears
in any public response.

Response `200`: `{ "result": Link }`
Response `404`: `{ "error": "not_found" }`

### `GET /api/admin/suggested-edits?status=pending` (Addition: suggest edits on existing listings)

List suggested edits for the moderation queue, each linked to its
opportunity via `opportunityId` **and** `opportunityName` (same shape as the
reviews queue — no second lookup needed to show what's being edited).
Backed by `getSuggestedEditsForAdmin()`. `status` optional
(`pending | approved | rejected`); omitted = all statuses.

Response `200`:
```json
{
  "results": [
    {
      "id": 1,
      "opportunityId": 1,
      "opportunityName": "Test Robotics Club",
      "field": "description",
      "oldValue": "Old description text",
      "newValue": "Corrected description text",
      "submittedBy": "gtusername@gatech.edu",
      "status": "pending",
      "createdAt": "2026-07-19 09:00:00",
      "reviewedBy": null,
      "reviewedAt": null
    }
  ],
  "count": 1
}
```

### `POST /api/admin/suggested-edits/:id/approve`

Approves a pending suggested edit: writes `newValue` into the live
opportunity's `field` column (for `majors`, parses the JSON-serialized array
and re-serializes through `setMajors`), stamps the suggested-edit row
`approved`/`reviewedBy`/`reviewedAt`, and re-runs the opportunity's search
index refresh (name/description/majors all feed search). Both writes happen
in one transaction.

Response `200`: `{ "result": SuggestedEdit }`
Response `404`: `{ "error": "not_found" }`

### `POST /api/admin/suggested-edits/:id/reject`

Marks a suggested edit `rejected`, stamping `reviewedBy`/`reviewedAt`. No
write to the live opportunity row.

Response `200`: `{ "result": SuggestedEdit }`
Response `404`: `{ "error": "not_found" }`

---

## Error shape (all endpoints)

Non-2xx responses always return:
```json
{ "error": "machine_readable_code", "details": ["optional", "human strings"] }
```

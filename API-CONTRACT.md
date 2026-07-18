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

Response `200`: `{ "result": Opportunity }`
Response `404`: `{ "error": "not_found" }` (also returned if the row exists
but is not approved — public callers must not be able to distinguish
"pending/rejected" from "doesn't exist").

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

---

## Error shape (all endpoints)

Non-2xx responses always return:
```json
{ "error": "machine_readable_code", "details": ["optional", "human strings"] }
```

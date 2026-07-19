# Build notes — File storage for org icon uploads (2026-07-19)

Built directly on top of the merged icon submission feature (see
`BUILD_NOTES_ICON_FEATURE.md`) on the `integration` branch, replacing its
URL-only submission with a real file upload.

## What was built

- **Provider: Cloudflare R2** (S3-compatible), not AWS S3. No existing
  storage credentials/config were found anywhere in the repo (`.env.example`,
  `vercel.json`, `railway.json`) — chosen per the task's default, since R2's
  API is a drop-in match for the AWS SDK v3 S3 client (same
  `PutObjectCommand`, just pointed at R2's account-scoped endpoint) at
  meaningfully cheaper egress than S3, and there was no signal favoring AWS.
- **`backend/src/lib/storage.ts`** (new): `uploadIcon(opportunityId, buffer,
  mimeType)` — validates nothing itself (callers must validate MIME/size
  first), uploads to `icons/pending/{opportunityId}/{uuid}.{ext}` via a
  lazily-constructed `S3Client`, returns the public URL
  (`${R2_PUBLIC_URL}/${key}`). Exports `ALLOWED_ICON_MIME_TYPES` (png, jpeg,
  gif, webp, svg) and `MAX_ICON_UPLOAD_BYTES` (2 MiB) as the single source of
  truth the route imports.
- **Route** (`backend/src/routes/public.ts`): `POST
  /api/opportunities/:id/icon` now accepts `multipart/form-data` (field name
  `icon`) instead of a JSON `{ url }` body — same endpoint path, same
  pending/approved lifecycle, same 404-if-not-public convention, just a
  different request shape. Uses `multer` (memory storage, size-limited) to
  parse the upload; `handleIconUpload` wraps multer's middleware to turn a
  `MulterError` (e.g. file too large) into a proper `400` instead of falling
  through to the app's generic 500 handler. MIME type is checked against the
  actual uploaded file's `mimetype` (multer/browser-supplied, sniffed from
  the multipart part), not a filename extension.
- **Removed**: the old `ICON_URL_PATTERN`/`ICON_URL_MAX_LENGTH`
  format-only validation and its SSRF TODO comment — uploading bytes
  directly means the server never fetches an arbitrary user-supplied URL, so
  that whole class of concern doesn't apply anymore.
- **Approval**: unchanged — `approveIcon()`/`rejectIcon()` in
  `data-access.ts` already just copy/clear `iconPendingUrl` <-> `iconUrl`
  (both are stable public R2 URLs under the same bucket), so no
  move-to-`icons/approved/` step was added. Promoting the pending URL as-is
  was explicitly called out as acceptable in the task brief, and there's no
  reason to add an extra copy operation for a URL that's already publicly
  stable.
- **Frontend** (`frontend/public/app.js`): the icon submission form
  (`renderIconSubmitBlock`) now renders `<input type="file" name="icon"
  accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" />`
  instead of a URL text field. `submitIcon()` posts a `FormData` (no
  `Content-Type` header set manually — the browser sets the multipart
  boundary itself). `handleIconSubmit()` reads `form.icon.files[0]` and
  short-circuits with a client-side message if nothing was chosen (the
  server still re-validates regardless).
- **Env vars** (`.env.example`): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` — all blank
  placeholders, with setup steps (create bucket, create scoped API token,
  enable public access, get the public base URL) documented inline.

## Secrets that need to be set before this is live

All five `R2_*` vars above, in whatever env store the deploy target reads
from (Vercel dashboard per `.env.example`'s existing convention — the repo
also supports Railway, see `.env.example`'s header note). Until they're set,
`POST /api/opportunities/:id/icon` throws inside `uploadIcon()` the moment a
real upload is attempted (a clear "R2 is not configured" error, not a silent
no-op) — nothing else in the app depends on these vars.

## Deferred / not attempted

- No image resizing/thumbnailing on upload — stores the original file as-is
  up to the 2 MiB cap. Not asked for; the existing admin queue already
  renders thumbnails via CSS (`.icon-compare-thumb`), not a server-resized
  asset.
- No cleanup job for orphaned pending uploads (a user uploads, never gets
  approved, the object sits in `icons/pending/` forever). Same "not asked
  for, don't over-engineer" call as the rest of this batch — R2 storage is
  cheap at this scale (a handful of small images), and a lifecycle rule can
  be added in the R2 dashboard directly (no code needed) if it ever matters.

## Verification performed

- `cd backend && npx tsc --noEmit` — clean.
- `node --check frontend/public/app.js` — parses cleanly.
- No live upload exercised — no R2 credentials configured in this
  environment (consistent with every other worktree in this batch having no
  reachable `DATABASE_URL`/`OPENAI_API_KEY`).

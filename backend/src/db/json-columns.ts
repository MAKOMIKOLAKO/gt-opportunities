// Single sanctioned place to normalize the jsonb columns
// (`opportunities.majors`, `opportunities.meta`, `opportunities.details`).
// Nothing else in the codebase should poke at their shape directly — that
// keeps this the one file that would need to change again if the storage
// representation ever changes.
//
// Under Postgres/jsonb, the driver already hands back parsed JS values (not
// strings) and serializes plain objects/arrays back to jsonb on write, so
// these are now just defensive normalizers rather than JSON.parse/stringify
// wrappers (that was the SQLite-TEXT-column era). They still accept
// `unknown` because a nullable/legacy column value could in principle come
// back as `null` or something unexpected.

export function getMajors(majors: unknown): string[] {
  return Array.isArray(majors) ? (majors as string[]) : [];
}

export function setMajors(majors: string[]): string[] {
  return majors ?? [];
}

export function getMeta(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

export function setMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return meta ?? {};
}

// `details` holds type-specific structured fields (VIP's advisor_email,
// methods_technologies, etc.) that don't apply across vip/lab/club rows.
// Same jsonb pattern as `meta` — go through these accessors only.
export function getDetails(details: unknown): Record<string, unknown> {
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
}

export function setDetails(details: Record<string, unknown>): Record<string, unknown> {
  return details ?? {};
}

// Recursively collects every string leaf out of an arbitrary JSON-ish value
// (nested objects/arrays included) for feeding into the search index.
function flattenStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) flattenStrings(v, out);
  }
}

/**
 * Builds the denormalized blob indexed for full-text search (queried via
 * `to_tsvector('english', search_blob) @@ plainto_tsquery(...)` in
 * data-access.ts — this project's Postgres tsvector equivalent, backed by a
 * GIN expression index, see migrations/0000). Concatenates name,
 * description, tag labels, and every string value nested inside `details`
 * so a search for e.g. "Tsiotras" or "ROS" reaches fields that never show
 * up in the short description. `majors` ("majors sought") is deliberately
 * excluded — it's a filter facet, not something users expect a free-text
 * search to match against.
 */
export function buildSearchBlob(fields: {
  name: string;
  description: string;
  majors: string[];
  details: Record<string, unknown>;
  tagLabels?: string[];
}): string {
  const parts: string[] = [fields.name, fields.description, ...(fields.tagLabels ?? [])];
  flattenStrings(fields.details, parts);
  return parts.filter(Boolean).join(" \n ");
}

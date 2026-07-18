// Single sanctioned place to (de)serialize the TEXT-as-JSON columns
// (`opportunities.majors`, `opportunities.meta`). Nothing else in the codebase
// should call JSON.parse/JSON.stringify on these fields directly — that keeps
// the eventual Postgres migration (native text[] / jsonb) to a one-file change.

export function getMajors(majorsJson: string): string[] {
  try {
    const parsed = JSON.parse(majorsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setMajors(majors: string[]): string {
  return JSON.stringify(majors ?? []);
}

export function getMeta(metaJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function setMeta(meta: Record<string, unknown>): string {
  return JSON.stringify(meta ?? {});
}

// `details` holds type-specific structured fields (VIP's advisor_email,
// methods_technologies, etc.) that don't apply across vip/lab/club rows.
// Same TEXT-as-JSON pattern as `meta` — go through these accessors only.
export function getDetails(detailsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(detailsJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function setDetails(details: Record<string, unknown>): string {
  return JSON.stringify(details ?? {});
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
 * Builds the denormalized blob indexed by `opportunities_fts` (this
 * project's SQLite stand-in for a Postgres tsvector column). Concatenates
 * name, description, tag labels, and every string value nested inside
 * `details` so a search for e.g. "Tsiotras" or "ROS" reaches fields that
 * never show up in the short description. `majors` ("majors sought") is
 * deliberately excluded — it's a filter facet, not something users expect
 * a free-text search to match against.
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

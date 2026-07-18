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

// Small utilities used by every source. `URLSearchParams` isn't
// available in JavaScriptCore on iOS, so we hand-roll a tiny replacement
// with the same shape (.append → URL-encoded `k=v` pairs).

export class QueryBuilder {
  private parts: string[] = [];

  append(key: string, value: string | number): this {
    this.parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    return this;
  }

  toString(): string {
    return this.parts.join("&");
  }
}

/// Convenience — build a query string from an object literal. Skips
/// undefined / null values.
export function qs(entries: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (v == null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

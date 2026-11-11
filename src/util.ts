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

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", bdquo: "„", middot: "·",
};

/// Editor HTML → plain text for descriptions: block breaks become newlines,
/// tags are dropped, named and numeric entities are decoded.
export function htmlToText(input: string): string {
  return input
    .replace(/\r/g, "")
    .replace(/<br\s*\/?>\n?/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] === "#") {
        const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface RichNode { type?: string; text?: string; content?: RichNode[] }

/// Lib-family descriptions arrive either as an HTML string or as a
/// ProseMirror document. Both become plain text with paragraph breaks.
export function richText(value: unknown): string | undefined {
  if (typeof value === "string") return htmlToText(value) || undefined;
  if (value == null || typeof value !== "object") return undefined;
  const blocks: string[] = [];
  const inline = (n: RichNode): string =>
    n.type === "text" ? n.text ?? "" : n.type === "hardBreak" ? "\n" : (n.content ?? []).map(inline).join("");
  const walk = (n: RichNode) => {
    if (n.type === "paragraph" || n.type === "heading") blocks.push(inline(n).trim());
    else (n.content ?? []).forEach(walk);
  };
  walk(value as RichNode);
  return blocks.filter((b) => b.length > 0).join("\n\n") || undefined;
}

/// Unique, non-empty strings in first-seen order.
export function uniqueStrings(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = v?.trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

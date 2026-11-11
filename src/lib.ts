import type { MangaDetails, MangaSummary } from "./source";
import { richText, uniqueStrings } from "./util";

// Shared by the "Lib" family (Mangalib, Ranobelib): same api2.mangalib.me
// backend, same detail payload.

/// Every detail field the title page can show. The API omits anything not
/// asked for with `fields[]`.
export const LIB_DETAIL_FIELDS = [
  "summary", "genres", "tags", "authors", "artists", "publisher",
  "rate_avg", "releaseDate", "otherNames",
];

interface Named { name?: string | null; rus_name?: string | null }

export interface LibDetailPayload {
  name?: string | null;
  rus_name?: string | null;
  eng_name?: string | null;
  otherNames?: string[] | null;
  summary?: unknown;
  releaseDate?: string | null;
  genres?: Named[] | null;
  tags?: Named[] | null;
  authors?: Named[] | null;
  artists?: Named[] | null;
  publisher?: Named[] | null;
}

const names = (list: Named[] | null | undefined): string | undefined =>
  uniqueStrings((list ?? []).map((p) => p.rus_name || p.name)).join(", ") || undefined;

export function libDetails(m: LibDetailPayload, summary: MangaSummary): MangaDetails {
  const year = parseInt(m.releaseDate ?? "", 10);
  return {
    summary,
    titleAlt: uniqueStrings([m.eng_name, m.name, ...(m.otherNames ?? [])])
      .filter((t) => t !== summary.title)
      .join(" / ") || undefined,
    titleOriginal: m.name ?? undefined,
    description: richText(m.summary),
    author: names(m.authors),
    artist: names(m.artists),
    publisher: names(m.publisher),
    year: Number.isFinite(year) && year > 1900 ? year : undefined,
    genres: uniqueStrings((m.genres ?? []).map((g) => g.name)),
    tags: uniqueStrings((m.tags ?? []).map((t) => t.name)),
  };
}

// Shared types for source extensions. Every source default-exports a
// class that implements `Source`. The iOS adapter `JSExtensionSource`
// translates these to native DTOs.

export type MangaStatus = "ongoing" | "completed" | "hiatus" | "cancelled" | "licensed" | "announced";
export type MangaType   = "manga" | "manhwa" | "manhua" | "comic" | "oel" | "other";
export type AgeRating   = "GENERAL" | "SENSITIVE" | "QUESTIONABLE" | "EXPLICIT";
export type ReadingMode = "auto" | "paged" | "webtoon";
export type MangaSort   = "lastChapter" | "score" | "createdAt";

export interface TriStateSet {
  include: string[];
  exclude: string[];
}

export interface MangaFilter {
  query: string;
  sort: MangaSort;
  type: TriStateSet;
  status: TriStateSet;
  rating: TriStateSet;
  format: TriStateSet;
  labels: TriStateSet;
}

export interface MangaSummary {
  // Source-local ID — the adapter prepends `<sourceID>:` to make it
  // globally unique.
  remoteID: string;
  slug?: string;
  title: string;
  coverURL?: string;
  rating?: number;
  chaptersCount?: number;
  nsfw?: boolean;
  status?: MangaStatus;
  type?: MangaType;
  ageRating?: AgeRating;
  formats?: string[];
}

export interface MangaPage {
  items: MangaSummary[];
  endCursor?: string;
  hasMore: boolean;
  totalCount?: number;
}

export interface MangaDetails {
  summary: MangaSummary;
  titleAlt?: string;
  titleOriginal?: string;
  description?: string;
  author?: string;
  artist?: string;
  publisher?: string;
  year?: number;
  genres: string[];
  tags: string[];
  preferredReadingMode?: ReadingMode;
}

export interface ChapterDTO {
  // Optional composite ID. If absent, the adapter builds
  // `<sourceID>:<remoteID>`. Mangalib-style sources use a richer
  // composite (`mangalib:slug:volume:number`) — pass it here.
  id?: string;
  remoteID: string;
  title?: string;
  number: number;
  volume?: number;
  language?: string;
  translator?: string;
  // ISO 8601 string, or unix epoch seconds. Adapter accepts both.
  publishedAt?: string | number;
  pageCount?: number;
  isPaid?: boolean;
}

export interface PageDTO {
  pageIndex: number;
  remoteURL: string;
  width?: number;
  height?: number;
  // Applied by the native image loader when it fetches this page
  // (Referer, User-Agent, Cookie for hot-link protected CDNs).
  headers?: Record<string, string>;
}

export interface LabelEntry {
  id: string;
  rootID?: string;
  slug: string;
  name: string;
}

export interface FilterTaxonomy {
  labels: LabelEntry[];
}

/// Every source extension must implement this. Methods are called from
/// native Swift via the runtime — they all return Promises.
export interface Source {
  mangaList(filter: MangaFilter, cursor: string | null): Promise<MangaPage>;
  mangaDetails(slug: string): Promise<MangaDetails>;
  chapters(mangaID: string): Promise<ChapterDTO[]>;
  pages(chapterID: string): Promise<PageDTO[]>;
  filterTaxonomy?(): Promise<FilterTaxonomy>;
  score?(slug: string): Promise<number | null>;
  /// Light-novel / web-novel sources implement this and return chapter
  /// content as an HTML string. Image-based manga sources omit it; the
  /// native reader then falls through to `pages()`.
  chapterText?(chapterID: string): Promise<string | null>;
}

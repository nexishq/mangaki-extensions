/// <reference path="../../src/host.d.ts" />
import type {
  Source, MangaFilter, MangaPage, MangaSummary, MangaDetails,
  ChapterDTO, PageDTO, MangaStatus, MangaType, AgeRating,
} from "../../src/source";
import { QueryBuilder, htmlToText, qs, uniqueStrings } from "../../src/util";

// Remanga — major Russian aggregator. REST API v2 at api.remanga.org
// (the v1 catalog/title/chapter endpoints now return 404).
// Cover CDN needs Referer: https://remanga.org/ (native side attaches it
// via MangakiImage when rendering images).
const API = "https://api.remanga.org";
const COVER_HOST = "https://remanga.org";
const CATALOG_PAGE_SIZE = 30;
const CHAPTER_LIST_PAGE_SIZE = 100;

function sortField(sort: string): string {
  switch (sort) {
    case "lastChapter": return "-chapter_date";
    case "score":       return "-rating";
    case "createdAt":   return "-id";
    default:            return "-chapter_date";
  }
}

// Filter ids from /api/forms/titles/?get=types&get=status&get=age_limit.
const TYPE_MAP: Record<string, number> = {
  MANGA: 1, MANHWA: 2, MANHUA: 3, OEL_MANGA: 4, COMICS: 4, RU_MANGA: 5,
};
const STATUS_MAP: Record<string, number> = {
  ONGOING: 2, FINISHED: 1, ANNOUNCE: 5, HIATUS: 3,
};
// Remanga only has 0 (all ages), 1 (16+) and 2 (18+).
const AGE_MAP: Record<string, number> = {
  QUESTIONABLE: 1, EXPLICIT: 2,
};

const STATUS_INV: Record<number, MangaStatus> = {
  1: "completed", 2: "ongoing", 3: "hiatus", 5: "announced", 6: "licensed",
};
const TYPE_INV: Record<number, MangaType> = {
  1: "manga", 2: "manhwa", 3: "manhua", 4: "oel", 5: "comic", 6: "comic", 7: "other", 22: "other",
};
const AGE_INV: Record<number, AgeRating> = {
  0: "GENERAL", 1: "QUESTIONABLE", 2: "EXPLICIT",
};

// The catalog and search endpoints carry no age rating, and the API can't
// be asked for "0+ and 16+ only" (`age_limit=0` is read as "no filter"). So
// while 18+ is hidden, each title's age comes from its detail page. Cached
// per dir for the life of the extension; looked up a few at a time.
const AGE_LOOKUP_CONCURRENCY = 6;
const ageCache = new Map<string, number | null>();

async function ageOf(dir: string): Promise<number | null> {
  if (ageCache.has(dir)) return ageCache.get(dir) ?? null;
  let age: number | null = null;
  try {
    age = ageID(await title(dir)) ?? null;
  } catch {
    age = null; // unknown: keep the title rather than hide it on a hiccup
  }
  ageCache.set(dir, age);
  return age;
}

async function withAges(items: MangaSummary[]): Promise<MangaSummary[]> {
  const out: MangaSummary[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      const age = await ageOf(items[i].remoteID);
      out[i] = age == null ? items[i] : {
        ...items[i],
        ageRating: AGE_INV[age],
        nsfw: (items[i].nsfw ?? false) || age >= 2,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(AGE_LOOKUP_CONCURRENCY, items.length) }, worker));
  return out;
}

class RemangaSource implements Source {
  async mangaList(filter: MangaFilter, cursor: string | null): Promise<MangaPage> {
    const page = cursor ? parseInt(cursor, 10) : 1;
    const params = new QueryBuilder();
    params.append("page", String(page));
    params.append("count", String(CATALOG_PAGE_SIZE));
    if (filter.query) {
      params.append("query", filter.query);
    } else {
      params.append("ordering", sortField(filter.sort));
      for (const slug of filter.type.include) {
        if (TYPE_MAP[slug] !== undefined) params.append("types", String(TYPE_MAP[slug]));
      }
      for (const slug of filter.status.include) {
        if (STATUS_MAP[slug] !== undefined) params.append("status", String(STATUS_MAP[slug]));
      }
      for (const slug of filter.rating.include) {
        if (AGE_MAP[slug] !== undefined) params.append("age_limit", String(AGE_MAP[slug]));
      }
      for (const slug of filter.labels.include) params.append("categories", slug);
    }

    // Free-text search lives on a separate endpoint without filters.
    const path = filter.query ? "/api/v2/search/" : "/api/v2/search/catalog/";
    const res = await call(`${path}?${params.toString()}`);
    const body = JSON.parse(res.body) as CatalogResponse;
    let items: MangaSummary[] = (body.results ?? []).map(toSummary);
    if (filter.rating.exclude.includes("EXPLICIT")) {
      items = (await withAges(items)).filter((i) => i.ageRating !== "EXPLICIT");
    }
    // Catalog paginates with `next`, search with `meta.total_pages`. A page
    // whose titles were all 18+ is empty after filtering but not the end.
    const hasMore = (body.results?.length ?? 0) > 0 && (body.meta?.total_pages != null
      ? body.meta.total_pages > page
      : body.next != null);
    return {
      items,
      endCursor: hasMore ? String(page + 1) : undefined,
      hasMore,
      totalCount: body.meta?.total_items,
    };
  }

  async mangaDetails(slug: string): Promise<MangaDetails> {
    const m = await title(slug);
    return {
      summary: toSummary(m),
      titleAlt: uniqueStrings([m.secondary_name, m.another_name]).join(" / ") || undefined,
      titleOriginal: m.secondary_name ?? undefined,
      // Remanga ships descriptions as editor HTML.
      description: m.description ? htmlToText(m.description) : undefined,
      author: creators(m, 1),
      artist: creators(m, 2),
      publisher: creators(m, 3),
      year: num(m.issue_year),
      genres: [...(m.genres ?? []), ...(m.categories ?? [])].map((g) => g.name).filter(nonEmpty),
      tags: [],
    };
  }

  async chapters(mangaID: string): Promise<ChapterDTO[]> {
    const dir = mangaID.startsWith("remanga:") ? mangaID.slice("remanga:".length) : mangaID;
    // A title can have several translation branches; read the biggest one.
    const branches = (await title(dir)).branches ?? [];
    const branch = branches.reduce<ApiBranch | undefined>(
      (best, b) => (best == null || (b.count_chapters ?? 0) > (best.count_chapters ?? 0) ? b : best),
      undefined,
    );
    if (branch == null) return [];

    const all: ChapterDTO[] = [];
    const maxPages = 30;
    for (let page = 1; page <= maxPages; page++) {
      const res = await call(`/api/v2/titles/chapters/?${qs({
        branch_id: branch.id,
        ordering: "-index",
        page,
        count: CHAPTER_LIST_PAGE_SIZE,
      })}`);
      const body = JSON.parse(res.body) as { next?: number | string | null; results?: ChapterMeta[] };
      for (const c of body.results ?? []) {
        if (c.chapter == null) continue;
        const number = parseFloat(c.chapter);
        if (Number.isNaN(number)) continue;
        const translator = (c.publishers ?? []).map((p) => p.name).filter(nonEmpty).join(", ");
        all.push({
          id: `remanga:${dir}:${c.id}`,
          remoteID: String(c.id),
          title: c.name?.length ? c.name : undefined,
          number,
          volume: c.tome ?? undefined,
          language: "ru",
          translator: translator || undefined,
          publishedAt: c.upload_date ?? undefined,
          isPaid: (c.is_paid ?? false) && !(c.is_bought ?? false),
        });
      }
      if (body.next == null || !body.results?.length) break;
    }
    return all;
  }

  async pages(chapterID: string): Promise<PageDTO[]> {
    // chapter id: "remanga:<dir>:<chapter_id>"
    const parts = chapterID.split(":");
    if (parts.length < 3) throw new Error("Invalid chapter id");
    const chapterRemoteID = parts[2];

    const res = await call(`/api/v2/titles/chapters/${encodeURIComponent(chapterRemoteID)}/`);
    const chapter = JSON.parse(res.body) as ChapterPayload;
    if (chapter.is_paid === true && chapter.is_bought !== true) {
      throw new Error("Paid chapter — buy access on Remanga to read.");
    }
    // Pages come grouped (one array per split image); flatten either shape.
    const flat = (chapter.pages ?? []).flat();
    if (!flat.length) {
      throw new Error("Chapter has no pages available.");
    }
    return flat.map((p, idx) => ({
      pageIndex: idx,
      remoteURL: p.link,
      width: p.width,
      height: p.height,
    }));
  }
}

// MARK: - HTTP

async function call(path: string): Promise<HostFetchResponse> {
  const res = await host.fetch(`${API}${path}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Mangaki/0.1",
      "Accept": "application/json",
      "Referer": "https://remanga.org/",
    },
  });
  if (res.status === 401) throw new Error("Unauthorized");
  if (res.status === 404) throw new Error("Not found");
  if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function title(dir: string): Promise<ApiManga> {
  const res = await call(`/api/v2/titles/${encodeURIComponent(dir)}/`);
  return JSON.parse(res.body) as ApiManga;
}

// MARK: - DTO shapes

interface NamedID { id?: number; name?: string }

interface ApiBranch { id: number; count_chapters?: number | null }

interface ApiManga {
  id?: number | string;
  dir?: string;
  main_name?: string | null;       // Russian title
  secondary_name?: string | null;  // English / romanized title
  another_name?: string | null;
  creators?: { name?: string | null; type?: number | null }[] | null;
  description?: string | null;
  cover?: { low?: string | null; mid?: string | null; high?: string | null } | null;
  status?: NamedID | null;
  type?: NamedID | null;
  age_limit?: NamedID | number | null;
  avg_rating?: number | string | null;
  issue_year?: number | string | null;
  genres?: { id: number; name?: string }[];
  categories?: { id: number; name?: string }[];
  count_chapters?: number | null;
  is_erotic?: boolean | null;
  branches?: ApiBranch[];
}

interface CatalogResponse {
  results?: ApiManga[];
  next?: string | null;
  meta?: { total_items?: number; total_pages?: number; page?: number };
}

interface ChapterMeta {
  id: number;
  tome?: number | null;
  chapter?: string | null;
  name?: string | null;
  index?: number | null;
  is_paid?: boolean | null;
  is_bought?: boolean | null;
  upload_date?: string | null;
  publishers?: { name?: string }[];
}

interface PagePayload { link: string; width?: number; height?: number }

interface ChapterPayload {
  id: number;
  branch_id?: number | null;
  pages?: (PagePayload | PagePayload[])[];
  is_paid?: boolean | null;
  is_bought?: boolean | null;
}

// MARK: - Helpers

function bestTitle(m: ApiManga): string {
  return (m.main_name?.length ? m.main_name : null)
      ?? (m.secondary_name?.length ? m.secondary_name : null)
      ?? m.dir
      ?? "";
}

// Some new titles get a "<DD.MM.YYYY>" prefix in `dir` until they go
// free. The public URL slug strips that prefix, but the API only knows the
// full `dir` — so it stays the remoteID and only the web slug is cleaned.
function cleanedDir(dir: string | undefined): string {
  if (!dir) return "";
  if (dir.startsWith("<")) {
    const i = dir.indexOf(">");
    if (i > 0) return dir.slice(i + 1);
  }
  return dir;
}

function coverURL(m: ApiManga): string | undefined {
  const raw = m.cover?.mid ?? m.cover?.high ?? m.cover?.low;
  if (!raw) return undefined;
  if (raw.startsWith("http")) return raw;
  return `${COVER_HOST}${raw}`;
}

function num(v: number | string | null | undefined): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function rating(v: ApiManga["avg_rating"]): number | undefined {
  const n = num(v);
  return n != null && n > 0 ? n : undefined;
}

function ageID(m: ApiManga): number | undefined {
  const a = m.age_limit;
  if (typeof a === "number") return a;
  return a?.id ?? undefined;
}

function toSummary(m: ApiManga): MangaSummary {
  const age = ageID(m);
  return {
    remoteID: m.dir ?? "",
    slug: cleanedDir(m.dir),
    title: bestTitle(m),
    coverURL: coverURL(m),
    rating: rating(m.avg_rating),
    chaptersCount: m.count_chapters ?? undefined,
    nsfw: (age ?? 0) >= 2 || (m.is_erotic ?? false),
    status: m.status?.id != null ? STATUS_INV[m.status.id] : undefined,
    type: m.type?.id != null ? TYPE_INV[m.type.id] : undefined,
    ageRating: age != null ? AGE_INV[age] : undefined,
    formats: [],
  };
}

function nonEmpty(s: string | null | undefined): s is string {
  return typeof s === "string" && s.length > 0;
}

/// Creator type: 1 author, 2 artist, 3 publishing platform (Naver, Kakao…).
function creators(m: ApiManga, type: number): string | undefined {
  return uniqueStrings((m.creators ?? []).filter((c) => c.type === type).map((c) => c.name)).join(", ") || undefined;
}

export default RemangaSource;

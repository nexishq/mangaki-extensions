/// <reference path="../../src/host.d.ts" />
import type {
  Source, MangaFilter, MangaPage, MangaSummary, MangaDetails,
  ChapterDTO, PageDTO, MangaStatus, MangaType, AgeRating,
} from "../../src/source";
import { QueryBuilder, qs } from "../../src/util";
import { LIB_DETAIL_FIELDS, libDetails, type LibDetailPayload } from "../../src/lib";

// Mangalib family — mangalib.me, yaoilib.me, hentailib.org share the
// same backend (api2.mangalib.me) and only differ by `site_id`.
// REST JSON API, no auth required for public titles.
const API = "https://api2.mangalib.me";
// The "main" image server from /api/constants (imageServers). It refuses
// requests without the site's Referer; img3.mixlib.me is gone (503).
const IMAGE_HOST = "https://img2.imglib.info";
const IMAGE_HEADERS = { Referer: "https://mangalib.me/" };
const SITE_ID = 1;  // 1 = mangalib, 2 = hentailib, 3 = yaoilib

function sortField(sort: string): string {
  switch (sort) {
    case "lastChapter": return "last_chapter_at";
    case "score":       return "rate_avg";
    case "createdAt":   return "id";
    default:            return "last_chapter_at";
  }
}

const TYPE_MAP: Record<string, number> = {
  MANGA: 1, OEL_MANGA: 4, MANHWA: 5, MANHUA: 6, RU_MANGA: 8, COMICS: 9,
};
const STATUS_MAP: Record<string, number> = {
  ONGOING: 1, FINISHED: 2, HIATUS: 4, CANCELLED: 5, ANNOUNCE: 6,
};
// Lib age ids: 0 none, 1 6+, 2 12+, 3 16+, 4 18+, 5 18+ (adult-only).
const AGE_MAP: Record<string, number> = {
  GENERAL: 1, SENSITIVE: 2, QUESTIONABLE: 3, EXPLICIT: 4,
};

const STATUS_INV: Record<number, MangaStatus> = {
  1: "ongoing", 2: "completed", 4: "hiatus", 5: "cancelled", 6: "announced",
};
const TYPE_INV: Record<number, MangaType> = {
  1: "manga", 4: "oel", 5: "manhwa", 6: "manhua", 8: "other", 9: "comic",
};
const AGE_INV: Record<number, AgeRating> = {
  0: "GENERAL", 1: "GENERAL", 2: "SENSITIVE", 3: "QUESTIONABLE", 4: "EXPLICIT", 5: "EXPLICIT",
};

class MangalibSource implements Source {
  async mangaList(filter: MangaFilter, cursor: string | null): Promise<MangaPage> {
    const page = cursor ? parseInt(cursor, 10) : 1;
    const params = new QueryBuilder();
    params.append("page", String(page));
    params.append("site_id[]", String(SITE_ID));
    params.append("sort_by", sortField(filter.sort));
    // rate_avg returns the rating object that we surface as a corner badge.
    params.append("fields[]", "rate_avg");
    if (filter.query) params.append("q", filter.query);
    for (const slug of filter.type.include) {
      if (TYPE_MAP[slug] !== undefined) params.append("types[]", String(TYPE_MAP[slug]));
    }
    for (const slug of filter.status.include) {
      if (STATUS_MAP[slug] !== undefined) params.append("status[]", String(STATUS_MAP[slug]));
    }
    for (const slug of filter.rating.include) {
      if (AGE_MAP[slug] !== undefined) params.append("caution[]", String(AGE_MAP[slug]));
    }
    for (const slug of filter.labels.include) params.append("genres[]", slug);

    const res = await call(`/api/manga?${params.toString()}`);
    const body = JSON.parse(res.body) as ListResponse;
    const items: MangaSummary[] = (body.data ?? []).map(toSummary);
    const hasNext = body.meta?.has_next_page ?? false;
    return {
      items,
      endCursor: hasNext ? String(page + 1) : undefined,
      hasMore: hasNext,
    };
  }

  async mangaDetails(slug: string): Promise<MangaDetails> {
    const params = new QueryBuilder();
    params.append("site_id", String(SITE_ID));
    for (const f of LIB_DETAIL_FIELDS) params.append("fields[]", f);
    const res = await call(`/api/manga/${encodeURIComponent(slug)}?${params.toString()}`);
    const m = (JSON.parse(res.body) as { data: Manga & LibDetailPayload }).data;
    return libDetails(m, toSummary(m));
  }

  async chapters(mangaID: string): Promise<ChapterDTO[]> {
    const slug = mangaID.startsWith("mangalib:") ? mangaID.slice("mangalib:".length) : mangaID;
    const res = await call(`/api/manga/${encodeURIComponent(slug)}/chapters?${qs({ site_id: SITE_ID })}`);
    const body = JSON.parse(res.body) as { data: ApiChapter[] };
    return (body.data ?? []).flatMap((c): ChapterDTO[] => {
      if (c.volume == null || c.number == null) return [];
      const num = parseFloat(c.number);
      if (Number.isNaN(num)) return [];
      const firstBranch = c.branches?.[0];
      const dateStr = firstBranch?.created_at;
      const isPaid = (firstBranch?.expired_type ?? 0) !== 0;
      return [{
        // Composite encodes everything pages() needs (slug + volume + number).
        id: `mangalib:${slug}:${c.volume}:${c.number}`,
        remoteID: String(c.id),
        title: c.name?.length ? c.name : undefined,
        number: num,
        volume: parseInt(c.volume, 10) || undefined,
        language: "ru",
        publishedAt: dateStr,
        isPaid,
      }];
    });
  }

  async pages(chapterID: string): Promise<PageDTO[]> {
    // chapter id: "mangalib:<slug>:<volume>:<number>"
    const parts = chapterID.split(":");
    if (parts.length < 4) throw new Error("Invalid chapter id");
    const slug = parts[1];
    const volume = parts[2];
    const number = parts[3];

    const res = await call(`/api/manga/${encodeURIComponent(slug)}/chapter?${qs({
      number, volume,
      branch_id: "0",   // 0 = first branch, works for single-branch chapters
      site_id: SITE_ID,
    })}`);
    const body = JSON.parse(res.body) as { data: PagesPayload };

    // Detect early-access paid chapter so the reader can show a clear
    // "free after <date>" message instead of "Failed to load chapter".
    if ((body.data.pages?.length ?? 0) === 0
        && (body.data.expired_type ?? 0) !== 0
        && body.data.expired_at) {
      const until = new Date(body.data.expired_at);
      if (until.getTime() > Date.now()) {
        const fmt = until.toLocaleString();
        throw new Error(`Early-access chapter — free after ${fmt}`);
      }
    }

    return (body.data.pages ?? []).map((p, idx) => ({
      pageIndex: idx,
      remoteURL: `${IMAGE_HOST}${p.url}`,
      width: p.width,
      height: p.height,
      headers: IMAGE_HEADERS,
    }));
  }
}

// MARK: - HTTP helper

async function call(path: string): Promise<HostFetchResponse> {
  const res = await host.fetch(`${API}${path}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Mangaki/0.1",
      "Accept": "application/json",
      "Referer": "https://mangalib.me/",
      // Without it the detail endpoint drops authors and other fields.
      "Site-Id": String(SITE_ID),
    },
  });
  if (res.status === 404) throw new Error("Not found");
  if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res;
}

// MARK: - DTO shapes

interface Manga {
  id: number;
  slug: string;
  name?: string | null;
  rus_name?: string | null;
  eng_name?: string | null;
  cover?: { default?: string | null; md?: string | null; thumbnail?: string | null };
  status?: { id: number; label?: string; name?: string } | null;
  type?: { id: number; label?: string; name?: string } | null;
  ageRestriction?: { id: number } | null;
  rating?: { average?: string | null; votes?: number | null } | null;
}

interface ListResponse {
  data: Manga[];
  meta?: { has_next_page?: boolean };
}

interface ApiChapter {
  id: number;
  volume?: string | null;
  number?: string | null;
  name?: string | null;
  branches?: { created_at?: string; expired_type?: number }[];
}

interface PagesPayload {
  pages: { url: string; width?: number; height?: number }[];
  expired_at?: string | null;
  expired_type?: number | null;
}

function bestTitle(m: Manga): string {
  return (m.rus_name?.length ? m.rus_name : null)
      ?? (m.eng_name?.length ? m.eng_name : null)
      ?? (m.name?.length ? m.name : null)
      ?? m.slug;
}

function toSummary(m: Manga): MangaSummary {
  const ratingStr = m.rating?.average;
  const ratingVal = ratingStr != null ? parseFloat(ratingStr) : NaN;
  const cover = m.cover?.md ?? m.cover?.default ?? undefined;
  return {
    remoteID: m.slug,
    slug: m.slug,
    title: bestTitle(m),
    coverURL: cover,
    rating: !Number.isNaN(ratingVal) && ratingVal > 0 ? ratingVal : undefined,
    nsfw: (m.ageRestriction?.id ?? 0) >= 4,
    status: m.status ? STATUS_INV[m.status.id] : undefined,
    type: m.type ? TYPE_INV[m.type.id] : undefined,
    ageRating: m.ageRestriction ? AGE_INV[m.ageRestriction.id] : undefined,
    formats: [],
  };
}


export default MangalibSource;

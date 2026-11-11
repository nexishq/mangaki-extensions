/// <reference path="../../src/host.d.ts" />
import type {
  Source,
  MangaFilter,
  MangaPage,
  MangaSummary,
  MangaDetails,
  ChapterDTO,
  PageDTO,
  MangaStatus,
  MangaType,
  AgeRating,
} from "../../src/source";
import { QueryBuilder } from "../../src/util";

// MangaDex REST API. Documented at https://api.mangadex.org/docs/.
// No auth required for public content.
const API = "https://api.mangadex.org";
const COVER = "https://uploads.mangadex.org";
const PAGE_SIZE = 24;

function preferredLang(): string {
  // We can't reach @AppStorage from JS, but native still attaches
  // x-app-language via fetch headers if it ever needs to. For now,
  // default to Russian fallbacks → English.
  return "en";
}

const STATUS_MAP: Record<string, MangaStatus> = {
  ongoing: "ongoing",
  completed: "completed",
  hiatus: "hiatus",
  cancelled: "cancelled",
};

const RATING_MAP: Record<string, AgeRating> = {
  safe: "GENERAL",
  suggestive: "SENSITIVE",
  erotica: "QUESTIONABLE",
  pornographic: "EXPLICIT",
};

function mdxSortField(sort: string): string {
  switch (sort) {
    case "lastChapter": return "latestUploadedChapter";
    case "score":       return "rating";
    case "createdAt":   return "createdAt";
    default:            return "latestUploadedChapter";
  }
}

function pickLocalized(map: Record<string, string> | undefined, lang: string): string | undefined {
  if (!map) return undefined;
  return map[lang] ?? map["en"] ?? Object.values(map)[0];
}

class MangaDexSource implements Source {
  async mangaList(filter: MangaFilter, cursor: string | null): Promise<MangaPage> {
    const offset = cursor ? parseInt(cursor, 10) : 0;
    const params = new QueryBuilder();
    params.append("limit", String(PAGE_SIZE));
    params.append("offset", String(offset));
    params.append("includes[]", "cover_art");
    params.append("contentRating[]", "safe");
    params.append("contentRating[]", "suggestive");
    // The app puts EXPLICIT into rating.exclude while 18+ is hidden; erotica
    // is adult-only too, so leave it out rather than drop it client-side.
    if (!filter.rating.exclude.includes("EXPLICIT")) params.append("contentRating[]", "erotica");
    params.append(`order[${mdxSortField(filter.sort)}]`, "desc");

    if (filter.query) params.append("title", filter.query);
    for (const slug of filter.status.include) params.append("status[]", slug.toLowerCase());

    const res = await host.fetch(`${API}/manga?${params.toString()}`);
    if (res.status === 429) throw new Error("Rate limited");
    if (res.status === 404) throw new Error("Not found");
    if (res.status >= 300) throw new Error(`HTTP ${res.status}`);

    const json = JSON.parse(res.body) as MDXListResponse;
    const lang = preferredLang();
    const items: MangaSummary[] = json.data.map((m) => toSummary(m, lang));

    return {
      items,
      endCursor: String(offset + json.data.length),
      hasMore: offset + json.data.length < json.total,
      totalCount: json.total,
    };
  }

  async mangaDetails(slug: string): Promise<MangaDetails> {
    const params = new QueryBuilder();
    params.append("includes[]", "cover_art");
    params.append("includes[]", "author");
    params.append("includes[]", "artist");
    const res = await host.fetch(`${API}/manga/${slug}?${params.toString()}`);
    if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const json = JSON.parse(res.body) as { data: MDXManga };
    const lang = preferredLang();
    const summary = toSummary(json.data, lang);
    return {
      summary,
      titleAlt: undefined,
      titleOriginal: pickLocalized(json.data.attributes.altTitles?.[0], "ja"),
      description: pickLocalized(json.data.attributes.description, lang),
      author: extractRelationship(json.data, "author"),
      artist: extractRelationship(json.data, "artist"),
      year: json.data.attributes.year ?? undefined,
      genres: (json.data.attributes.tags ?? [])
        .map((t) => pickLocalized(t.attributes.name, lang))
        .filter((s): s is string => Boolean(s)),
      tags: [],
    };
  }

  async chapters(mangaID: string): Promise<ChapterDTO[]> {
    // mangaID composite: "mangadex:<slug>" — strip prefix.
    const slug = mangaID.includes(":") ? mangaID.split(":").slice(1).join(":") : mangaID;
    const out: ChapterDTO[] = [];
    let offset = 0;
    while (offset < 5000) {
      const params = new QueryBuilder();
      params.append("manga", slug);
      params.append("limit", "100");
      params.append("offset", String(offset));
      params.append("order[chapter]", "desc");
      params.append("translatedLanguage[]", "en");
      params.append("translatedLanguage[]", "ru");
      params.append("contentRating[]", "safe");
      params.append("contentRating[]", "suggestive");
      params.append("contentRating[]", "erotica");
      params.append("includes[]", "scanlation_group");

      const res = await host.fetch(`${API}/chapter?${params.toString()}`);
      if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(res.body) as MDXChaptersResponse;
      for (const c of json.data) {
        const number = parseFloat(c.attributes.chapter ?? "0") || 0;
        const team = c.relationships?.find((r) => r.type === "scanlation_group");
        const teamName = (team?.attributes as { name?: string } | undefined)?.name;
        out.push({
          id: `mangadex:${slug}:${c.id}`,
          remoteID: c.id,
          title: c.attributes.title || undefined,
          number,
          volume: c.attributes.volume ? parseInt(c.attributes.volume, 10) : undefined,
          language: c.attributes.translatedLanguage,
          translator: teamName,
          publishedAt: c.attributes.publishAt,
          pageCount: c.attributes.pages,
          isPaid: false,
        });
      }
      offset += json.data.length;
      if (json.data.length < 100) break;
      if (offset >= json.total) break;
    }
    return out;
  }

  async pages(chapterID: string): Promise<PageDTO[]> {
    // chapterID composite: "mangadex:<slug>:<chapterRemoteID>"
    const parts = chapterID.split(":");
    if (parts.length < 3) throw new Error("Invalid chapter id");
    const remoteID = parts[2];
    const res = await host.fetch(`${API}/at-home/server/${remoteID}`);
    if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const json = JSON.parse(res.body) as {
      baseUrl: string;
      chapter: { hash: string; data: string[] };
    };
    return json.chapter.data.map((file, idx) => ({
      pageIndex: idx,
      remoteURL: `${json.baseUrl}/data/${json.chapter.hash}/${file}`,
    }));
  }
}

// MARK: - DTO shapes

interface MDXManga {
  id: string;
  attributes: {
    title: Record<string, string>;
    altTitles?: Record<string, string>[];
    description?: Record<string, string>;
    status?: string;
    contentRating?: string;
    year?: number | null;
    originalLanguage?: string;
    tags?: { attributes: { name: Record<string, string> } }[];
  };
  relationships?: { type: string; id: string; attributes?: unknown }[];
}

interface MDXListResponse {
  data: MDXManga[];
  total: number;
  limit: number;
  offset: number;
}

interface MDXChaptersResponse {
  data: {
    id: string;
    attributes: {
      chapter?: string;
      volume?: string;
      title?: string;
      translatedLanguage?: string;
      publishAt?: string;
      pages?: number;
    };
    relationships?: { type: string; attributes?: { name?: string } }[];
  }[];
  total: number;
}

function toSummary(m: MDXManga, lang: string): MangaSummary {
  const title = pickLocalized(m.attributes.title, lang) ?? "?";
  const coverRel = m.relationships?.find((r) => r.type === "cover_art");
  const coverFile = (coverRel?.attributes as { fileName?: string } | undefined)?.fileName;
  const coverURL = coverFile ? `${COVER}/covers/${m.id}/${coverFile}.512.jpg` : undefined;
  const originalLang = m.attributes.originalLanguage ?? "";
  let type: MangaType = "manga";
  if (originalLang === "ko") type = "manhwa";
  else if (originalLang === "zh") type = "manhua";
  return {
    remoteID: m.id,
    slug: m.id,
    title,
    coverURL,
    nsfw: m.attributes.contentRating === "erotica" || m.attributes.contentRating === "pornographic",
    status: m.attributes.status ? STATUS_MAP[m.attributes.status] : undefined,
    type,
    ageRating: m.attributes.contentRating ? RATING_MAP[m.attributes.contentRating] : undefined,
    formats: [],
  };
}

function extractRelationship(m: MDXManga, type: string): string | undefined {
  const rels = m.relationships?.filter((r) => r.type === type) ?? [];
  const names = rels
    .map((r) => (r.attributes as { name?: string } | undefined)?.name)
    .filter((n): n is string => Boolean(n));
  return names.length ? names.join(", ") : undefined;
}

export default MangaDexSource;

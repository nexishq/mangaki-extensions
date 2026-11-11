/// <reference path="../../src/host.d.ts" />
import type {
  Source, MangaFilter, MangaPage, MangaSummary, MangaDetails,
  ChapterDTO, PageDTO, MangaStatus, MangaType, AgeRating,
} from "../../src/source";
import { qs } from "../../src/util";

// Ranobelib is part of the "Lib" family — same backend (api2.mangalib.me)
// as Mangalib, just `site_id=3`. Returns Russian translations of mostly
// Korean / Chinese / Japanese light novels.
//
// Chapter content is delivered as ProseMirror (Tiptap) document JSON in
// the `content` field of `/api/manga/{slug}/chapter`. We convert that to
// HTML on the JS side so the native reader only needs to know "I have a
// string of HTML".
const API = "https://api2.mangalib.me";
const SITE_ID = 3;
const COVER_HOST = "https://cover.imglib.info";
const IMAGE_HOST = "https://img3.mixlib.me";

function sortField(sort: string): string {
  switch (sort) {
    case "lastChapter": return "last_chapter_at";
    case "score":       return "rate_avg";
    case "createdAt":   return "id";
    default:            return "last_chapter_at";
  }
}

const STATUS_INV: Record<number, MangaStatus> = {
  1: "ongoing", 2: "completed", 4: "hiatus", 5: "cancelled", 6: "announced",
};
const TYPE_INV: Record<number, MangaType> = {
  // Lib's type taxonomy for the ranobe vertical:
  //   1 = Japanese light novel, 4 = OEL, 5 = Korean novel,
  //   6 = Chinese novel, 8 = RU original, 9 = "western"
  // We collapse to MangaType buckets that mostly serve UI iconography.
  1: "manga", 4: "oel", 5: "manhwa", 6: "manhua", 8: "other", 9: "comic",
};
const AGE_INV: Record<number, AgeRating> = {
  0: "GENERAL", 1: "GENERAL", 2: "SENSITIVE", 3: "QUESTIONABLE", 4: "EXPLICIT", 5: "EXPLICIT",
};

class RanobelibSource implements Source {
  async mangaList(filter: MangaFilter, cursor: string | null): Promise<MangaPage> {
    const page = cursor ? parseInt(cursor, 10) : 1;
    const params: Record<string, string | number> = {
      page,
      sort_by: sortField(filter.sort),
      "fields[]": "rate_avg",
    };
    if (filter.query) params.q = filter.query;
    const query = qs(params);
    const res = await call(`/api/manga?${query}`);
    const body = JSON.parse(res.body) as ListResponse;
    const items = (body.data ?? []).map(toSummary);
    const hasNext = body.meta?.has_next_page ?? false;
    return {
      items,
      endCursor: hasNext ? String(page + 1) : undefined,
      hasMore: hasNext,
    };
  }

  async mangaDetails(slug: string): Promise<MangaDetails> {
    const fields = ["summary", "genres", "tags", "authors", "artists", "publisher", "rate_avg"];
    const query = fields.map((f) => `fields%5B%5D=${f}`).join("&");
    const res = await call(`/api/manga/${encodeURIComponent(slug)}?${query}`);
    const body = JSON.parse(res.body) as { data: Manga };
    const m = body.data;
    return {
      summary: toSummary(m),
      titleAlt: [m.eng_name, m.name].filter(nonEmpty).join(" / ") || undefined,
      titleOriginal: m.name ?? undefined,
      description: m.summary ?? undefined,
      author: (m.authors ?? []).map((a) => a.name).filter(nonEmpty).join(", ") || undefined,
      artist: (m.artists ?? []).map((a) => a.name).filter(nonEmpty).join(", ") || undefined,
      genres: (m.genres ?? []).map((g) => g.name).filter(nonEmpty) as string[],
      tags: [],
    };
  }

  async chapters(mangaID: string): Promise<ChapterDTO[]> {
    const slug = mangaID.startsWith("ranobelib:") ? mangaID.slice("ranobelib:".length) : mangaID;
    const res = await call(`/api/manga/${encodeURIComponent(slug)}/chapters`);
    const body = JSON.parse(res.body) as { data: ApiChapter[] };
    return (body.data ?? []).flatMap((c): ChapterDTO[] => {
      if (c.volume == null || c.number == null) return [];
      const num = parseFloat(c.number);
      if (Number.isNaN(num)) return [];
      const firstBranch = c.branches?.[0];
      if (!firstBranch) return [];
      return [{
        // Composite encodes the slug + volume + number so chapterText()
        // can resolve back to a chapter URL. branch_id appended too.
        id: `ranobelib:${slug}:${c.volume}:${c.number}:${firstBranch.branch_id ?? 0}`,
        remoteID: String(c.id),
        title: c.name?.length ? c.name : undefined,
        number: num,
        volume: parseInt(c.volume, 10) || undefined,
        language: "ru",
        publishedAt: firstBranch.created_at,
        isPaid: (firstBranch.expired_type ?? 0) !== 0,
      }];
    });
  }

  /// Most ranobelib titles are text-only, but a handful of entries on
  /// `site_id=3` ship image-based chapters (illustrated novellas, manhwa
  /// adaptations). When `chapterText` finds no `content`, the reader falls
  /// through to this method — return the pages if any so those chapters
  /// still render.
  async pages(chapterID: string): Promise<PageDTO[]> {
    const parts = chapterID.split(":");
    if (parts.length < 5) return [];
    const slug = parts[1];
    const volume = parts[2];
    const number = parts[3];
    const branchID = parts[4];

    const res = await call(`/api/manga/${encodeURIComponent(slug)}/chapter?${qs({
      number, volume, branch_id: branchID,
    })}`);
    const body = JSON.parse(res.body) as ChapterResponse;
    const pages = body.data?.pages ?? [];

    if (pages.length === 0
        && (body.data?.expired_type ?? 0) !== 0
        && body.data?.expired_at) {
      const until = new Date(body.data.expired_at);
      if (until.getTime() > Date.now()) {
        throw new Error(`Ранний доступ — откроется после ${until.toLocaleString()}`);
      }
    }

    return pages.map((p, idx) => ({
      pageIndex: idx,
      remoteURL: `${IMAGE_HOST}${p.url}`,
      width: p.width,
      height: p.height,
    }));
  }

  /// Fetch the chapter, extract the ProseMirror `content` field, render
  /// to HTML for the native WKWebView reader.
  async chapterText(chapterID: string): Promise<string | null> {
    // id: "ranobelib:<slug>:<volume>:<number>:<branch_id>"
    const parts = chapterID.split(":");
    if (parts.length < 5) return null;
    const slug = parts[1];
    const volume = parts[2];
    const number = parts[3];
    const branchID = parts[4];

    const res = await call(`/api/manga/${encodeURIComponent(slug)}/chapter?${qs({
      number, volume,
      branch_id: branchID,
    })}`);
    if (res.status >= 300) throw new Error(`HTTP ${res.status}`);

    const body = JSON.parse(res.body) as ChapterResponse;
    const content = body.data?.content;
    // The API returns chapter bodies in two formats depending on title /
    // chapter age:
    //   • newer chapters → plain HTML string (already pre-rendered server-side)
    //   • older chapters → ProseMirror (Tiptap) document JSON
    // The Swift reader feeds whatever we return straight into a WKWebView,
    // so pass HTML through as-is and convert JSON via renderProseMirror.
    if (typeof content === "string") {
      return content.length > 0 ? content : null;
    }
    if (content && typeof content === "object") {
      return renderProseMirror(content as ProseDoc);
    }
    // Paid chapter check — content is gated when the early-access window
    // hasn't expired yet.
    if ((body.data?.expired_type ?? 0) !== 0 && body.data?.expired_at) {
      const until = new Date(body.data.expired_at);
      if (until.getTime() > Date.now()) {
        throw new Error(`Early-access chapter — free after ${until.toLocaleString()}`);
      }
    }
    return null;
  }
}

// MARK: - HTTP

async function call(path: string): Promise<HostFetchResponse> {
  const res = await host.fetch(`${API}${path}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Mangaki/0.1",
      "Accept": "application/json",
      "Referer": "https://ranobelib.me/",
      // The Lib API rejects `?site_id=` (must be array) and treats
      // `?site_id[]=N` inconsistently on the detail endpoint. The
      // `Site-Id` header is the canonical way the web client picks the
      // vertical (1=mangalib, 3=ranobelib) and works on every endpoint.
      "Site-Id": String(SITE_ID),
    },
  });
  if (res.status === 404) throw new Error("Not found");
  if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res;
}

// MARK: - DTOs

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
  summary?: string | null;
  genres?: { id: number; name?: string }[];
  authors?: { id: number; name?: string }[];
  artists?: { id: number; name?: string }[];
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
  branches?: {
    branch_id?: number;
    created_at?: string;
    expired_type?: number;
  }[];
}
interface ChapterResponse {
  data: {
    id: number;
    branch_id: number;
    name?: string | null;
    // Newer chapters serve a raw HTML string; older ones serve a
    // ProseMirror document — both shapes valid, see `chapterText`.
    content?: ProseDoc | string | null;
    pages?: { url: string; width?: number; height?: number }[];
    expired_at?: string | null;
    expired_type?: number;
  };
}

// MARK: - ProseMirror renderer

interface ProseDoc {
  type: string;
  content?: ProseNode[];
}
interface ProseNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: ProseNode[];
}

function renderProseMirror(doc: ProseDoc): string {
  // Wrap content in a minimal HTML scaffold the native reader can style.
  // The actual font / theme / line-height controls live on the native
  // side — here we just emit semantic HTML.
  let body = "";
  for (const node of doc.content ?? []) body += renderNode(node);
  return body;
}

function renderNode(node: ProseNode): string {
  const childHTML = (node.content ?? []).map(renderNode).join("");
  switch (node.type) {
    case "paragraph": {
      const align = node.attrs?.textAlign as string | undefined;
      const style = align && align !== "left" ? ` style="text-align:${escapeAttr(align)}"` : "";
      return `<p${style}>${childHTML || "&nbsp;"}</p>`;
    }
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 2)));
      return `<h${level}>${childHTML}</h${level}>`;
    }
    case "blockquote":   return `<blockquote>${childHTML}</blockquote>`;
    case "horizontalRule": return `<hr>`;
    case "hardBreak":    return `<br>`;
    case "bulletList":   return `<ul>${childHTML}</ul>`;
    case "orderedList":  return `<ol>${childHTML}</ol>`;
    case "listItem":     return `<li>${childHTML}</li>`;
    case "image": {
      const src  = String(node.attrs?.src ?? "");
      const alt  = String(node.attrs?.alt ?? "");
      const cls  = "ranobe-img";
      return `<img class="${cls}" src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`;
    }
    case "text": {
      let out = escapeHTML(node.text ?? "");
      // Wrap with mark tags inside-out (italic inside strong etc.).
      for (const mark of node.marks ?? []) {
        switch (mark.type) {
          case "bold":   case "strong": out = `<strong>${out}</strong>`; break;
          case "italic": case "em":     out = `<em>${out}</em>`; break;
          case "underline": out = `<u>${out}</u>`; break;
          case "strike": case "strikethrough": out = `<s>${out}</s>`; break;
          case "code":   out = `<code>${out}</code>`; break;
          case "link": {
            const href = String(mark.attrs?.href ?? "");
            out = `<a href="${escapeAttr(href)}">${out}</a>`; break;
          }
        }
      }
      return out;
    }
    default:
      // Unknown node — render its children so we don't drop content.
      return childHTML;
  }
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s: string): string {
  return escapeHTML(s);
}

// MARK: - Mappers (shared with Mangalib)

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
function nonEmpty(s: string | null | undefined): s is string {
  return typeof s === "string" && s.length > 0;
}

export default RanobelibSource;

"use strict";
var __source = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // sources/mangalib/source.ts
  var source_exports = {};
  __export(source_exports, {
    default: () => source_default
  });

  // src/util.ts
  var QueryBuilder = class {
    constructor() {
      this.parts = [];
    }
    append(key, value) {
      this.parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      return this;
    }
    toString() {
      return this.parts.join("&");
    }
  };
  function qs(entries) {
    const parts = [];
    for (const [k, v] of Object.entries(entries)) {
      if (v == null) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.join("&");
  }
  var NAMED_ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    laquo: "\xAB",
    raquo: "\xBB",
    mdash: "\u2014",
    ndash: "\u2013",
    hellip: "\u2026",
    ldquo: "\u201C",
    rdquo: "\u201D",
    lsquo: "\u2018",
    rsquo: "\u2019",
    bdquo: "\u201E",
    middot: "\xB7"
  };
  function htmlToText(input) {
    return input.replace(/\r/g, "").replace(/<br\s*\/?>\n?/gi, "\n").replace(/<\/(p|div|li|h[1-6])>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
      if (code[0] === "#") {
        const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
    }).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function richText(value) {
    if (typeof value === "string") return htmlToText(value) || void 0;
    if (value == null || typeof value !== "object") return void 0;
    const blocks = [];
    const inline = (n) => n.type === "text" ? n.text ?? "" : n.type === "hardBreak" ? "\n" : (n.content ?? []).map(inline).join("");
    const walk = (n) => {
      if (n.type === "paragraph" || n.type === "heading") blocks.push(inline(n).trim());
      else (n.content ?? []).forEach(walk);
    };
    walk(value);
    return blocks.filter((b) => b.length > 0).join("\n\n") || void 0;
  }
  function uniqueStrings(values) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const v of values) {
      const s = v?.trim();
      if (!s || seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      out.push(s);
    }
    return out;
  }

  // src/lib.ts
  var LIB_DETAIL_FIELDS = [
    "summary",
    "genres",
    "tags",
    "authors",
    "artists",
    "publisher",
    "rate_avg",
    "releaseDate",
    "otherNames"
  ];
  var names = (list) => uniqueStrings((list ?? []).map((p) => p.rus_name || p.name)).join(", ") || void 0;
  function libDetails(m, summary) {
    const year = parseInt(m.releaseDate ?? "", 10);
    return {
      summary,
      titleAlt: uniqueStrings([m.eng_name, m.name, ...m.otherNames ?? []]).filter((t) => t !== summary.title).join(" / ") || void 0,
      titleOriginal: m.name ?? void 0,
      description: richText(m.summary),
      author: names(m.authors),
      artist: names(m.artists),
      publisher: names(m.publisher),
      year: Number.isFinite(year) && year > 1900 ? year : void 0,
      genres: uniqueStrings((m.genres ?? []).map((g) => g.name)),
      tags: uniqueStrings((m.tags ?? []).map((t) => t.name))
    };
  }

  // sources/mangalib/source.ts
  var API = "https://api2.mangalib.me";
  var IMAGE_HOST = "https://img2.imglib.info";
  var IMAGE_HEADERS = { Referer: "https://mangalib.me/" };
  var SITE_ID = 1;
  function sortField(sort) {
    switch (sort) {
      case "lastChapter":
        return "last_chapter_at";
      case "score":
        return "rate_avg";
      case "createdAt":
        return "id";
      default:
        return "last_chapter_at";
    }
  }
  var TYPE_MAP = {
    MANGA: 1,
    OEL_MANGA: 4,
    MANHWA: 5,
    MANHUA: 6,
    RU_MANGA: 8,
    COMICS: 9
  };
  var STATUS_MAP = {
    ONGOING: 1,
    FINISHED: 2,
    HIATUS: 4,
    CANCELLED: 5,
    ANNOUNCE: 6
  };
  var AGE_MAP = {
    GENERAL: 1,
    SENSITIVE: 2,
    QUESTIONABLE: 3,
    EXPLICIT: 4
  };
  var STATUS_INV = {
    1: "ongoing",
    2: "completed",
    4: "hiatus",
    5: "cancelled",
    6: "announced"
  };
  var TYPE_INV = {
    1: "manga",
    4: "oel",
    5: "manhwa",
    6: "manhua",
    8: "other",
    9: "comic"
  };
  var AGE_INV = {
    0: "GENERAL",
    1: "GENERAL",
    2: "SENSITIVE",
    3: "QUESTIONABLE",
    4: "EXPLICIT",
    5: "EXPLICIT"
  };
  var MangalibSource = class {
    async mangaList(filter, cursor) {
      const page = cursor ? parseInt(cursor, 10) : 1;
      const params = new QueryBuilder();
      params.append("page", String(page));
      params.append("site_id[]", String(SITE_ID));
      params.append("sort_by", sortField(filter.sort));
      params.append("fields[]", "rate_avg");
      if (filter.query) params.append("q", filter.query);
      for (const slug of filter.type.include) {
        if (TYPE_MAP[slug] !== void 0) params.append("types[]", String(TYPE_MAP[slug]));
      }
      for (const slug of filter.status.include) {
        if (STATUS_MAP[slug] !== void 0) params.append("status[]", String(STATUS_MAP[slug]));
      }
      for (const slug of filter.rating.include) {
        if (AGE_MAP[slug] !== void 0) params.append("caution[]", String(AGE_MAP[slug]));
      }
      for (const slug of filter.labels.include) params.append("genres[]", slug);
      const res = await call(`/api/manga?${params.toString()}`);
      const body = JSON.parse(res.body);
      const items = (body.data ?? []).map(toSummary);
      const hasNext = body.meta?.has_next_page ?? false;
      return {
        items,
        endCursor: hasNext ? String(page + 1) : void 0,
        hasMore: hasNext
      };
    }
    async mangaDetails(slug) {
      const params = new QueryBuilder();
      params.append("site_id", String(SITE_ID));
      for (const f of LIB_DETAIL_FIELDS) params.append("fields[]", f);
      const res = await call(`/api/manga/${encodeURIComponent(slug)}?${params.toString()}`);
      const m = JSON.parse(res.body).data;
      return libDetails(m, toSummary(m));
    }
    async chapters(mangaID) {
      const slug = mangaID.startsWith("mangalib:") ? mangaID.slice("mangalib:".length) : mangaID;
      const res = await call(`/api/manga/${encodeURIComponent(slug)}/chapters?${qs({ site_id: SITE_ID })}`);
      const body = JSON.parse(res.body);
      return (body.data ?? []).flatMap((c) => {
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
          title: c.name?.length ? c.name : void 0,
          number: num,
          volume: parseInt(c.volume, 10) || void 0,
          language: "ru",
          publishedAt: dateStr,
          isPaid
        }];
      });
    }
    async pages(chapterID) {
      const parts = chapterID.split(":");
      if (parts.length < 4) throw new Error("Invalid chapter id");
      const slug = parts[1];
      const volume = parts[2];
      const number = parts[3];
      const res = await call(`/api/manga/${encodeURIComponent(slug)}/chapter?${qs({
        number,
        volume,
        branch_id: "0",
        // 0 = first branch, works for single-branch chapters
        site_id: SITE_ID
      })}`);
      const body = JSON.parse(res.body);
      if ((body.data.pages?.length ?? 0) === 0 && (body.data.expired_type ?? 0) !== 0 && body.data.expired_at) {
        const until = new Date(body.data.expired_at);
        if (until.getTime() > Date.now()) {
          const fmt = until.toLocaleString();
          throw new Error(`Early-access chapter \u2014 free after ${fmt}`);
        }
      }
      return (body.data.pages ?? []).map((p, idx) => ({
        pageIndex: idx,
        remoteURL: `${IMAGE_HOST}${p.url}`,
        width: p.width,
        height: p.height,
        headers: IMAGE_HEADERS
      }));
    }
  };
  async function call(path) {
    const res = await host.fetch(`${API}${path}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Mangaki/0.1",
        "Accept": "application/json",
        "Referer": "https://mangalib.me/",
        // Without it the detail endpoint drops authors and other fields.
        "Site-Id": String(SITE_ID)
      }
    });
    if (res.status === 404) throw new Error("Not found");
    if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return res;
  }
  function bestTitle(m) {
    return (m.rus_name?.length ? m.rus_name : null) ?? (m.eng_name?.length ? m.eng_name : null) ?? (m.name?.length ? m.name : null) ?? m.slug;
  }
  function toSummary(m) {
    const ratingStr = m.rating?.average;
    const ratingVal = ratingStr != null ? parseFloat(ratingStr) : NaN;
    const cover = m.cover?.md ?? m.cover?.default ?? void 0;
    return {
      remoteID: m.slug,
      slug: m.slug,
      title: bestTitle(m),
      coverURL: cover,
      rating: !Number.isNaN(ratingVal) && ratingVal > 0 ? ratingVal : void 0,
      nsfw: (m.ageRestriction?.id ?? 0) >= 4,
      status: m.status ? STATUS_INV[m.status.id] : void 0,
      type: m.type ? TYPE_INV[m.type.id] : void 0,
      ageRating: m.ageRestriction ? AGE_INV[m.ageRestriction.id] : void 0,
      formats: []
    };
  }
  var source_default = MangalibSource;
  return __toCommonJS(source_exports);
})();
globalThis.MangakiExtension = __source.default;

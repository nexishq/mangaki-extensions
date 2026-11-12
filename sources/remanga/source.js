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

  // sources/remanga/source.ts
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

  // sources/remanga/source.ts
  var API = "https://api.remanga.org";
  var COVER_HOST = "https://remanga.org";
  var CATALOG_PAGE_SIZE = 30;
  var CHAPTER_LIST_PAGE_SIZE = 100;
  function sortField(sort) {
    switch (sort) {
      case "lastChapter":
        return "-chapter_date";
      case "score":
        return "-rating";
      case "createdAt":
        return "-id";
      default:
        return "-chapter_date";
    }
  }
  var TYPE_MAP = {
    MANGA: 1,
    MANHWA: 2,
    MANHUA: 3,
    OEL_MANGA: 4,
    COMICS: 4,
    RU_MANGA: 5
  };
  var STATUS_MAP = {
    ONGOING: 2,
    FINISHED: 1,
    ANNOUNCE: 5,
    HIATUS: 3
  };
  var AGE_MAP = {
    QUESTIONABLE: 1,
    EXPLICIT: 2
  };
  var STATUS_INV = {
    1: "completed",
    2: "ongoing",
    3: "hiatus",
    5: "announced",
    6: "licensed"
  };
  var TYPE_INV = {
    1: "manga",
    2: "manhwa",
    3: "manhua",
    4: "oel",
    5: "comic",
    6: "comic",
    7: "other",
    22: "other"
  };
  var AGE_INV = {
    0: "GENERAL",
    1: "QUESTIONABLE",
    2: "EXPLICIT"
  };
  var AGE_LOOKUP_CONCURRENCY = 6;
  var ageCache = /* @__PURE__ */ new Map();
  async function ageOf(dir) {
    if (ageCache.has(dir)) return ageCache.get(dir) ?? null;
    let age = null;
    try {
      age = ageID(await title(dir)) ?? null;
    } catch {
      age = null;
    }
    ageCache.set(dir, age);
    return age;
  }
  async function withAges(items) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        const age = await ageOf(items[i].remoteID);
        out[i] = age == null ? items[i] : {
          ...items[i],
          ageRating: AGE_INV[age],
          nsfw: (items[i].nsfw ?? false) || age >= 2
        };
      }
    }
    await Promise.all(Array.from({ length: Math.min(AGE_LOOKUP_CONCURRENCY, items.length) }, worker));
    return out;
  }
  var RemangaSource = class {
    async mangaList(filter, cursor) {
      const page = cursor ? parseInt(cursor, 10) : 1;
      const params = new QueryBuilder();
      params.append("page", String(page));
      params.append("count", String(CATALOG_PAGE_SIZE));
      if (filter.query) {
        params.append("query", filter.query);
      } else {
        params.append("ordering", sortField(filter.sort));
        for (const slug of filter.type.include) {
          if (TYPE_MAP[slug] !== void 0) params.append("types", String(TYPE_MAP[slug]));
        }
        for (const slug of filter.status.include) {
          if (STATUS_MAP[slug] !== void 0) params.append("status", String(STATUS_MAP[slug]));
        }
        for (const slug of filter.rating.include) {
          if (AGE_MAP[slug] !== void 0) params.append("age_limit", String(AGE_MAP[slug]));
        }
        for (const slug of filter.labels.include) params.append("categories", slug);
      }
      const path = filter.query ? "/api/v2/search/" : "/api/v2/search/catalog/";
      const res = await call(`${path}?${params.toString()}`);
      const body = JSON.parse(res.body);
      let items = (body.results ?? []).map(toSummary);
      const hideExplicit = filter.rating.exclude.includes("EXPLICIT");
      if (filter.query || hideExplicit) items = await withAges(items);
      if (hideExplicit) items = items.filter((i) => i.ageRating !== "EXPLICIT");
      const hasMore = (body.results?.length ?? 0) > 0 && (body.meta?.total_pages != null ? body.meta.total_pages > page : body.next != null);
      return {
        items,
        endCursor: hasMore ? String(page + 1) : void 0,
        hasMore,
        totalCount: body.meta?.total_items
      };
    }
    async mangaDetails(slug) {
      const m = await title(slug);
      return {
        summary: toSummary(m),
        titleAlt: uniqueStrings([m.secondary_name, m.another_name]).join(" / ") || void 0,
        titleOriginal: m.secondary_name ?? void 0,
        // Remanga ships descriptions as editor HTML.
        description: m.description ? htmlToText(m.description) : void 0,
        author: creators(m, 1),
        artist: creators(m, 2),
        publisher: creators(m, 3),
        year: num(m.issue_year),
        genres: [...m.genres ?? [], ...m.categories ?? []].map((g) => g.name).filter(nonEmpty),
        tags: []
      };
    }
    async chapters(mangaID) {
      const dir = mangaID.startsWith("remanga:") ? mangaID.slice("remanga:".length) : mangaID;
      const branches = (await title(dir)).branches ?? [];
      const branch = branches.reduce(
        (best, b) => best == null || (b.count_chapters ?? 0) > (best.count_chapters ?? 0) ? b : best,
        void 0
      );
      if (branch == null) return [];
      const all = [];
      const maxPages = 30;
      for (let page = 1; page <= maxPages; page++) {
        const res = await call(`/api/v2/titles/chapters/?${qs({
          branch_id: branch.id,
          ordering: "-index",
          page,
          count: CHAPTER_LIST_PAGE_SIZE
        })}`);
        const body = JSON.parse(res.body);
        for (const c of body.results ?? []) {
          if (c.chapter == null) continue;
          const number = parseFloat(c.chapter);
          if (Number.isNaN(number)) continue;
          const translator = (c.publishers ?? []).map((p) => p.name).filter(nonEmpty).join(", ");
          all.push({
            id: `remanga:${dir}:${c.id}`,
            remoteID: String(c.id),
            title: c.name?.length ? c.name : void 0,
            number,
            volume: c.tome ?? void 0,
            language: "ru",
            translator: translator || void 0,
            publishedAt: c.upload_date ?? void 0,
            isPaid: (c.is_paid ?? false) && !(c.is_bought ?? false)
          });
        }
        if (body.next == null || !body.results?.length) break;
      }
      return all;
    }
    async pages(chapterID) {
      const parts = chapterID.split(":");
      if (parts.length < 3) throw new Error("Invalid chapter id");
      const chapterRemoteID = parts[2];
      const res = await call(`/api/v2/titles/chapters/${encodeURIComponent(chapterRemoteID)}/`);
      const chapter = JSON.parse(res.body);
      if (chapter.is_paid === true && chapter.is_bought !== true) {
        throw new Error("Paid chapter \u2014 buy access on Remanga to read.");
      }
      const flat = (chapter.pages ?? []).flat();
      if (!flat.length) {
        throw new Error("Chapter has no pages available.");
      }
      return flat.map((p, idx) => ({
        pageIndex: idx,
        remoteURL: p.link,
        width: p.width,
        height: p.height
      }));
    }
  };
  async function call(path) {
    const res = await host.fetch(`${API}${path}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Mangaki/0.1",
        "Accept": "application/json",
        "Referer": "https://remanga.org/"
      }
    });
    if (res.status === 401) throw new Error("Unauthorized");
    if (res.status === 404) throw new Error("Not found");
    if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return res;
  }
  async function title(dir) {
    const res = await call(`/api/v2/titles/${encodeURIComponent(dir)}/`);
    return JSON.parse(res.body);
  }
  function bestTitle(m) {
    return (m.main_name?.length ? m.main_name : null) ?? (m.secondary_name?.length ? m.secondary_name : null) ?? m.dir ?? "";
  }
  function cleanedDir(dir) {
    if (!dir) return "";
    if (dir.startsWith("<")) {
      const i = dir.indexOf(">");
      if (i > 0) return dir.slice(i + 1);
    }
    return dir;
  }
  function coverURL(m) {
    const raw = m.cover?.mid ?? m.cover?.high ?? m.cover?.low;
    if (!raw) return void 0;
    if (raw.startsWith("http")) return raw;
    return `${COVER_HOST}${raw}`;
  }
  function num(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = parseFloat(v);
      return Number.isNaN(n) ? void 0 : n;
    }
    return void 0;
  }
  function rating(v) {
    const n = num(v);
    return n != null && n > 0 ? n : void 0;
  }
  function ageID(m) {
    const a = m.age_limit;
    if (typeof a === "number") return a;
    return a?.id ?? void 0;
  }
  function toSummary(m) {
    const age = ageID(m);
    return {
      remoteID: m.dir ?? "",
      slug: cleanedDir(m.dir),
      title: bestTitle(m),
      coverURL: coverURL(m),
      rating: rating(m.avg_rating),
      chaptersCount: m.count_chapters ?? void 0,
      nsfw: (age ?? 0) >= 2 || (m.is_erotic ?? false),
      status: m.status?.id != null ? STATUS_INV[m.status.id] : void 0,
      type: m.type?.id != null ? TYPE_INV[m.type.id] : void 0,
      ageRating: age != null ? AGE_INV[age] : void 0,
      formats: []
    };
  }
  function nonEmpty(s) {
    return typeof s === "string" && s.length > 0;
  }
  function creators(m, type) {
    return uniqueStrings((m.creators ?? []).filter((c) => c.type === type).map((c) => c.name)).join(", ") || void 0;
  }
  var source_default = RemangaSource;
  return __toCommonJS(source_exports);
})();
globalThis.MangakiExtension = __source.default;

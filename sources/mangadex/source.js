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

  // sources/mangadex/source.ts
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

  // sources/mangadex/source.ts
  var API = "https://api.mangadex.org";
  var COVER = "https://uploads.mangadex.org";
  var PAGE_SIZE = 24;
  function preferredLang() {
    return "en";
  }
  var STATUS_MAP = {
    ongoing: "ongoing",
    completed: "completed",
    hiatus: "hiatus",
    cancelled: "cancelled"
  };
  var RATING_MAP = {
    safe: "GENERAL",
    suggestive: "SENSITIVE",
    erotica: "QUESTIONABLE",
    pornographic: "EXPLICIT"
  };
  function mdxSortField(sort) {
    switch (sort) {
      case "lastChapter":
        return "latestUploadedChapter";
      case "score":
        return "rating";
      case "createdAt":
        return "createdAt";
      default:
        return "latestUploadedChapter";
    }
  }
  function pickLocalized(map, lang) {
    if (!map) return void 0;
    return map[lang] ?? map["en"] ?? Object.values(map)[0];
  }
  function originalTitle(attrs) {
    const lang = attrs.originalLanguage;
    if (!lang) return void 0;
    const all = attrs.altTitles ?? [];
    return all.find((t) => t[`${lang}-ro`])?.[`${lang}-ro`] ?? all.find((t) => t[lang])?.[lang];
  }
  async function ratings(ids) {
    const out = /* @__PURE__ */ new Map();
    if (ids.length === 0) return out;
    const params = new QueryBuilder();
    for (const id of ids) params.append("manga[]", id);
    try {
      const res = await host.fetch(`${API}/statistics/manga?${params.toString()}`);
      if (res.status >= 300) return out;
      const body = JSON.parse(res.body);
      for (const [id, stat] of Object.entries(body.statistics ?? {})) {
        const score = stat.rating?.bayesian;
        if (typeof score === "number" && score > 0) out.set(id, Math.round(score * 100) / 100);
      }
    } catch (e) {
      host.log(`mangadex: statistics failed: ${e}`);
    }
    return out;
  }
  var MangaDexSource = class {
    async mangaList(filter, cursor) {
      const offset = cursor ? parseInt(cursor, 10) : 0;
      const params = new QueryBuilder();
      params.append("limit", String(PAGE_SIZE));
      params.append("offset", String(offset));
      params.append("includes[]", "cover_art");
      params.append("contentRating[]", "safe");
      params.append("contentRating[]", "suggestive");
      if (!filter.rating.exclude.includes("EXPLICIT")) params.append("contentRating[]", "erotica");
      params.append(`order[${mdxSortField(filter.sort)}]`, "desc");
      if (filter.query) params.append("title", filter.query);
      for (const slug of filter.status.include) params.append("status[]", slug.toLowerCase());
      const res = await host.fetch(`${API}/manga?${params.toString()}`);
      if (res.status === 429) throw new Error("Rate limited");
      if (res.status === 404) throw new Error("Not found");
      if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(res.body);
      const lang = preferredLang();
      const scores = await ratings(json.data.map((m) => m.id));
      const items = json.data.map((m) => ({ ...toSummary(m, lang), rating: scores.get(m.id) }));
      return {
        items,
        endCursor: String(offset + json.data.length),
        hasMore: offset + json.data.length < json.total,
        totalCount: json.total
      };
    }
    async mangaDetails(slug) {
      const params = new QueryBuilder();
      params.append("includes[]", "cover_art");
      params.append("includes[]", "author");
      params.append("includes[]", "artist");
      const res = await host.fetch(`${API}/manga/${slug}?${params.toString()}`);
      if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(res.body);
      const lang = preferredLang();
      const summary = toSummary(json.data, lang);
      const attrs = json.data.attributes;
      return {
        summary,
        titleAlt: uniqueStrings((attrs.altTitles ?? []).flatMap((t) => Object.values(t))).filter((t) => t !== summary.title).slice(0, 12).join(" / ") || void 0,
        titleOriginal: originalTitle(attrs),
        description: pickLocalized(json.data.attributes.description, lang),
        author: extractRelationship(json.data, "author"),
        artist: extractRelationship(json.data, "artist"),
        year: json.data.attributes.year ?? void 0,
        genres: (json.data.attributes.tags ?? []).map((t) => pickLocalized(t.attributes.name, lang)).filter((s) => Boolean(s)),
        tags: []
      };
    }
    async chapters(mangaID) {
      const slug = mangaID.includes(":") ? mangaID.split(":").slice(1).join(":") : mangaID;
      const out = [];
      let offset = 0;
      while (offset < 5e3) {
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
        const json = JSON.parse(res.body);
        for (const c of json.data) {
          const number = parseFloat(c.attributes.chapter ?? "0") || 0;
          const team = c.relationships?.find((r) => r.type === "scanlation_group");
          const teamName = team?.attributes?.name;
          out.push({
            id: `mangadex:${slug}:${c.id}`,
            remoteID: c.id,
            title: c.attributes.title || void 0,
            number,
            volume: c.attributes.volume ? parseInt(c.attributes.volume, 10) : void 0,
            language: c.attributes.translatedLanguage,
            translator: teamName,
            publishedAt: c.attributes.publishAt,
            pageCount: c.attributes.pages,
            isPaid: false
          });
        }
        offset += json.data.length;
        if (json.data.length < 100) break;
        if (offset >= json.total) break;
      }
      return out;
    }
    async pages(chapterID) {
      const parts = chapterID.split(":");
      if (parts.length < 3) throw new Error("Invalid chapter id");
      const remoteID = parts[2];
      const res = await host.fetch(`${API}/at-home/server/${remoteID}`);
      if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(res.body);
      return json.chapter.data.map((file, idx) => ({
        pageIndex: idx,
        remoteURL: `${json.baseUrl}/data/${json.chapter.hash}/${file}`
      }));
    }
  };
  function toSummary(m, lang) {
    const title = pickLocalized(m.attributes.title, lang) ?? "?";
    const coverRel = m.relationships?.find((r) => r.type === "cover_art");
    const coverFile = coverRel?.attributes?.fileName;
    const coverURL = coverFile ? `${COVER}/covers/${m.id}/${coverFile}.512.jpg` : void 0;
    const originalLang = m.attributes.originalLanguage ?? "";
    let type = "manga";
    if (originalLang === "ko") type = "manhwa";
    else if (originalLang === "zh") type = "manhua";
    return {
      remoteID: m.id,
      slug: m.id,
      title,
      coverURL,
      nsfw: m.attributes.contentRating === "erotica" || m.attributes.contentRating === "pornographic",
      status: m.attributes.status ? STATUS_MAP[m.attributes.status] : void 0,
      type,
      ageRating: m.attributes.contentRating ? RATING_MAP[m.attributes.contentRating] : void 0,
      formats: [],
      // uploads.mangadex.org answers browser-like User-Agents with a redirect
      // to a placeholder; an honest client UA gets the real cover.
      coverHeaders: { "User-Agent": "Mangaki/1.0 (iOS)" }
    };
  }
  function extractRelationship(m, type) {
    const rels = m.relationships?.filter((r) => r.type === type) ?? [];
    const names = rels.map((r) => r.attributes?.name).filter((n) => Boolean(n));
    return names.length ? names.join(", ") : void 0;
  }
  var source_default = MangaDexSource;
  return __toCommonJS(source_exports);
})();
globalThis.MangakiExtension = __source.default;

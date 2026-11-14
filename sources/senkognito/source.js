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

  // sources/senkognito/source.ts
  var source_exports = {};
  __export(source_exports, {
    default: () => source_default2
  });

  // sources/senkuro/source.ts
  var PAGE_SIZE = 30;
  var NSFW_EXCLUDE = ["hentai", "yaoi", "yuri", "shoujo_ai", "shounen_ai", "lgbt"];
  var Q_SEARCH = `
  query catalogMangas(
    $first: Int!, $after: String, $search: String,
    $type: MangaTypeFilter, $status: MangaStatusFilter, $rating: MangaRatingFilter,
    $format: MangaFormatFilter, $label: MangaLabelFilter, $orderBy: MangaOrder
  ) {
    mangas(first: $first, after: $after, search: $search,
           type: $type, status: $status, rating: $rating,
           format: $format, label: $label, orderBy: $orderBy) {
      edges {
        node {
          id slug type status rating formats score
          originalName { lang content }
          titles { lang content }
          alternativeNames { lang content }
          cover { original { url } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
  var Q_DETAILS = `
  query fetchTachiyomiManga($mangaId: ID!) {
    mangaTachiyomiInfo(mangaId: $mangaId) {
      id slug
      originalName { lang content }
      titles { lang content }
      alternativeNames { lang content }
      localizations { lang description }
      type rating status formats translationStatus
      labels { id rootId slug titles { lang content } }
      cover { original { url } }
      mainStaff { roles person { name } }
    }
  }
`;
  var Q_CHAPTERS = `
  query fetchTachiyomiChapters($mangaId: ID!) {
    mangaTachiyomiChapters(mangaId: $mangaId) {
      message
      chapters { id slug branchId name teamIds number volume createdAt }
      teams { id slug name }
    }
  }
`;
  var Q_RECENT_CHAPTERS = `
  query fetchRecentChapters($branchId: ID!) {
    mangaChapters(branchId: $branchId, first: 100) {
      edges { node { id slug branchId name teamIds number volume createdAt } }
    }
  }
`;
  var Q_PAGES = `
  query fetchTachiyomiChapterPages($mangaId: ID!, $chapterId: ID!) {
    mangaTachiyomiChapterPages(mangaId: $mangaId, chapterId: $chapterId) {
      pages { url }
    }
  }
`;
  var Q_TEXT_SEARCH = `
  query searchTextual($query: String, $offset: Int) {
    mangaTachiyomiSearch(query: $query, offset: $offset) {
      mangas {
        id slug
        originalName { lang content }
        titles { lang content }
        alternativeNames { lang content }
        cover { original { url } }
      }
    }
  }
`;
  var Q_SCORE = `
  query mangaScore($slug: String!) {
    manga(slug: $slug) { id score }
  }
`;
  var Q_FILTERS = `
  query fetchTachiyomiSearchFilters {
    mangaTachiyomiSearchFilters {
      labels { id rootId slug titles { lang content } }
    }
  }
`;
  function sortField(s) {
    switch (s) {
      case "lastChapter":
        return "LAST_CHAPTER_AT";
      case "score":
        return "SCORE";
      case "createdAt":
        return "CREATED_AT";
      default:
        return "LAST_CHAPTER_AT";
    }
  }
  var SenkuroSource = class {
    constructor() {
      /// Subclasses (e.g. Senkognito) override this — same GraphQL schema,
      /// different host.
      this.endpoint = "https://api.senkuro.me/graphql";
      this.webHost = "senkuro.me";
      this.referer = "https://senkuro.me/";
      // Cached DDoS-Guard cookie value, attached to every GraphQL request
      // once obtained. The native bridge can also persist cookies in
      // HTTPCookieStorage, but explicit pass-through avoids relying on that.
      this.challengeCookies = "";
    }
    async mangaList(filter, cursor) {
      if (filter.query) {
        return this.tachiyomiTextSearch(filter.query, cursor, filter.rating.exclude.includes("EXPLICIT"));
      }
      const labelInclude = filter.labels.include.slice();
      const labelExclude = filter.labels.exclude.slice();
      for (const slug of NSFW_EXCLUDE) {
        if (!labelInclude.includes(slug) && !labelExclude.includes(slug)) {
          labelExclude.push(slug);
        }
      }
      const variables = {
        first: PAGE_SIZE,
        after: cursor,
        orderBy: { field: sortField(filter.sort), direction: "DESC" },
        label: { include: labelInclude, exclude: labelExclude }
      };
      if (filter.type.include.length || filter.type.exclude.length) {
        variables.type = { include: filter.type.include, exclude: filter.type.exclude };
      }
      if (filter.status.include.length || filter.status.exclude.length) {
        variables.status = { include: filter.status.include, exclude: filter.status.exclude };
      }
      if (filter.rating.include.length || filter.rating.exclude.length) {
        variables.rating = { include: filter.rating.include, exclude: filter.rating.exclude };
      }
      if (filter.format.include.length || filter.format.exclude.length) {
        variables.format = { include: filter.format.include, exclude: filter.format.exclude };
      }
      const data = await this.graphQL(Q_SEARCH, variables);
      const conn = data.mangas;
      const items = conn.edges.map((e) => nodeToSummary(e.node));
      return {
        items,
        endCursor: conn.pageInfo.endCursor ?? void 0,
        hasMore: conn.pageInfo.hasNextPage
      };
    }
    async mangaDetails(slug) {
      const data = await this.graphQL(Q_DETAILS, { mangaId: slug });
      return infoToDetails(data.mangaTachiyomiInfo);
    }
    async chapters(mangaID) {
      const remote = mangaID.includes(":") ? mangaID.split(":").slice(1).join(":") : mangaID;
      const data = await this.graphQL(Q_CHAPTERS, { mangaId: remote });
      const teams = new Map(
        data.mangaTachiyomiChapters.teams.map((t) => [t.id, t.name ?? ""])
      );
      const chapters = await this.withRecentChapters(data.mangaTachiyomiChapters.chapters);
      return chapters.map((c) => ({
        id: `${mangaID.split(":")[0] || "senkuro"}:${remote}:${c.id}`,
        remoteID: c.id,
        title: c.name?.length ? c.name : void 0,
        number: parseFloat(c.number) || 0,
        volume: c.volume ? parseInt(c.volume, 10) : void 0,
        language: "ru",
        translator: c.teamIds.map((id) => teams.get(id) ?? "").filter(Boolean).join(", ") || void 0,
        publishedAt: c.createdAt
      }));
    }
    /// The Tachiyomi chapter list is cached server-side and runs hours to
    /// days behind the site, so a chapter released today is missing from it.
    /// The site's own `mangaChapters` query is live but paginated (100 per
    /// page, newest first): add its first page for every branch on top of
    /// the full Tachiyomi list. The ids are the same in both.
    async withRecentChapters(base) {
      const branches = [...new Set(base.map((c) => c.branchId).filter((b) => !!b))];
      const known = new Set(base.map((c) => c.id));
      const extra = [];
      for (const branchId of branches) {
        try {
          const data = await this.graphQL(
            Q_RECENT_CHAPTERS,
            { branchId }
          );
          for (const { node } of data.mangaChapters.edges) {
            if (!known.has(node.id)) {
              known.add(node.id);
              extra.push(node);
            }
          }
        } catch {
        }
      }
      return extra.length ? [...extra, ...base] : base;
    }
    async pages(chapterID) {
      const parts = chapterID.split(":");
      if (parts.length < 3) throw new Error("Invalid chapter id");
      const mangaRemoteID = parts[1];
      const chapterRemoteID = parts.slice(2).join(":");
      const data = await this.graphQL(
        Q_PAGES,
        { mangaId: mangaRemoteID, chapterId: chapterRemoteID }
      );
      return data.mangaTachiyomiChapterPages.pages.map((p, idx) => ({
        pageIndex: idx,
        remoteURL: p.url
      }));
    }
    async filterTaxonomy() {
      const data = await this.graphQL(Q_FILTERS, {});
      const labels = data.mangaTachiyomiSearchFilters.labels.filter((l) => !NSFW_EXCLUDE.includes(l.slug)).map((l) => {
        const ru = l.titles.find((t) => t.lang === "RU")?.content;
        const name = ru ?? l.titles[0]?.content ?? l.slug;
        return { id: l.id, rootID: l.rootId, slug: l.slug, name };
      }).sort((a, b) => a.name.localeCompare(b.name));
      return { labels };
    }
    async score(slug) {
      const data = await this.graphQL(Q_SCORE, { slug });
      const s = data.manga?.score;
      return s != null && s > 0 ? s : null;
    }
    // MARK: - Tachiyomi-search fallback (free-text query)
    /// Free text goes through the Tachiyomi search — the catalog's `search`
    /// argument misses most queries. That endpoint returns titles only, so one
    /// aliased follow-up query fills in type, age rating and score for the
    /// whole page (cover badges, and the hide-18+ setting).
    async tachiyomiTextSearch(query, cursor, hideExplicit) {
      const offset = cursor ? parseInt(cursor, 10) : 0;
      const data = await this.graphQL(
        Q_TEXT_SEARCH,
        { query, offset }
      );
      const found = data.mangaTachiyomiSearch.mangas;
      const facts = await this.mangaFacts(found.map((m) => m.slug));
      let items = found.map((m) => nodeToSummary({ ...m, ...facts.get(m.slug) }));
      if (hideExplicit) items = items.filter((i) => i.ageRating !== "EXPLICIT");
      const hasMore = found.length >= PAGE_SIZE;
      return {
        items,
        endCursor: hasMore ? String(offset + found.length) : void 0,
        hasMore
      };
    }
    async mangaFacts(slugs) {
      const facts = /* @__PURE__ */ new Map();
      if (slugs.length === 0) return facts;
      const params = slugs.map((_, i) => `$s${i}: String!`).join(", ");
      const fields = slugs.map((_, i) => `m${i}: manga(slug: $s${i}) { slug type status rating formats score }`).join(" ");
      try {
        const data = await this.graphQL(
          `query mangaFacts(${params}) { ${fields} }`,
          Object.fromEntries(slugs.map((slug, i) => [`s${i}`, slug]))
        );
        for (const node of Object.values(data)) if (node?.slug) facts.set(node.slug, node);
      } catch (e) {
        host.log(`senkuro: search facts failed: ${e}`);
      }
      return facts;
    }
    // MARK: - GraphQL transport (DDoS-Guard aware)
    async graphQL(query, variables) {
      let attempt = 0;
      while (attempt < 2) {
        const headers = {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (iPhone) Mangaki/0.1",
          "Referer": this.referer
        };
        if (this.challengeCookies) headers["Cookie"] = this.challengeCookies;
        const res = await host.fetch(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables })
        });
        if (res.status === 403 && attempt === 0) {
          const { cookies } = await host.solveChallenge(this.webHost);
          this.challengeCookies = cookies;
          attempt++;
          continue;
        }
        if (res.status === 401) throw new Error("Unauthorized");
        if (res.status === 404) throw new Error("Not found");
        if (res.status === 429) throw new Error("Too many requests");
        if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
        const envelope = JSON.parse(res.body);
        if (envelope.errors?.length) {
          throw new Error(envelope.errors.map((e) => e.message).join("; "));
        }
        if (envelope.data == null) throw new Error("Empty GraphQL data");
        return envelope.data;
      }
      throw new Error("DDoS-Guard challenge failed");
    }
  };
  var STATUS_MAP = {
    FINISHED: "completed",
    ONGOING: "ongoing",
    HIATUS: "hiatus",
    ANNOUNCE: "announced",
    CANCELLED: "cancelled"
  };
  var TYPE_MAP = {
    MANGA: "manga",
    MANHWA: "manhwa",
    MANHUA: "manhua",
    COMICS: "comic",
    OEL_MANGA: "oel",
    RU_MANGA: "other"
  };
  function bestTitle(node) {
    const ru = node.titles.find((t) => t.lang === "RU")?.content;
    if (ru) return ru;
    const en = node.titles.find((t) => t.lang === "EN")?.content;
    if (en) return en;
    return node.titles[0]?.content ?? node.slug;
  }
  function nodeToSummary(node) {
    const age = node.rating;
    const labels = [];
    const isNSFW = age === "EXPLICIT";
    return {
      remoteID: node.id,
      slug: node.slug,
      title: bestTitle(node),
      coverURL: node.cover?.original?.url ?? void 0,
      rating: typeof node.score === "number" && node.score > 0 ? node.score : void 0,
      nsfw: isNSFW,
      status: node.status ? STATUS_MAP[node.status] : void 0,
      type: node.type ? TYPE_MAP[node.type] : void 0,
      ageRating: age ?? void 0,
      formats: node.formats ?? []
    };
  }
  function infoToDetails(info) {
    const summary = nodeToSummary(info);
    const descRU = info.localizations?.find((l) => l.lang === "RU")?.description;
    const alts = (info.alternativeNames ?? []).map((a) => a.content).join(" / ");
    const authors = (info.mainStaff ?? []).filter((s) => s.roles.includes("STORY")).map((s) => s.person.name);
    const artists = (info.mainStaff ?? []).filter((s) => s.roles.includes("ART")).map((s) => s.person.name);
    const genres = (info.labels ?? []).map((l) => l.titles.find((t) => t.lang === "RU")?.content).filter((s) => Boolean(s));
    return {
      summary,
      titleAlt: alts || void 0,
      titleOriginal: info.originalName?.content ?? void 0,
      description: descRU?.length ? descRU : void 0,
      author: authors.join(", ") || void 0,
      artist: artists.join(", ") || void 0,
      genres,
      tags: []
    };
  }
  var source_default = SenkuroSource;

  // sources/senkognito/source.ts
  var SenkognitoSource = class extends source_default {
    constructor() {
      super(...arguments);
      this.endpoint = "https://api.senkognito.com/graphql";
      this.webHost = "senkognito.com";
      this.referer = "https://senkognito.com/";
    }
  };
  var source_default2 = SenkognitoSource;
  return __toCommonJS(source_exports);
})();
globalThis.MangakiExtension = __source.default;

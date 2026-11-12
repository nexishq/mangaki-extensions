/// <reference path="../../src/host.d.ts" />
import type {
  Source, MangaFilter, MangaPage, MangaSummary, MangaDetails,
  ChapterDTO, PageDTO, MangaStatus, MangaType, AgeRating, FilterTaxonomy,
} from "../../src/source";

// Senkuro — Russian manga aggregator. GraphQL backend at
// api.senkuro.com/graphql. DDoS-Guard at the edge — on 403, ask the
// native side to spin up a WKWebView, harvest cookies, and retry.

const PAGE_SIZE = 30;
const NSFW_EXCLUDE = ["hentai", "yaoi", "yuri", "shoujo_ai", "shounen_ai", "lgbt"];

// MARK: - GraphQL query bodies (lifted verbatim from SenkuroQueries.swift)

const Q_SEARCH = `
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

const Q_DETAILS = `
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

const Q_CHAPTERS = `
  query fetchTachiyomiChapters($mangaId: ID!) {
    mangaTachiyomiChapters(mangaId: $mangaId) {
      message
      chapters { id slug branchId name teamIds number volume createdAt }
      teams { id slug name }
    }
  }
`;

const Q_RECENT_CHAPTERS = `
  query fetchRecentChapters($branchId: ID!) {
    mangaChapters(branchId: $branchId, first: 100) {
      edges { node { id slug branchId name teamIds number volume createdAt } }
    }
  }
`;

const Q_PAGES = `
  query fetchTachiyomiChapterPages($mangaId: ID!, $chapterId: ID!) {
    mangaTachiyomiChapterPages(mangaId: $mangaId, chapterId: $chapterId) {
      pages { url }
    }
  }
`;

const Q_TEXT_SEARCH = `
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

const Q_SCORE = `
  query mangaScore($slug: String!) {
    manga(slug: $slug) { id score }
  }
`;

const Q_FILTERS = `
  query fetchTachiyomiSearchFilters {
    mangaTachiyomiSearchFilters {
      labels { id rootId slug titles { lang content } }
    }
  }
`;

// MARK: - Sort field mapping

function sortField(s: string): string {
  switch (s) {
    case "lastChapter": return "LAST_CHAPTER_AT";
    case "score":       return "SCORE";
    case "createdAt":   return "CREATED_AT";
    default:            return "LAST_CHAPTER_AT";
  }
}

class SenkuroSource implements Source {
  /// Subclasses (e.g. Senkognito) override this — same GraphQL schema,
  /// different host.
  protected endpoint = "https://api.senkuro.com/graphql";
  protected webHost  = "senkuro.com";
  protected referer  = "https://senkuro.com/";

  // Cached DDoS-Guard cookie value, attached to every GraphQL request
  // once obtained. The native bridge can also persist cookies in
  // HTTPCookieStorage, but explicit pass-through avoids relying on that.
  private challengeCookies = "";

  async mangaList(filter: MangaFilter, cursor: string | null): Promise<MangaPage> {
    if (filter.query) {
      return this.tachiyomiTextSearch(filter.query, cursor, filter.rating.exclude.includes("EXPLICIT"));
    }
    const labelInclude = filter.labels.include.slice();
    const labelExclude = filter.labels.exclude.slice();
    // Always exclude NSFW labels (overlay on user's filter).
    for (const slug of NSFW_EXCLUDE) {
      if (!labelInclude.includes(slug) && !labelExclude.includes(slug)) {
        labelExclude.push(slug);
      }
    }
    const variables: Record<string, unknown> = {
      first: PAGE_SIZE,
      after: cursor,
      orderBy: { field: sortField(filter.sort), direction: "DESC" },
      label: { include: labelInclude, exclude: labelExclude },
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

    const data = await this.graphQL<{ mangas: GQLMangaConnection }>(Q_SEARCH, variables);
    const conn = data.mangas;
    const items = conn.edges.map((e) => nodeToSummary(e.node));
    return {
      items,
      endCursor: conn.pageInfo.endCursor ?? undefined,
      hasMore: conn.pageInfo.hasNextPage,
    };
  }

  async mangaDetails(slug: string): Promise<MangaDetails> {
    // `slug` for Senkuro IS the remote ID (composite has been decomposed).
    const data = await this.graphQL<{ mangaTachiyomiInfo: GQLInfo }>(Q_DETAILS, { mangaId: slug });
    return infoToDetails(data.mangaTachiyomiInfo);
  }

  async chapters(mangaID: string): Promise<ChapterDTO[]> {
    const remote = mangaID.includes(":") ? mangaID.split(":").slice(1).join(":") : mangaID;
    const data = await this.graphQL<{ mangaTachiyomiChapters: GQLChapters }>(Q_CHAPTERS, { mangaId: remote });
    const teams = new Map<string, string>(
      data.mangaTachiyomiChapters.teams.map((t) => [t.id, t.name ?? ""])
    );
    const chapters = await this.withRecentChapters(data.mangaTachiyomiChapters.chapters);
    return chapters.map((c) => ({
      id: `${mangaID.split(":")[0] || "senkuro"}:${remote}:${c.id}`,
      remoteID: c.id,
      title: c.name?.length ? c.name : undefined,
      number: parseFloat(c.number) || 0,
      volume: c.volume ? parseInt(c.volume, 10) : undefined,
      language: "ru",
      translator: c.teamIds.map((id) => teams.get(id) ?? "").filter(Boolean).join(", ") || undefined,
      publishedAt: c.createdAt,
    }));
  }

  /// The Tachiyomi chapter list is cached server-side and runs hours to
  /// days behind the site, so a chapter released today is missing from it.
  /// The site's own `mangaChapters` query is live but paginated (100 per
  /// page, newest first): add its first page for every branch on top of
  /// the full Tachiyomi list. The ids are the same in both.
  private async withRecentChapters(base: GQLChapters["chapters"]): Promise<GQLChapters["chapters"]> {
    const branches = [...new Set(base.map((c) => c.branchId).filter((b): b is string => !!b))];
    const known = new Set(base.map((c) => c.id));
    const extra: GQLChapters["chapters"] = [];
    for (const branchId of branches) {
      try {
        const data = await this.graphQL<{ mangaChapters: { edges: { node: GQLChapters["chapters"][number] }[] } }>(
          Q_RECENT_CHAPTERS, { branchId }
        );
        for (const { node } of data.mangaChapters.edges) {
          if (!known.has(node.id)) { known.add(node.id); extra.push(node); }
        }
      } catch {
        // The Tachiyomi list alone is still a valid (if stale) answer.
      }
    }
    return extra.length ? [...extra, ...base] : base;
  }

  async pages(chapterID: string): Promise<PageDTO[]> {
    // chapter ID: "<sourceID>:<mangaRemoteID>:<chapterRemoteID>"
    const parts = chapterID.split(":");
    if (parts.length < 3) throw new Error("Invalid chapter id");
    const mangaRemoteID = parts[1];
    const chapterRemoteID = parts.slice(2).join(":");
    const data = await this.graphQL<{ mangaTachiyomiChapterPages: { pages: { url: string }[] } }>(
      Q_PAGES, { mangaId: mangaRemoteID, chapterId: chapterRemoteID }
    );
    return data.mangaTachiyomiChapterPages.pages.map((p, idx) => ({
      pageIndex: idx,
      remoteURL: p.url,
    }));
  }

  async filterTaxonomy(): Promise<FilterTaxonomy> {
    const data = await this.graphQL<{ mangaTachiyomiSearchFilters: { labels: GQLFilterLabel[] } }>(Q_FILTERS, {});
    const labels = data.mangaTachiyomiSearchFilters.labels
      .filter((l) => !NSFW_EXCLUDE.includes(l.slug))
      .map((l) => {
        const ru = l.titles.find((t) => t.lang === "RU")?.content;
        const name = ru ?? l.titles[0]?.content ?? l.slug;
        return { id: l.id, rootID: l.rootId, slug: l.slug, name };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { labels };
  }

  async score(slug: string): Promise<number | null> {
    const data = await this.graphQL<{ manga: { id: string; score?: number | null } | null }>(Q_SCORE, { slug });
    const s = data.manga?.score;
    return s != null && s > 0 ? s : null;
  }

  // MARK: - Tachiyomi-search fallback (free-text query)

  /// Free text goes through the Tachiyomi search — the catalog's `search`
  /// argument misses most queries. That endpoint returns titles only, so one
  /// aliased follow-up query fills in type, age rating and score for the
  /// whole page (cover badges, and the hide-18+ setting).
  private async tachiyomiTextSearch(query: string, cursor: string | null, hideExplicit: boolean): Promise<MangaPage> {
    const offset = cursor ? parseInt(cursor, 10) : 0;
    const data = await this.graphQL<{ mangaTachiyomiSearch: { mangas: GQLNode[] } }>(
      Q_TEXT_SEARCH, { query, offset }
    );
    const found = data.mangaTachiyomiSearch.mangas;
    const facts = await this.mangaFacts(found.map((m) => m.slug));
    let items = found.map((m) => nodeToSummary({ ...m, ...facts.get(m.slug) }));
    if (hideExplicit) items = items.filter((i) => i.ageRating !== "EXPLICIT");
    const hasMore = found.length >= PAGE_SIZE;
    return {
      items,
      endCursor: hasMore ? String(offset + found.length) : undefined,
      hasMore,
    };
  }

  private async mangaFacts(slugs: string[]): Promise<Map<string, Partial<GQLNode>>> {
    const facts = new Map<string, Partial<GQLNode>>();
    if (slugs.length === 0) return facts;
    const params = slugs.map((_, i) => `$s${i}: String!`).join(", ");
    const fields = slugs
      .map((_, i) => `m${i}: manga(slug: $s${i}) { slug type status rating formats score }`)
      .join(" ");
    try {
      const data = await this.graphQL<Record<string, Partial<GQLNode> | null>>(
        `query mangaFacts(${params}) { ${fields} }`,
        Object.fromEntries(slugs.map((slug, i) => [`s${i}`, slug])),
      );
      for (const node of Object.values(data)) if (node?.slug) facts.set(node.slug, node);
    } catch (e) {
      // Badges are a nicety — plain results beat a failed search.
      host.log(`senkuro: search facts failed: ${e}`);
    }
    return facts;
  }

  // MARK: - GraphQL transport (DDoS-Guard aware)

  private async graphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let attempt = 0;
    while (attempt < 2) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (iPhone) Mangaki/0.1",
        "Referer": this.referer,
      };
      if (this.challengeCookies) headers["Cookie"] = this.challengeCookies;

      const res = await host.fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
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

      const envelope = JSON.parse(res.body) as { data?: T; errors?: { message: string }[] };
      if (envelope.errors?.length) {
        throw new Error(envelope.errors.map((e) => e.message).join("; "));
      }
      if (envelope.data == null) throw new Error("Empty GraphQL data");
      return envelope.data;
    }
    throw new Error("DDoS-Guard challenge failed");
  }
}

// MARK: - DTO shapes

interface GQLLocalizedString { lang: string; content: string }
interface GQLNode {
  id: string;
  slug: string;
  type?: string | null;
  status?: string | null;
  rating?: string | null;
  formats?: string[] | null;
  score?: number | null;
  originalName?: GQLLocalizedString | null;
  titles: GQLLocalizedString[];
  alternativeNames?: GQLLocalizedString[];
  cover?: { original?: { url?: string | null } | null };
}
interface GQLMangaConnection {
  edges: { node: GQLNode }[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}
interface GQLInfo extends Omit<GQLNode, "score"> {
  localizations?: { lang: string; description?: string }[];
  translationStatus?: string | null;
  labels?: { id: string; rootId: string; slug: string; titles: GQLLocalizedString[] }[];
  mainStaff?: { roles: string[]; person: { name: string } }[];
}
interface GQLChapters {
  message?: string | null;
  chapters: { id: string; slug?: string | null; branchId?: string | null;
              name?: string | null; teamIds: string[];
              number: string; volume: string; createdAt: string }[];
  teams: { id: string; slug?: string | null; name?: string | null }[];
}
interface GQLFilterLabel {
  id: string; rootId: string; slug: string;
  titles: GQLLocalizedString[];
}

// MARK: - Mappers

const STATUS_MAP: Record<string, MangaStatus> = {
  FINISHED: "completed", ONGOING: "ongoing", HIATUS: "hiatus",
  ANNOUNCE: "announced", CANCELLED: "cancelled",
};
const TYPE_MAP: Record<string, MangaType> = {
  MANGA: "manga", MANHWA: "manhwa", MANHUA: "manhua",
  COMICS: "comic", OEL_MANGA: "oel", RU_MANGA: "other",
};

function bestTitle(node: GQLNode): string {
  const ru = node.titles.find((t) => t.lang === "RU")?.content;
  if (ru) return ru;
  const en = node.titles.find((t) => t.lang === "EN")?.content;
  if (en) return en;
  return node.titles[0]?.content ?? node.slug;
}

function nodeToSummary(node: GQLNode): MangaSummary {
  const age = node.rating as AgeRating | null | undefined;
  const labels: { slug: string }[] = ([] as { slug: string }[]);
  const isNSFW = age === "EXPLICIT";
  return {
    remoteID: node.id,
    slug: node.slug,
    title: bestTitle(node),
    coverURL: node.cover?.original?.url ?? undefined,
    rating: typeof node.score === "number" && node.score > 0 ? node.score : undefined,
    nsfw: isNSFW,
    status: node.status ? STATUS_MAP[node.status] : undefined,
    type: node.type ? TYPE_MAP[node.type] : undefined,
    ageRating: (age ?? undefined) as AgeRating | undefined,
    formats: node.formats ?? [],
  };
}

function infoToDetails(info: GQLInfo): MangaDetails {
  const summary = nodeToSummary(info as GQLNode);
  const descRU = info.localizations?.find((l) => l.lang === "RU")?.description;
  const alts = (info.alternativeNames ?? []).map((a) => a.content).join(" / ");
  const authors = (info.mainStaff ?? [])
    .filter((s) => s.roles.includes("STORY"))
    .map((s) => s.person.name);
  const artists = (info.mainStaff ?? [])
    .filter((s) => s.roles.includes("ART"))
    .map((s) => s.person.name);
  const genres = (info.labels ?? [])
    .map((l) => l.titles.find((t) => t.lang === "RU")?.content)
    .filter((s): s is string => Boolean(s));
  return {
    summary,
    titleAlt: alts || undefined,
    titleOriginal: info.originalName?.content ?? undefined,
    description: descRU?.length ? descRU : undefined,
    author: authors.join(", ") || undefined,
    artist: artists.join(", ") || undefined,
    genres,
    tags: [],
  };
}

export default SenkuroSource;

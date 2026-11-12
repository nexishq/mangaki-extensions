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

  // sources/ranobelib/source.ts
  var source_exports = {};
  __export(source_exports, {
    default: () => source_default
  });

  // src/util.ts
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

  // sources/ranobelib/source.ts
  var API = "https://api2.mangalib.me";
  var SITE_ID = 3;
  var IMAGE_HOST = "https://img2.imglib.info";
  var IMAGE_HEADERS = { Referer: "https://ranobelib.me/" };
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
  var STATUS_INV = {
    1: "ongoing",
    2: "completed",
    4: "hiatus",
    5: "cancelled",
    6: "announced"
  };
  var TYPE_INV = {
    // Lib's type taxonomy for the ranobe vertical:
    //   1 = Japanese light novel, 4 = OEL, 5 = Korean novel,
    //   6 = Chinese novel, 8 = RU original, 9 = "western"
    // We collapse to MangaType buckets that mostly serve UI iconography.
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
  var RanobelibSource = class {
    async mangaList(filter, cursor) {
      const page = cursor ? parseInt(cursor, 10) : 1;
      const params = {
        page,
        sort_by: sortField(filter.sort),
        "fields[]": "rate_avg"
      };
      if (filter.query) params.q = filter.query;
      const query = qs(params);
      const res = await call(`/api/manga?${query}`);
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
      const query = LIB_DETAIL_FIELDS.map((f) => `fields%5B%5D=${f}`).join("&");
      const res = await call(`/api/manga/${encodeURIComponent(slug)}?${query}`);
      const m = JSON.parse(res.body).data;
      return libDetails(m, toSummary(m));
    }
    async chapters(mangaID) {
      const slug = mangaID.startsWith("ranobelib:") ? mangaID.slice("ranobelib:".length) : mangaID;
      const res = await call(`/api/manga/${encodeURIComponent(slug)}/chapters`);
      const body = JSON.parse(res.body);
      return (body.data ?? []).flatMap((c) => {
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
          title: c.name?.length ? c.name : void 0,
          number: num,
          volume: parseInt(c.volume, 10) || void 0,
          language: "ru",
          publishedAt: firstBranch.created_at,
          isPaid: (firstBranch.expired_type ?? 0) !== 0
        }];
      });
    }
    /// Most ranobelib titles are text-only, but a handful of entries on
    /// `site_id=3` ship image-based chapters (illustrated novellas, manhwa
    /// adaptations). When `chapterText` finds no `content`, the reader falls
    /// through to this method — return the pages if any so those chapters
    /// still render.
    async pages(chapterID) {
      const parts = chapterID.split(":");
      if (parts.length < 5) return [];
      const slug = parts[1];
      const volume = parts[2];
      const number = parts[3];
      const branchID = parts[4];
      const res = await call(`/api/manga/${encodeURIComponent(slug)}/chapter?${qs({
        number,
        volume,
        branch_id: branchID
      })}`);
      const body = JSON.parse(res.body);
      const pages = body.data?.pages ?? [];
      if (pages.length === 0 && (body.data?.expired_type ?? 0) !== 0 && body.data?.expired_at) {
        const until = new Date(body.data.expired_at);
        if (until.getTime() > Date.now()) {
          throw new Error(`\u0420\u0430\u043D\u043D\u0438\u0439 \u0434\u043E\u0441\u0442\u0443\u043F \u2014 \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u043F\u043E\u0441\u043B\u0435 ${until.toLocaleString()}`);
        }
      }
      return pages.map((p, idx) => ({
        pageIndex: idx,
        remoteURL: `${IMAGE_HOST}${p.url}`,
        width: p.width,
        height: p.height,
        headers: IMAGE_HEADERS
      }));
    }
    /// Fetch the chapter, extract the ProseMirror `content` field, render
    /// to HTML for the native WKWebView reader.
    async chapterText(chapterID) {
      const parts = chapterID.split(":");
      if (parts.length < 5) return null;
      const slug = parts[1];
      const volume = parts[2];
      const number = parts[3];
      const branchID = parts[4];
      const res = await call(`/api/manga/${encodeURIComponent(slug)}/chapter?${qs({
        number,
        volume,
        branch_id: branchID
      })}`);
      if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const body = JSON.parse(res.body);
      const content = body.data?.content;
      if (typeof content === "string") {
        return content.length > 0 ? content : null;
      }
      if (content && typeof content === "object") {
        return renderProseMirror(content);
      }
      if ((body.data?.expired_type ?? 0) !== 0 && body.data?.expired_at) {
        const until = new Date(body.data.expired_at);
        if (until.getTime() > Date.now()) {
          throw new Error(`Early-access chapter \u2014 free after ${until.toLocaleString()}`);
        }
      }
      return null;
    }
  };
  async function call(path) {
    const res = await host.fetch(`${API}${path}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Mangaki/0.1",
        "Accept": "application/json",
        "Referer": "https://ranobelib.me/",
        // The Lib API rejects `?site_id=` (must be array) and treats
        // `?site_id[]=N` inconsistently on the detail endpoint. The
        // `Site-Id` header is the canonical way the web client picks the
        // vertical (1=mangalib, 3=ranobelib) and works on every endpoint.
        "Site-Id": String(SITE_ID)
      }
    });
    if (res.status === 404) throw new Error("Not found");
    if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return res;
  }
  function renderProseMirror(doc) {
    let body = "";
    for (const node of doc.content ?? []) body += renderNode(node);
    return body;
  }
  function renderNode(node) {
    const childHTML = (node.content ?? []).map(renderNode).join("");
    switch (node.type) {
      case "paragraph": {
        const align = node.attrs?.textAlign;
        const style = align && align !== "left" ? ` style="text-align:${escapeAttr(align)}"` : "";
        return `<p${style}>${childHTML || "&nbsp;"}</p>`;
      }
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 2)));
        return `<h${level}>${childHTML}</h${level}>`;
      }
      case "blockquote":
        return `<blockquote>${childHTML}</blockquote>`;
      case "horizontalRule":
        return `<hr>`;
      case "hardBreak":
        return `<br>`;
      case "bulletList":
        return `<ul>${childHTML}</ul>`;
      case "orderedList":
        return `<ol>${childHTML}</ol>`;
      case "listItem":
        return `<li>${childHTML}</li>`;
      case "image": {
        const src = String(node.attrs?.src ?? "");
        const alt = String(node.attrs?.alt ?? "");
        const cls = "ranobe-img";
        return `<img class="${cls}" src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`;
      }
      case "text": {
        let out = escapeHTML(node.text ?? "");
        for (const mark of node.marks ?? []) {
          switch (mark.type) {
            case "bold":
            case "strong":
              out = `<strong>${out}</strong>`;
              break;
            case "italic":
            case "em":
              out = `<em>${out}</em>`;
              break;
            case "underline":
              out = `<u>${out}</u>`;
              break;
            case "strike":
            case "strikethrough":
              out = `<s>${out}</s>`;
              break;
            case "code":
              out = `<code>${out}</code>`;
              break;
            case "link": {
              const href = String(mark.attrs?.href ?? "");
              out = `<a href="${escapeAttr(href)}">${out}</a>`;
              break;
            }
          }
        }
        return out;
      }
      default:
        return childHTML;
    }
  }
  function escapeHTML(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escapeAttr(s) {
    return escapeHTML(s);
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
  var source_default = RanobelibSource;
  return __toCommonJS(source_exports);
})();
globalThis.MangakiExtension = __source.default;

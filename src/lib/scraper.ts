import { parse, type HTMLElement } from "node-html-parser";

const BASE_URL = "https://www.islamicbook.ws/";
const ARABIC_INDEX_URL = new URL("ar.html", BASE_URL).toString();
const OTHER_LANGUAGES_URL = new URL("other.html", BASE_URL).toString();

const USER_AGENT =
  "kutub2-bot/0.1 (+https://github.com/; respectful indexer, low request volume)";

const NEXT_LINK_TOKENS = ["next", "التالي", "»", "›"];

/** A browsable section of the site: either one of Arabic's topical sub-libraries
 *  (Quran, Hadith, Fiqh, ...) or one of the other-language catalogs. */
export interface LanguageSection {
  /** Short slug derived from the section's URL path, e.g. "amma", "english", "urdu". */
  code: string;
  /** The link text as shown on the site (native script, sometimes with an English gloss). */
  label: string;
  /** Absolute URL of this section's first index page. */
  url: string;
}

/** A single book listing, normalized across the site's two known page layouts. */
export interface BookListing {
  /** Section code this was scraped from, e.g. "amma" or "urdu". */
  language: string;
  author: string | null;
  title: string;
  pdfUrl: string | null;
  /**
   * Absolute URL to this book's in-site HTML reader (the "book" icon next to the
   * author, in Arabic's topical libraries). Most sections — every other language,
   * plus Arabic's own Quran section — only offer a PDF download, so this is null
   * there; use `pdfUrl` instead for those.
   */
  contentUrl: string | null;
  coverImageUrl: string | null;
}

export interface BookIndexPage {
  books: BookListing[];
  /** Absolute URL of the next page of this same listing, if the site paginates it. */
  nextPageUrl: string | null;
}

/** One page of a book's text, as read from its in-site HTML reader. */
export interface BookPage {
  url: string;
  pageNumber: number;
  /** Paragraphs of body text on this page, with <br/> line breaks preserved as \n within each paragraph. */
  paragraphs: string[];
}

/** A book's full reader contents: header info plus every page's text, in order. */
export interface BookContent {
  title: string;
  author: string;
  sourceUrl: string;
  pages: BookPage[];
  /** True if pagination continued past `maxPages` and further pages were not fetched. */
  truncated: boolean;
}

async function fetchHtml(url: string): Promise<HTMLElement> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Request to ${url} failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  return parse(html);
}

/**
 * Every selector in this file (parseReaderPage's #content/h1/p lookups, the
 * "أقسام الكتاب" pagination detection, etc.) is tuned to islamicbook.ws's specific
 * markup. Given a URL from a different site — e.g. shamela.ws, whose book pages use
 * an entirely different layout — those same selectors will often still match SOME
 * element by coincidence (shamela.ws's page also happens to have a search-modal
 * fragment matching #content/h1/p) and silently return that as if it were the book's
 * text, instead of failing loudly. This guard turns that into a clear, honest error.
 */
function assertIsIslamicBookUrl(url: string) {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (host !== "islamicbook.ws" && host !== "www.islamicbook.ws") {
    throw new Error(
      `${url} is not an islamicbook.ws page. This reader is built specifically for ` +
        `islamicbook.ws's markup and will misread pages from other sites rather than ` +
        `cleanly failing on them — it needs a dedicated reader for that source instead.`,
    );
  }
}

function resolve(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function text(el: HTMLElement | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Derives a short slug for a section from its URL's last path segment. */
function pathCode(url: string): string {
  const path = new URL(url).pathname.replace(/\/$/, "");
  const seg = path.split("/").filter(Boolean).pop() ?? url;
  return seg.replace(/\.html?$/i, "").toLowerCase();
}

/**
 * Discovers Arabic's own topical sub-libraries (Quran, Hadith, Fiqh, history, ...)
 * from the navbar on ar.html, rather than hardcoding their paths.
 */
export async function fetchArabicSections(): Promise<LanguageSection[]> {
  const root = await fetchHtml(ARABIC_INDEX_URL);
  const sections: LanguageSection[] = [];
  for (const a of root.querySelectorAll("#navbar a")) {
    const url = resolve(a.getAttribute("href"), ARABIC_INDEX_URL);
    const label = text(a);
    if (!url || !label) continue;
    sections.push({ code: pathCode(url), label, url });
  }
  return sections;
}

/**
 * Discovers every other language section the site offers, from its own language
 * switcher on other.html — so a newly added language shows up without code changes.
 */
export async function fetchLanguageSections(): Promise<LanguageSection[]> {
  const root = await fetchHtml(OTHER_LANGUAGES_URL);
  const sections: LanguageSection[] = [];
  for (const a of root.querySelectorAll("li a")) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || /other\.html$/i.test(href)) continue;
    const url = resolve(href, OTHER_LANGUAGES_URL);
    const label = text(a);
    if (!url || !label) continue;
    sections.push({ code: pathCode(url), label, url });
  }
  return sections;
}

type Layout = "reader-table" | "catalog" | "unknown";

function detectLayout(root: HTMLElement): Layout {
  if (root.querySelector("table#hor-zebra")) return "reader-table";
  if (root.querySelector("td.catalog")) return "catalog";
  return "unknown";
}

/** Parses Arabic's topical-library layout: a table with a PDF icon, a "book" reader
 *  icon, an author column, and a title column. */
function parseReaderTable(root: HTMLElement, baseUrl: string, language: string): BookListing[] {
  const listings: BookListing[] = [];
  for (const row of root.querySelectorAll("table#hor-zebra tbody tr")) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 4) continue;

    const [pdfCell, contentCell, authorCell, titleCell] = cells;
    const author = text(authorCell);
    const title = text(titleCell);
    if (!author && !title) continue;

    const pdfUrl = resolve(pdfCell?.querySelector("a")?.getAttribute("href"), baseUrl);
    const contentUrl = resolve(contentCell?.querySelector("a")?.getAttribute("href"), baseUrl);
    // Some tables embed a bare subsection-header row (no icons, just a heading in the
    // title cell) — a real listing always has at least one of the two link icons.
    if (!pdfUrl && !contentUrl) continue;

    listings.push({
      language,
      author: author || null,
      title,
      pdfUrl,
      contentUrl,
      coverImageUrl: null,
    });
  }
  return listings;
}

/** Parses the card-catalog layout used by every other language (and Arabic's Quran
 *  section): a cover image, a title, and a PDF download link — no author field and
 *  no in-site reader. */
function parseCatalog(root: HTMLElement, baseUrl: string, language: string): BookListing[] {
  const listings: BookListing[] = [];
  for (const cell of root.querySelectorAll("td.catalog")) {
    const coverSrc = cell.querySelector("img")?.getAttribute("src");
    const pdfLink = cell
      .querySelectorAll("a")
      .find((a) => /\.pdf(?:$|[?#])/i.test(a.getAttribute("href") ?? ""));

    const title = cell
      .querySelectorAll("p")
      .filter((p) => !p.querySelector('a[href$=".pdf"]'))
      .map((p) => text(p))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const pdfUrl = resolve(pdfLink?.getAttribute("href"), baseUrl);
    if (!title && !pdfUrl) continue;

    listings.push({
      language,
      author: null,
      title: title || "(untitled)",
      pdfUrl,
      contentUrl: null,
      coverImageUrl: resolve(coverSrc, baseUrl),
    });
  }
  return listings;
}

function findNextPageUrl(root: HTMLElement, baseUrl: string): string | null {
  for (const a of root.querySelectorAll("a")) {
    const label = text(a).toLowerCase();
    if (NEXT_LINK_TOKENS.some((token) => label.includes(token))) {
      const url = resolve(a.getAttribute("href"), baseUrl);
      if (url) return url;
    }
  }
  return null;
}

/**
 * Fetches one index/catalog page and parses it into a normalized book list,
 * auto-detecting which of the site's two layouts it uses. Works for ar.html, any
 * of Arabic's topical sub-libraries, or any other language's catalog page.
 */
export async function fetchBookIndex(url: string, language?: string): Promise<BookIndexPage> {
  const root = await fetchHtml(url);
  const layout = detectLayout(root);
  const lang = language ?? pathCode(url);

  const books =
    layout === "reader-table"
      ? parseReaderTable(root, url, lang)
      : layout === "catalog"
        ? parseCatalog(root, url, lang)
        : [];

  const nextPageUrl = layout === "catalog" ? findNextPageUrl(root, url) : null;
  return { books, nextPageUrl };
}

/**
 * Fetches every page of a (possibly multi-page) catalog listing, following "Next"
 * links up to `maxPages`. Arabic's topical libraries are single-page and return
 * immediately; other languages' catalogs are paginated ~9 books per page.
 */
export async function fetchAllBookListings(
  startUrl: string,
  options: { language?: string; maxPages?: number; delayMs?: number } = {},
): Promise<{ books: BookListing[]; pagesFetched: number; truncated: boolean }> {
  const maxPages = options.maxPages ?? 15;
  const delayMs = options.delayMs ?? 200;

  const books: BookListing[] = [];
  let url: string | null = startUrl;
  let pagesFetched = 0;
  let truncated = false;

  while (url) {
    if (pagesFetched >= maxPages) {
      truncated = true;
      break;
    }
    if (pagesFetched > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    const page: BookIndexPage = await fetchBookIndex(url, options.language);
    books.push(...page.books);
    pagesFetched++;
    url = page.nextPageUrl;
  }

  return { books, pagesFetched, truncated };
}

/** Collapses horizontal whitespace on a single line without touching newlines. */
function collapseInline(s: string): string {
  return s.replace(/[ \t\r\f\v]+/g, " ").trim();
}

/**
 * Converts a fragment of #content's inner HTML into paragraph strings. The site uses
 * two different body formats depending on the book: prose wrapped in <p> tags, and
 * poetry/verse written as bare text nodes separated only by <br/> with no wrapper at
 * all. This normalizes both into the same paragraph[] shape by turning block-tag
 * boundaries and line breaks into newlines before stripping the remaining markup.
 */
function htmlFragmentToParagraphs(html: string): string[] {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6])>/gi, "\n\n")
    .replace(/<(?:p|div|h[1-6])(?:\s[^>]*)?>/gi, "\n\n");

  const plain = parse(withBreaks).textContent ?? "";

  return plain
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => collapseInline(line))
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean);
}

/** Parses a single reader page (e.g. amma/some-book-002.html) into title, author, and body text. */
function parseReaderPage(root: HTMLElement, pageUrl: string, pageNumber: number) {
  const heading = root.querySelector("#content h1") ?? root.querySelector("h1");
  const headingHtml = heading?.innerHTML ?? "";
  const headingLines = headingHtml
    .split(/<br\s*\/?>/i)
    .map((line) => text(parse(line)))
    .filter(Boolean);

  const title = (headingLines[0] ?? "").replace(/^كتاب\s*:\s*/, "").trim();
  const author = (headingLines[1] ?? "").replace(/^المؤلف\s*:\s*/, "").trim();

  // Strip the heading (already parsed above) and the "أقسام الكتاب" pagination
  // footer (page-number links) before turning what's left into paragraphs.
  let bodyHtml = (root.querySelector("#content")?.innerHTML ?? "").replace(
    /<h1[\s\S]*?<\/h1>/i,
    "",
  );
  const paginationMarkerIndex = bodyHtml.indexOf("أقسام الكتاب");
  if (paginationMarkerIndex !== -1) bodyHtml = bodyHtml.slice(0, paginationMarkerIndex);

  const paragraphs = htmlFragmentToParagraphs(bodyHtml);

  // Pagination links under "أقسام الكتاب" are plain <a> tags whose text is a page number.
  const pageLinks = root
    .querySelectorAll("#content a")
    .map((a) => ({ href: a.getAttribute("href"), label: text(a) }))
    .filter((a) => a.href && /^\d+$/.test(a.label))
    .map((a) => ({ url: resolve(a.href, pageUrl)!, pageNumber: Number(a.label) }))
    .filter((a) => a.url);

  return { title, author, page: { url: pageUrl, pageNumber, paragraphs } as BookPage, pageLinks };
}

const NOT_A_READER_PAGE =
  " doesn't look like an in-site book reader page. This feature only works for " +
  "books that have a contentUrl (Arabic's topical libraries) — other listings only have a pdfUrl.";

/** Reader pages have neither the index-table nor the card-catalog markup — if either
 *  is present, `url` is a listing page, not a single book's reader. */
function assertIsReaderPage(root: HTMLElement, url: string) {
  if (detectLayout(root) !== "unknown") {
    throw new Error(url + NOT_A_READER_PAGE);
  }
}

/** Fetches a single reader page without following pagination. Throws if `pageUrl`
 *  isn't an in-site reader page (i.e. this book only has a PDF, no `contentUrl`). */
export async function fetchBookPage(pageUrl: string): Promise<{
  title: string;
  author: string;
  page: BookPage;
  otherPages: { url: string; pageNumber: number }[];
}> {
  assertIsIslamicBookUrl(pageUrl);
  const root = await fetchHtml(pageUrl);
  assertIsReaderPage(root, pageUrl);

  const { title, author, page, pageLinks } = parseReaderPage(root, pageUrl, 1);
  if (!title && page.paragraphs.length === 0) {
    throw new Error(pageUrl + NOT_A_READER_PAGE);
  }
  return { title, author, page, otherPages: pageLinks };
}

/**
 * Fetches a book's full contents by starting at `startUrl` (the book icon link from the
 * index) and following its "أقسام الكتاب" pagination through every page, in order.
 *
 * Requests are made sequentially with a short delay between them to stay light on the
 * source server. `maxPages` caps how many pages are fetched for a single book.
 */
export async function fetchBookContent(
  startUrl: string,
  options: { maxPages?: number; delayMs?: number } = {},
): Promise<BookContent> {
  const maxPages = options.maxPages ?? 100;
  const delayMs = options.delayMs ?? 200;

  assertIsIslamicBookUrl(startUrl);
  const first = await fetchHtml(startUrl);
  assertIsReaderPage(first, startUrl);

  const parsed = parseReaderPage(first, startUrl, 1);
  if (!parsed.title && parsed.page.paragraphs.length === 0) {
    throw new Error(startUrl + NOT_A_READER_PAGE);
  }

  const pages: BookPage[] = [parsed.page];
  const seen = new Set<string>([startUrl]);

  // Page 1's own link list already enumerates every page in the book (including itself).
  const allPageLinks = parsed.pageLinks
    .filter((link) => !seen.has(link.url))
    .sort((a, b) => a.pageNumber - b.pageNumber);

  let truncated = false;
  for (const link of allPageLinks) {
    if (pages.length >= maxPages) {
      truncated = true;
      break;
    }
    if (seen.has(link.url)) continue;
    seen.add(link.url);

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    const root = await fetchHtml(link.url);
    const { page } = parseReaderPage(root, link.url, link.pageNumber);
    pages.push(page);
  }

  pages.sort((a, b) => a.pageNumber - b.pageNumber);

  return {
    title: parsed.title,
    author: parsed.author,
    sourceUrl: startUrl,
    pages,
    truncated,
  };
}

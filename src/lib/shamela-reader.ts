import { parse, type HTMLElement } from "node-html-parser";

const USER_AGENT =
  "kutub2-bot/0.1 (+https://github.com/; respectful indexer, low request volume)";

export interface ShamelaPage {
  url: string;
  pageNumber: number;
  /** The book's final page number, read off the page's own "jump to last page" link. */
  lastPageNumber: number;
  paragraphs: string[];
  /**
   * The nearest enclosing named heading from the book's own table of contents (a
   * كتاب/باب/مسألة entry, e.g. "٧٤٩ - مسألة؛ قال: (ومن باع سلعة بنسيئة...)") — null if
   * none could be found. This matters: a page's text alone can read as a general
   * statement when it's actually a narrow remark inside one specific case, and an
   * LLM asked about it can't tell the difference without this. Bare "فصل" markers
   * (used for a sub-section with no name of its own) are skipped in favor of the
   * nearest heading that actually says what's being discussed.
   */
  sectionHeading: string | null;
}

async function fetchHtml(url: string): Promise<HTMLElement> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Request to ${url} failed: ${res.status} ${res.statusText}`);
  }
  return parse(await res.text());
}

function text(el: HTMLElement | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function assertIsShamelaUrl(url: string) {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (host !== "shamela.ws" && host !== "www.shamela.ws") {
    throw new Error(`${url} is not a shamela.ws page.`);
  }
}

/** Pulls the numeric book id out of a shamela.ws book URL, e.g.
 *  "https://shamela.ws/book/12876" or ".../book/12876/2" -> "12876". */
function extractBookId(bookUrl: string): string {
  const match = new URL(bookUrl).pathname.match(/\/book\/(\d+)/);
  if (!match) throw new Error(`Not a shamela.ws book URL: ${bookUrl}`);
  return match[1]!;
}

/**
 * Every page's own HTML includes the full "فصول الكتاب" (book chapters) sidebar
 * tree, in page order — this walks it to find the nearest named heading at or
 * before `pageNumber`. A bare "فصل" entry (an unnamed sub-section marker) is
 * skipped in favor of the closest one before it that actually names what's being
 * discussed, since the immediate leaf under a target page is very often just "فصل".
 */
function findSectionHeading(root: HTMLElement, bookId: string, pageNumber: number): string | null {
  const nav = root.querySelector(".s-nav");
  if (!nav) return null;

  const pageNumberPattern = new RegExp(`^https?://(?:www\\.)?shamela\\.ws/book/${bookId}/(\\d+)$`);
  let heading: string | null = null;

  for (const a of nav.querySelectorAll("a")) {
    const match = a.getAttribute("href")?.match(pageNumberPattern);
    if (!match) continue;
    const entryPage = Number(match[1]);
    if (entryPage > pageNumber) break;

    const title = text(a);
    if (title && title !== "فصل") heading = title;
  }

  return heading;
}

/**
 * Fetches one page of a shamela.ws book's reader. Page numbers are a simple
 * sequential counter starting at 1 (not the printed book's own page numbers) — the
 * book's URL from the database (e.g. https://shamela.ws/book/12876, which by itself
 * only shows a bibliographic card and table of contents, not text) plus a page
 * number builds the actual reader URL, .../book/12876/{pageNumber}.
 */
export async function fetchShamelaPage(bookUrl: string, pageNumber = 1): Promise<ShamelaPage> {
  assertIsShamelaUrl(bookUrl);
  const bookId = extractBookId(bookUrl);
  const pageUrl = `https://shamela.ws/book/${bookId}/${pageNumber}`;

  const root = await fetchHtml(pageUrl);
  const nass = root.querySelector(".nass");
  if (!nass) {
    throw new Error(
      `${pageUrl} doesn't look like a shamela.ws reader page (no page content found) — ` +
        `the book may not have this many pages, or its layout may differ from what's expected here.`,
    );
  }

  const paragraphs = nass
    .querySelectorAll("p")
    .map((p) => text(p))
    .filter(Boolean);

  // Every page carries "jump to first/prev/next/last page" links pointing at
  // /book/{id}/{N}; the largest N among them — including any page links in the
  // sidebar table of contents, which can only point *within* the book — is always
  // the book's actual last page (its own "jump to last page" link targets it
  // directly, so this holds even on page 1, where prev/first are disabled buttons).
  const pageNumberPattern = new RegExp(`/book/${bookId}/(\\d+)`);
  const linkedPageNumbers = root
    .querySelectorAll("a")
    .map((a) => a.getAttribute("href")?.match(pageNumberPattern)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number);
  const lastPageNumber = linkedPageNumbers.length > 0 ? Math.max(...linkedPageNumbers) : pageNumber;
  const sectionHeading = findSectionHeading(root, bookId, pageNumber);

  return { url: pageUrl, pageNumber, lastPageNumber, paragraphs, sectionHeading };
}

export interface ShamelaSearchHit {
  pageNumber: number;
  url: string;
  /** A short snippet shamela.ws itself returns around the match — for display only;
   *  fetch the page with fetchShamelaPage for the full paragraph text. */
  snippet: string;
}

/**
 * Searches for `term` within one book, using shamela.ws's own in-book search (the
 * "بحث في هذا الكتاب" box on a book's page — found by reading assets/js/custom.js's
 * click handler, which posts to this endpoint). This is what makes it possible to
 * ground an answer in the *relevant* part of a book — some run to several thousand
 * pages — rather than only ever reading from page 1 onward.
 */
export async function searchWithinBook(
  bookUrl: string,
  term: string,
  limit = 5,
): Promise<ShamelaSearchHit[]> {
  assertIsShamelaUrl(bookUrl);
  const bookId = extractBookId(bookUrl);

  const res = await fetch("https://shamela.ws/ajax/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ term, "books[]": bookId }),
  });
  if (!res.ok) {
    throw new Error(`Search request failed: ${res.status} ${res.statusText}`);
  }
  const root = parse(await res.text());

  // Each hit renders as a title <a> (linking to its page) immediately followed by a
  // <p class="srch-snippet"> — the two lists line up 1:1 in document order.
  const pageNumberPattern = new RegExp(`/book/${bookId}/(\\d+)`);
  const linkEls = root
    .querySelectorAll("a")
    .filter((a) => pageNumberPattern.test(a.getAttribute("href") ?? ""));
  const snippetEls = root.querySelectorAll("p.srch-snippet");

  const hits: ShamelaSearchHit[] = [];
  const seenPages = new Set<number>();

  for (let i = 0; i < linkEls.length && hits.length < limit; i++) {
    const href = linkEls[i]!.getAttribute("href") ?? "";
    const pageNumber = Number(href.match(pageNumberPattern)?.[1]);
    if (!pageNumber || seenPages.has(pageNumber)) continue;
    seenPages.add(pageNumber);

    hits.push({
      pageNumber,
      url: `https://shamela.ws/book/${bookId}/${pageNumber}`,
      snippet: text(snippetEls[i]).replace(/عرض المزيد\s*$/, "").trim(),
    });
  }

  return hits;
}

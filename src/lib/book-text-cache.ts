import { fetchShamelaPage } from "./shamela-reader.ts";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PAGES = Number(process.env.BOOK_FETCH_MAX_PAGES ?? 60);
const PAGE_DELAY_MS = 150;

export interface CachedParagraph {
  page: number;
  /** 1-indexed position of this paragraph within its page — shamela.ws's reader
   *  has no print-line numbers, so this is the finest-grained citeable unit the
   *  scraped data actually supports. */
  paragraph: number;
  text: string;
  sectionHeading: string | null;
}

interface CacheEntry {
  paragraphs: CachedParagraph[];
  /** True if the book had more content than `targetChars` — the reader's pagination
   *  continued (or MAX_PAGES was hit) before all of it was fetched. */
  truncated: boolean;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Fetches (and caches) a book's paragraphs from its shamela.ws reader, one page at
 * a time starting from page 1, stopping as soon as `targetChars` characters have
 * been collected. shamela.ws pages are small (a paragraph or a few per page — some
 * books run into the thousands of pages), so this avoids pulling — and paying LLM
 * tokens for — far more of a book than will actually fit in the prompt. Each
 * paragraph keeps its page and in-page position so an answer can cite back to it.
 */
export async function getBookParagraphs(uri: string, targetChars: number): Promise<{ paragraphs: CachedParagraph[]; truncated: boolean }> {
  const cacheKey = `${uri}::${targetChars}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit;

  const paragraphs: CachedParagraph[] = [];
  let length = 0;
  let truncated = false;
  let pageNumber = 1;
  let pagesFetched = 0;
  let lastPageNumber = Infinity;

  while (pageNumber <= lastPageNumber) {
    if (length >= targetChars) {
      truncated = true;
      break;
    }
    if (pagesFetched >= MAX_PAGES) {
      truncated = true;
      break;
    }
    if (pagesFetched > 0) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));

    const page = await fetchShamelaPage(uri, pageNumber);
    lastPageNumber = page.lastPageNumber;

    for (const [i, text] of page.paragraphs.entries()) {
      if (length >= targetChars) {
        truncated = true;
        break;
      }
      paragraphs.push({ page: pageNumber, paragraph: i + 1, text, sectionHeading: page.sectionHeading });
      length += text.length;
    }
    pagesFetched++;
    pageNumber++;
  }
  if (pageNumber <= lastPageNumber) truncated = true;

  const entry: CacheEntry = { paragraphs, truncated, expires: Date.now() + CACHE_TTL_MS };
  cache.set(cacheKey, entry);
  return entry;
}

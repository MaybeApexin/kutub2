import { fetchShamelaPage } from "./shamela-reader.ts";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PAGES = Number(process.env.BOOK_FETCH_MAX_PAGES ?? 60);
const PAGE_DELAY_MS = 150;

interface CacheEntry {
  text: string;
  /** True if the book had more content than `targetChars` — the reader's pagination
   *  continued (or MAX_PAGES was hit) before all of it was fetched. */
  truncated: boolean;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Fetches (and caches) a book's text from its shamela.ws reader, one page at a
 * time starting from page 1, stopping as soon as `targetChars` characters have been
 * collected. shamela.ws pages are small (a paragraph or a few per page — some books
 * run into the thousands of pages), so this avoids pulling — and paying LLM tokens
 * for — far more of a book than will actually fit in the prompt.
 */
export async function getBookText(uri: string, targetChars: number): Promise<CacheEntry> {
  const cacheKey = `${uri}::${targetChars}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit;

  const chunks: string[] = [];
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

    const chunk = page.paragraphs.join("\n");
    if (chunk) {
      chunks.push(chunk);
      length += chunk.length;
    }
    pagesFetched++;
    pageNumber++;
  }
  if (pageNumber <= lastPageNumber) truncated = true;

  const fullText = chunks.join("\n\n");
  const text = fullText.length > targetChars ? fullText.slice(0, targetChars) : fullText;
  if (fullText.length > targetChars) truncated = true;

  const entry: CacheEntry = { text, truncated, expires: Date.now() + CACHE_TTL_MS };
  cache.set(cacheKey, entry);
  return entry;
}

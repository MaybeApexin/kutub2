import {
  getAuthorsForBook,
  getAuthorsForBooks,
  getBookById,
  searchBooks,
  type AuthorRef,
  type BookRow,
} from "../lib/db.ts";
import { fetchShamelaPage, type ShamelaPage } from "../lib/shamela-reader.ts";
import { cached, json, error, type CacheStore } from "./http-utils.ts";

const PAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes, matching the existing Book API's convention
const MAX_RANGE_PAGES = 20;
// shamela.ws pages run small — measured directly against real books earlier in
// this project, typically a few hundred characters each (a couple of paragraphs),
// so 20 pages per response lands around 5-12 KB of text: a reasonable single
// mobile-app response, not so large it risks a slow/huge reply.
const PAGE_FETCH_DELAY_MS = 150; // same delay already used between sequential un-cached
// shamela.ws requests elsewhere in this project (fetch.ts, book-retrieval.ts) —
// reused here so this endpoint doesn't hit the site any harder than the bot does.

const pageCache: CacheStore = new Map();

function toApiBook(row: BookRow, authors: AuthorRef[]) {
  return {
    id: row.id,
    title: row.book_name,
    authors,
    type: row.book_type,
    uri: row.uri,
  };
}

function toApiPage(page: ShamelaPage) {
  return {
    pageNumber: page.pageNumber,
    text: page.paragraphs.join("\n\n"),
    heading: page.sectionHeading,
    totalPages: page.lastPageNumber,
  };
}

/** Fetches one page, cached by (book uri, page number). `lastPageNumber` (exposed
 *  to callers as `totalPages`) comes back with *every* page fetch already — it's
 *  parsed from that same page's own navigation links, not a separate request — so
 *  caching the page also caches that for free; there's no extra "how many pages
 *  does this book have" lookup to separately rate-limit. */
function getCachedPage(bookUri: string, pageNumber: number): Promise<ShamelaPage> {
  return cached(pageCache, PAGE_CACHE_TTL_MS, `${bookUri}#${pageNumber}`, () =>
    fetchShamelaPage(bookUri, pageNumber),
  );
}

function isPageCached(bookUri: string, pageNumber: number): boolean {
  const hit = pageCache.get(`${bookUri}#${pageNumber}`);
  return Boolean(hit && hit.expires > Date.now());
}

/**
 * Handles any /api/shamela/* request, reusing the same internal modules the
 * Discord commands use (src/lib/db.ts for the shamela.sqlite data, src/lib/
 * shamela-reader.ts for live page text) rather than re-implementing either.
 * Returns null when `pathname` doesn't match one of these routes, so the caller
 * (server.ts) can fall through to its own routing/404 handling.
 */
export async function handleShamelaRequest(
  pathname: string,
  searchParams: URLSearchParams,
  method: string,
): Promise<Response | null> {
  if (pathname === "/api/shamela/books" && method === "GET") {
    const q = searchParams.get("q")?.trim() ?? "";
    const authorKey = searchParams.get("author") ?? undefined;
    const bookType = searchParams.get("type") ?? undefined;

    const limitRaw = Number(searchParams.get("limit") ?? 25);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 25;
    const offsetRaw = Number(searchParams.get("offset") ?? 0);
    const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;

    const rows = searchBooks(q, { authorKey, bookType }, limit, offset);
    const authorsByBook = getAuthorsForBooks(rows.map((r) => r.id));
    return json(rows.map((row) => toApiBook(row, authorsByBook.get(row.id) ?? [])));
  }

  const bookMatch = pathname.match(/^\/api\/shamela\/books\/(\d+)$/);
  if (bookMatch && method === "GET") {
    const id = Number(bookMatch[1]);
    const row = getBookById(id);
    if (!row) return error(404, `No book with id ${id}.`);
    return json(toApiBook(row, getAuthorsForBook(id)));
  }

  const pageMatch = pathname.match(/^\/api\/shamela\/books\/(\d+)\/pages\/(\d+)$/);
  if (pageMatch && method === "GET") {
    const id = Number(pageMatch[1]);
    const pageNumber = Number(pageMatch[2]);
    if (pageNumber < 1) return error(400, "pageNumber must be a positive integer.");

    const row = getBookById(id);
    if (!row) return error(404, `No book with id ${id}.`);

    try {
      const page = await getCachedPage(row.uri, pageNumber);
      return json(toApiPage(page));
    } catch (err) {
      return error(
        404,
        `Page ${pageNumber} not found — ${err instanceof Error ? err.message : "it may be past this book's last page."}`,
      );
    }
  }

  const rangeMatch = pathname.match(/^\/api\/shamela\/books\/(\d+)\/pages$/);
  if (rangeMatch && method === "GET") {
    const id = Number(rangeMatch[1]);
    const row = getBookById(id);
    if (!row) return error(404, `No book with id ${id}.`);

    const startRaw = Number(searchParams.get("start") ?? 1);
    if (!Number.isInteger(startRaw) || startRaw < 1) {
      return error(400, "start must be a positive integer.");
    }
    const start = startRaw;

    const endParam = searchParams.get("end");
    const end = endParam ? Number(endParam) : start + MAX_RANGE_PAGES - 1;
    if (!Number.isInteger(end) || end < start) {
      return error(400, "end must be an integer >= start.");
    }
    if (end - start + 1 > MAX_RANGE_PAGES) {
      return error(
        400,
        `Requested range spans ${end - start + 1} pages; the max is ${MAX_RANGE_PAGES} pages per request.`,
      );
    }

    const pages: ReturnType<typeof toApiPage>[] = [];
    let madeLiveRequest = false;

    for (let n = start; n <= end; n++) {
      const wasCached = isPageCached(row.uri, n);
      if (!wasCached && madeLiveRequest) {
        await new Promise((r) => setTimeout(r, PAGE_FETCH_DELAY_MS));
      }

      let page: ShamelaPage;
      try {
        page = await getCachedPage(row.uri, n);
      } catch {
        break; // reached the end of the book (or a transient fetch failure) — return what we have
      }
      if (!wasCached) madeLiveRequest = true;

      pages.push(toApiPage(page));
      if (page.pageNumber >= page.lastPageNumber) break; // don't run past the book's actual end
    }

    return json(pages);
  }

  return null;
}

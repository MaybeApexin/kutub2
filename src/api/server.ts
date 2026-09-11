import {
  fetchAllBookListings,
  fetchArabicSections,
  fetchBookContent,
  fetchBookPage,
  fetchLanguageSections,
  type LanguageSection,
} from "../lib/scraper.ts";

const PORT = Number(process.env.PORT ?? 3000);
const ALLOWED_HOSTS = new Set(["www.islamicbook.ws", "islamicbook.ws"]);
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SECTION_CODE = "ar"; // ar.html — Arabic's general library

type CacheEntry = { expires: number; value: unknown };
const cache = new Map<string, CacheEntry>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;

  const value = await fn();
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers },
  });
}

function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/** Only allow the server to fetch URLs on islamicbook.ws, to prevent these endpoints
 *  from being used as an open proxy for arbitrary server-side requests (SSRF). */
function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw json({ error: `Invalid url: ${raw}` }, { status: 400 });
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw json({ error: "url must be an https:// link on islamicbook.ws" }, { status: 400 });
  }
  return url;
}

/** All browsable sections: Arabic's topical libraries plus every other language's catalog. */
async function allSections(): Promise<{ arabic: LanguageSection[]; languages: LanguageSection[] }> {
  return cached("sections", async () => ({
    arabic: await fetchArabicSections(),
    languages: await fetchLanguageSections(),
  }));
}

async function resolveSectionUrl(code: string): Promise<LanguageSection | null> {
  const { arabic, languages } = await allSections();
  return [...arabic, ...languages].find((s) => s.code === code.toLowerCase()) ?? null;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);

    try {
      if (pathname === "/" || pathname === "/api") {
        return json({
          name: "kutub2 islamicbook.ws API",
          endpoints: {
            "GET /api/languages": "List every browsable section (Arabic's topical libraries + every other language)",
            "GET /api/books?lang=&q=&limit=&offset=&maxPages=":
              "List books in a section (default: ar — Arabic's general library). author is only populated for Arabic's topical libraries; elsewhere only pdfUrl/coverImageUrl are available.",
            "GET /api/books/page?url=": "Fetch a single reader page's text by its contentUrl (Arabic topical libraries only)",
            "GET /api/books/full?url=&maxPages=": "Fetch a book's full text by following its reader pagination from a contentUrl (Arabic topical libraries only)",
          },
        });
      }

      if (pathname === "/api/languages" && req.method === "GET") {
        const { arabic, languages } = await allSections();
        return json({ arabicSections: arabic, languages });
      }

      if (pathname === "/api/books" && req.method === "GET") {
        const code = searchParams.get("lang") ?? DEFAULT_SECTION_CODE;
        const section = await resolveSectionUrl(code);
        if (!section) {
          return error(400, `Unknown lang/section code "${code}". See GET /api/languages for valid codes.`);
        }

        const maxPages = Math.min(Number(searchParams.get("maxPages") ?? 15), 50);
        const { books, truncated } = await cached(`books:${section.url}:${maxPages}`, () =>
          fetchAllBookListings(section.url, { language: section.code, maxPages }),
        );

        const q = searchParams.get("q")?.trim().toLowerCase();
        const filtered = q
          ? books.filter(
              (b) =>
                (b.author?.toLowerCase().includes(q) ?? false) ||
                b.title.toLowerCase().includes(q),
            )
          : books;

        const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);
        const offset = Math.max(Number(searchParams.get("offset") ?? 0), 0);

        return json({
          language: section.code,
          label: section.label,
          total: filtered.length,
          limit,
          offset,
          truncated,
          books: filtered.slice(offset, offset + limit),
        });
      }

      if (pathname === "/api/books/page" && req.method === "GET") {
        const raw = searchParams.get("url");
        if (!raw) return error(400, "Missing required query param: url");
        const url = assertAllowedUrl(raw);

        const result = await cached(`page:${url.toString()}`, () => fetchBookPage(url.toString()));
        return json(result);
      }

      if (pathname === "/api/books/full" && req.method === "GET") {
        const raw = searchParams.get("url");
        if (!raw) return error(400, "Missing required query param: url");
        const url = assertAllowedUrl(raw);

        const maxPages = Math.min(Number(searchParams.get("maxPages") ?? 100), 300);

        const result = await cached(`full:${url.toString()}:${maxPages}`, () =>
          fetchBookContent(url.toString(), { maxPages }),
        );
        return json(result);
      }

      return error(404, `Not found: ${pathname}`);
    } catch (err) {
      if (err instanceof Response) return err;
      console.error(err);
      return error(502, err instanceof Error ? err.message : "Upstream fetch failed");
    }
  },
});

console.log(`kutub2 API listening on http://localhost:${server.port}`);

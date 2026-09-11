import { parse, type HTMLElement } from "node-html-parser";
import { splitAuthorNames } from "./author-split.ts";

const BASE_URL = "https://shamela.ws/";
const USER_AGENT =
  "kutub2-bot/0.1 (+https://github.com/; respectful indexer, low request volume)";

export interface ShamelaCategory {
  /** The numeric id from the category's URL, e.g. 1 for /category/1. */
  id: number;
  /** Category name with the site's own leading "N. " numbering stripped. */
  name: string;
  url: string;
  /** The book count shamela.ws itself reports for this category (its "badge" count). */
  expectedCount: number;
}

export interface ShamelaBookListing {
  title: string;
  uri: string;
  /** The one author shamela.ws links structurally (a stable author/N page). */
  primaryAuthor: { id: number; name: string; url: string } | null;
  /**
   * Every author name found in the free-text "المؤلف:" description line, split on
   * "و" ("and") — see author-split.ts. Index 0 is usually the same person as
   * `primaryAuthor` (shamela only ever links one author, even for co-authored
   * books), just possibly in a different-length form; anything beyond index 0 is a
   * co-author shamela doesn't give its own author/N id or page for.
   */
  authorNamesFromText: string[];
}

async function fetchHtml(url: string): Promise<HTMLElement> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Request to ${url} failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  return parse(html);
}

function text(el: HTMLElement | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Fetches the homepage and parses its "أقسام المكتبة" (library sections) list. */
export async function fetchCategories(): Promise<ShamelaCategory[]> {
  const root = await fetchHtml(BASE_URL);
  const categories: ShamelaCategory[] = [];

  for (const a of root.querySelectorAll("#cats a.cat_title")) {
    const href = a.getAttribute("href");
    const idMatch = href?.match(/\/category\/(\d+)/);
    if (!href || !idMatch) continue;

    const badgeText = text(a.querySelector("span.badge"));
    const fullText = text(a);
    const name = fullText
      .slice(0, fullText.length - badgeText.length)
      .replace(/^\d+\.\s*/, "")
      .trim();

    categories.push({
      id: Number(idMatch[1]),
      name,
      url: href,
      expectedCount: Number(badgeText) || 0,
    });
  }

  return categories;
}

/** Extracts the "المؤلف: ..." line out of a book_item's description paragraph HTML. */
function extractAuthorLine(desHtml: string): string {
  const lines = desHtml.split(/<br\s*\/?>/i);
  for (const line of lines) {
    const plain = text(parse(line));
    const match = plain.match(/^المؤلف\s*:\s*(.+)$/);
    if (match) return match[1]!.trim();
  }
  return "";
}

/**
 * Fetches one category page and parses its book list. Every book on shamela.ws
 * category pages loads in the initial HTML (verified up to 1,245 books on the
 * largest category) — there's no pagination to follow here.
 */
export async function fetchCategoryBooks(categoryUrl: string): Promise<ShamelaBookListing[]> {
  const root = await fetchHtml(categoryUrl);
  const listings: ShamelaBookListing[] = [];

  for (const item of root.querySelectorAll("#cat_books .book_item")) {
    const titleEl = item.querySelector("a.book_title");
    const uri = titleEl?.getAttribute("href");
    const title = text(titleEl);
    if (!uri || !title) continue;

    const authorEl = item.querySelector('a[href*="/author/"]');
    const authorHref = authorEl?.getAttribute("href");
    const authorIdMatch = authorHref?.match(/\/author\/(\d+)/);
    const primaryAuthor =
      authorHref && authorIdMatch
        ? { id: Number(authorIdMatch[1]), name: text(authorEl), url: authorHref }
        : null;

    const desHtml = item.querySelector("p.des")?.innerHTML ?? "";
    const authorLine = extractAuthorLine(desHtml);
    const authorNamesFromText = authorLine ? splitAuthorNames(authorLine) : [];

    listings.push({ title, uri, primaryAuthor, authorNamesFromText });
  }

  return listings;
}

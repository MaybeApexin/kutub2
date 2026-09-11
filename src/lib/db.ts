import { Database } from "bun:sqlite";

const DB_PATH = process.env.BOOKS_DB_PATH ?? "data/shamela.sqlite";

export interface BookRow {
  id: number;
  book_name: string;
  /** Every accredited author joined by "و" ("and") — e.g. "ابن تيمية و ابن القيم"
   *  for a co-authored book. See src/shamela/db.ts's book_listing view. */
  author_name: string;
  book_type: string;
  uri: string;
}

export interface AuthorOption {
  /** The author's database id — pass this back to searchBooks/filters, not the display name. */
  key: string;
  name: string;
}

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    return db;
  } catch (err) {
    throw new Error(
      `Couldn't open the books database at "${DB_PATH}". Run "bun run scrape:shamela" first to build it. (${err instanceof Error ? err.message : err})`,
    );
  }
}

/**
 * Authors matching `query` (case-insensitive substring). Unlike the old
 * islamicbook.ws-backed version of this file, no fuzzy text-normalization grouping
 * is needed here — shamela.ws gives every author (with a profile page) a stable id,
 * so distinct spellings of the same person only collide if shamela.ws itself
 * conflates them.
 */
export function searchAuthors(query: string, limit = 25): AuthorOption[] {
  const rows = getDb()
    .query<AuthorOption, [string, number]>(
      `SELECT CAST(id AS TEXT) AS key, name FROM authors WHERE name LIKE ? ORDER BY name LIMIT ?`,
    )
    .all(`%${query}%`, limit);
  return rows;
}

/** Distinct book types (shamela.ws categories) matching `query`, for autocomplete. */
export function searchBookTypes(query: string, limit = 25): string[] {
  const rows = getDb()
    .query<{ book_type: string }, [string, number]>(
      `SELECT DISTINCT book_type FROM books WHERE book_type LIKE ? ORDER BY book_type LIMIT ?`,
    )
    .all(`%${query}%`, limit);
  return rows.map((r) => r.book_type);
}

export interface BookSearchFilters {
  /** An author id (as a string) from searchAuthors. A co-authored book matches when
   *  this id is ANY of its accredited authors, not just the first-listed one. */
  authorKey?: string;
  bookType?: string;
}

/** Books matching `query` in the title, optionally restricted to a specific author
 *  and/or book_type, for autocomplete. Reads from book_listing (see
 *  src/shamela/db.ts), which already joins each book to all of its authors. */
export function searchBooks(query: string, filters: BookSearchFilters = {}, limit = 25): BookRow[] {
  const conditions = ["bl.book_name LIKE ?"];
  const params: (string | number)[] = [`%${query}%`];

  if (filters.authorKey) {
    conditions.push("bl.id IN (SELECT book_id FROM book_authors WHERE author_id = ?)");
    params.push(Number(filters.authorKey));
  }
  if (filters.bookType) {
    conditions.push("bl.book_type = ?");
    params.push(filters.bookType);
  }
  params.push(limit);

  return getDb()
    .query<BookRow, (string | number)[]>(
      `SELECT bl.id, bl.book_name, bl.author_name, bl.book_type, bl.uri FROM book_listing bl
       WHERE ${conditions.join(" AND ")}
       ORDER BY bl.book_name LIMIT ?`,
    )
    .all(...params);
}

export function getBookByUri(uri: string): BookRow | null {
  return (
    getDb()
      .query<BookRow, [string]>(
        `SELECT id, book_name, author_name, book_type, uri FROM book_listing WHERE uri = ?`,
      )
      .get(uri) ?? null
  );
}

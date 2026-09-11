import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeAuthorKey } from "../lib/text-normalize.ts";

const DB_PATH = process.env.SHAMELA_DB_PATH ?? "data/shamela.sqlite";

export function setupDatabase(path: string = DB_PATH): Database {
  // `data/` is never committed to git — it holds only the gitignored .sqlite
  // output, and git doesn't track empty directories at all — so a fresh clone
  // (e.g. onto a new VPS) has no data/ directory yet. `create: true` below makes
  // the database *file*, not missing parent directories; without this, that fails
  // with SQLITE_CANTOPEN.
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  // Rebuilt fresh each run, same rationale as kutub2's scrape-arabic-library.ts:
  // simplest way to keep the schema and script in sync without a migration step.
  db.run(`DROP TABLE IF EXISTS book_authors`);
  db.run(`DROP TABLE IF EXISTS books`);
  db.run(`DROP TABLE IF EXISTS authors`);

  db.run(`
    CREATE TABLE authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- The id from shamela.ws's own /author/N page. NULL for a co-author found only
      -- in a book's free-text "المؤلف:" line, who has no shamela.ws profile of their own.
      shamela_author_id INTEGER UNIQUE,
      name TEXT NOT NULL,
      -- Normalized form of name, for de-duplicating free-text-only co-authors across
      -- books (an author WITH a shamela_author_id is already deduplicated by that id).
      name_key TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_name TEXT NOT NULL,
      -- The shamela.ws library section this book was listed under, e.g. "العقيدة".
      book_type TEXT NOT NULL,
      uri TEXT NOT NULL UNIQUE
    )
  `);
  db.run(`
    CREATE TABLE book_authors (
      book_id INTEGER NOT NULL REFERENCES books(id),
      author_id INTEGER NOT NULL REFERENCES authors(id),
      -- 1 for the one author shamela.ws structurally links (via author/N); 0 for a
      -- co-author found only by splitting the free-text "المؤلف:" line. Lets the
      -- book_listing view below list the primary author first.
      is_primary INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (book_id, author_id)
    )
  `);
  db.run(`CREATE INDEX idx_authors_name_key ON authors (name_key)`);
  db.run(`CREATE INDEX idx_books_book_type ON books (book_type)`);
  db.run(`CREATE INDEX idx_book_authors_author_id ON book_authors (author_id)`);

  // Integrates each book with its accredited author(s) into one queryable row: for a
  // co-authored book, author_name is every author's name joined by "و" ("and"),
  // primary author first — e.g. "ابن تيمية و ابن القيم" — matching how shamela.ws's
  // own "المؤلف:" line writes multiple authors. This is what src/lib/db.ts (the
  // Discord bot's data layer) reads from.
  db.run(`
    CREATE VIEW book_listing AS
    SELECT
      b.id,
      b.book_name,
      b.book_type,
      b.uri,
      (
        SELECT GROUP_CONCAT(a.name, ' و ' ORDER BY ba.is_primary DESC, a.id)
        FROM book_authors ba JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_id = b.id
      ) AS author_name
    FROM books b
  `);

  return db;
}

export interface AuthorUpserter {
  /** Get-or-create an author identified by their shamela.ws author/N id. */
  byShamelaId(shamelaAuthorId: number, name: string): number;
  /** Get-or-create a free-text-only author (no shamela.ws id), deduplicated by a
   *  normalized form of `name`. */
  byNameOnly(name: string): number;
}

export function makeAuthorUpserter(db: Database): AuthorUpserter {
  const insertByShamelaId = db.prepare(
    `INSERT INTO authors (shamela_author_id, name, name_key) VALUES (?, ?, ?)
     ON CONFLICT(shamela_author_id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key
     RETURNING id`,
  );
  const selectByNameKey = db.prepare<{ id: number }, [string]>(
    `SELECT id FROM authors WHERE name_key = ? AND shamela_author_id IS NULL LIMIT 1`,
  );
  const insertByNameOnly = db.prepare<{ id: number }, [string, string]>(
    `INSERT INTO authors (shamela_author_id, name, name_key) VALUES (NULL, ?, ?) RETURNING id`,
  );

  return {
    byShamelaId(shamelaAuthorId, name) {
      const row = insertByShamelaId.get(shamelaAuthorId, name, normalizeAuthorKey(name)) as
        | { id: number }
        | undefined;
      return row!.id;
    },
    byNameOnly(name) {
      const key = normalizeAuthorKey(name);
      const existing = selectByNameKey.get(key);
      if (existing) return existing.id;
      const row = insertByNameOnly.get(name, key)!;
      return row.id;
    },
  };
}

export function makeBookInserter(db: Database) {
  const insertBook = db.prepare<{ id: number }, [string, string, string]>(
    `INSERT INTO books (book_name, book_type, uri) VALUES (?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET book_name = excluded.book_name, book_type = excluded.book_type
     RETURNING id`,
  );
  const linkAuthor = db.prepare<unknown, [number, number, number]>(
    `INSERT INTO book_authors (book_id, author_id, is_primary) VALUES (?, ?, ?)
     ON CONFLICT(book_id, author_id) DO UPDATE SET is_primary = excluded.is_primary`,
  );

  return {
    upsertBook(bookName: string, bookType: string, uri: string): number {
      return insertBook.get(bookName, bookType, uri)!.id;
    },
    linkAuthor(bookId: number, authorId: number, isPrimary: boolean) {
      linkAuthor.run(bookId, authorId, isPrimary ? 1 : 0);
    },
  };
}

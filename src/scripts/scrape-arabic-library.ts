import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fetchArabicSections, fetchBookIndex, type LanguageSection } from "../lib/scraper.ts";
import { normalizeAuthorKey } from "../lib/text-normalize.ts";

/**
 * Scrapes every Arabic topical library that exposes an in-site HTML reader
 * (i.e. every section except Quran, which is PDF-only — see README) and loads
 * the results into a SQLite table: book name, author name (plus a normalized
 * author_key for grouping/search), book type (the section it came from), and
 * the URI of the book's readable (in-site reader) page.
 */

const DB_PATH = process.env.BOOKS_DB_PATH ?? "data/books.sqlite";
const DELAY_MS = 300; // be light on the source server between section fetches

function setupDatabase(path: string): Database {
  // `data/` is never committed to git — it holds only the gitignored .sqlite
  // output, and git doesn't track empty directories at all — so a fresh clone
  // (e.g. onto a new VPS) has no data/ directory yet. `create: true` below makes
  // the database *file*, not missing parent directories; without this, that fails
  // with SQLITE_CANTOPEN.
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  // Rebuilt fresh each run so schema changes (like adding book_type) don't require
  // a migration step — this script is the source of truth for the table shape.
  db.run(`DROP TABLE IF EXISTS books`);
  db.run(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_name TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_key TEXT NOT NULL,
      book_type TEXT NOT NULL,
      uri TEXT NOT NULL UNIQUE
    )
  `);
  db.run(`CREATE INDEX idx_books_author_key ON books (author_key)`);
  db.run(`CREATE INDEX idx_books_book_type ON books (book_type)`);
  return db;
}

async function main() {
  console.log("Discovering Arabic library sections...");
  const sections: LanguageSection[] = await fetchArabicSections();

  const db = setupDatabase(DB_PATH);
  const insert = db.prepare(
    `INSERT INTO books (book_name, author_name, author_key, book_type, uri) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(uri) DO UPDATE SET
       book_name = excluded.book_name,
       author_name = excluded.author_name,
       author_key = excluded.author_key,
       book_type = excluded.book_type`,
  );

  let inserted = 0;
  let skippedNoReader = 0;

  for (const [i, section] of sections.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, DELAY_MS));

    process.stdout.write(`[${section.code}] ${section.label} ... `);
    const { books } = await fetchBookIndex(section.url, section.code);

    let sectionInserted = 0;
    for (const book of books) {
      // Only Arabic's topical-library layout provides an in-site readable URI;
      // sections without one (Quran's catalog layout) are skipped per-book here.
      if (!book.contentUrl) {
        skippedNoReader++;
        continue;
      }
      const authorName = book.author ?? "";
      insert.run(book.title, authorName, normalizeAuthorKey(authorName), section.label, book.contentUrl);
      sectionInserted++;
      inserted++;
    }
    console.log(`${sectionInserted} readable book(s)`);
  }

  const total = db.query("SELECT COUNT(*) AS n FROM books").get() as { n: number };
  const authorGroups = db.query("SELECT COUNT(DISTINCT author_key) AS n FROM books").get() as {
    n: number;
  };

  console.log(`\nDone. Upserted ${inserted} rows this run (${skippedNoReader} entries skipped — no readable URI).`);
  console.log(
    `Database now holds ${total.n} unique book(s) across ${authorGroups.n} distinct author group(s) at ${DB_PATH}.`,
  );

  db.close();
}

main().catch((err) => {
  console.error("Scrape failed:", err);
  process.exit(1);
});

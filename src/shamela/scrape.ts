import { fetchCategories, fetchCategoryBooks, type ShamelaBookListing } from "./scraper.ts";
import { setupDatabase, makeAuthorUpserter, makeBookInserter } from "./db.ts";

/**
 * Scrapes every category listed on shamela.ws's "أقسام المكتبة" (library sections)
 * page and loads book name, category ("type"), URI, and author(s) into a SQLite
 * database — separate from, and not wired into, the Discord bot.
 *
 * Every category page loads its full book list in one request (verified up to 1,245
 * books on the largest category — no pagination to follow), so the whole ~8,600-book
 * catalog takes only ~41 HTTP requests total: one for the category list, one per
 * category for its books.
 */

const DB_PATH = process.env.SHAMELA_DB_PATH ?? "data/shamela.sqlite";
const DELAY_MS = 500; // be light on the source server between category fetches

/** Links a book to its author(s): the one shamela.ws structurally links (if any),
 *  plus any additional co-authors found by splitting the free-text "المؤلف:" line
 *  (see author-split.ts). The free-text line's first name is treated as the same
 *  person as the linked author — just possibly a differently-complete text form —
 *  so it isn't re-created as a separate, unlinked author record. */
function linkBookAuthors(
  book: ShamelaBookListing,
  bookId: number,
  authors: ReturnType<typeof makeAuthorUpserter>,
  books: ReturnType<typeof makeBookInserter>,
): number {
  let primaryAuthorId: number | null = null;
  if (book.primaryAuthor) {
    primaryAuthorId = authors.byShamelaId(book.primaryAuthor.id, book.primaryAuthor.name);
    books.linkAuthor(bookId, primaryAuthorId, true);
  }

  const linkedIds = new Set<number>(primaryAuthorId !== null ? [primaryAuthorId] : []);

  book.authorNamesFromText.forEach((name, index) => {
    if (index === 0 && primaryAuthorId !== null) return; // same person as the linked author
    const authorId = authors.byNameOnly(name);
    books.linkAuthor(bookId, authorId, false);
    linkedIds.add(authorId);
  });

  return linkedIds.size;
}

async function main() {
  console.log("Discovering shamela.ws categories...");
  const categories = await fetchCategories();
  console.log(
    `Found ${categories.length} categories, ${categories.reduce((s, c) => s + c.expectedCount, 0)} books expected.\n`,
  );

  const db = setupDatabase(DB_PATH);
  const authors = makeAuthorUpserter(db);
  const books = makeBookInserter(db);

  let totalBooks = 0;
  let totalMultiAuthor = 0;
  let totalNoAuthor = 0;

  for (const [i, category] of categories.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, DELAY_MS));

    process.stdout.write(`[${category.id}/${categories.length}] ${category.name} ... `);
    const listings = await fetchCategoryBooks(category.url);

    let multiAuthorInCategory = 0;
    for (const listing of listings) {
      const bookId = books.upsertBook(listing.title, category.name, listing.uri);
      const authorCount = linkBookAuthors(listing, bookId, authors, books);
      if (authorCount > 1) multiAuthorInCategory++;
      if (authorCount === 0) totalNoAuthor++;
      totalBooks++;
    }
    totalMultiAuthor += multiAuthorInCategory;

    const mismatch = listings.length !== category.expectedCount ? ` (expected ${category.expectedCount}!)` : "";
    console.log(`${listings.length} book(s)${mismatch}, ${multiAuthorInCategory} multi-author`);
  }

  const authorCount = (db.query("SELECT COUNT(*) AS n FROM authors").get() as { n: number }).n;

  console.log(`\nDone. ${totalBooks} book(s), ${authorCount} distinct author(s) at ${DB_PATH}.`);
  console.log(`${totalMultiAuthor} book(s) detected with more than one author; ${totalNoAuthor} with none found.`);

  db.close();
}

main().catch((err) => {
  console.error("Scrape failed:", err);
  process.exit(1);
});

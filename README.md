# kutub2

A basic Discord bot built with TypeScript and [Bun](https://bun.sh), using [discord.js](https://discord.js.org), plus a small HTTP API that indexes the text library at [islamicbook.ws](https://www.islamicbook.ws/), across every language section the site offers.

## Discord bot setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications).
   - Under **Bot**, create a bot user and copy its token.
   - Under **OAuth2**, copy the **Client ID** (also shown on the General Information page).
2. Copy `.env.example` to `.env` and fill in the values:

   ```bash
   cp .env.example .env
   ```

   - `DISCORD_TOKEN` — your bot token
   - `CLIENT_ID` — your application's client ID
   - `GUILD_ID` — (optional, recommended for dev) a server ID to deploy slash commands to instantly. Leave blank to deploy globally (can take up to an hour to propagate).

3. Install dependencies:

   ```bash
   bun install
   ```

4. Invite the bot to a server using an OAuth2 URL with the `bot` and `applications.commands` scopes, e.g.:

   ```text
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=0&scope=bot%20applications.commands
   ```

5. Deploy the slash commands:

   ```bash
   bun run deploy-commands
   ```

6. Start the bot:

   ```bash
   bun run dev    # watch mode
   bun run start  # one-off run
   ```

Try `/ping` in your server once the bot is online.

### `/ask` — question, argument, or claim about a book

`/ask` lets you pick a book (optionally narrowed by author and/or type first) and ask a question, pose an argument, or test a claim against its actual text — answered by an LLM (Google Gemini) grounded only in that book. It ran on Groq originally; switched to Gemini once a Google AI API key was available (see [gemini.ts](src/lib/gemini.ts)). [groq.ts](src/lib/groq.ts) still works if you'd rather switch back — see `.env.example`.

- `author` (optional) — autocompletes against authors in the database. Choosing one narrows the `book` suggestions to just their books (matching a co-authored book on *any* of its authors — see below).
- `type` (optional) — autocompletes against book categories (Aqeedah, Fiqh, History, ...). Choosing one narrows the `book` suggestions to that category, and combines with `author` if both are set — e.g. Ibn Taymiyyah + Aqeedah shows only his Aqeedah books, not his Fiqh or History ones too.
- `book` — autocompletes by title (filtered by whichever of `author`/`type` are set). Required for the command to do anything; its value is the book's URI, looked up in the database.
- `question` — your question, argument, or claim (up to 500 characters).

`author`/`type` narrowing (`/fetch` has the identical `author`/`type`/`book` picker) is implemented in [book-picker.ts](src/lib/book-picker.ts), which reads whichever of those two are already filled in when `book` autocompletes and passes both to [db.ts](src/lib/db.ts)'s `searchBooks` as an AND filter. I re-verified this directly against a mocked Discord autocomplete request (not just the underlying SQL) for author alone, type alone, and both together, and all three narrowed correctly every time. If this doesn't narrow for you in practice, the near-certain cause is Discord serving a stale command definition from before a recent code change — run `bun run deploy-commands` again.

**Cooldown:** this account's Gemini key is capped at 5 requests per minute, and each `/ask` call makes 2 (search-term extraction + the answer) — shared across every Discord user, not per user, since it's one API key for the whole bot. [command-cooldown.ts](src/lib/command-cooldown.ts) enforces a flat 31-second minimum gap between invocation starts bot-wide, which caps steady-state usage at 4 of the 5 RPM with a full request of margin; a command run before the gap elapses gets a "try again in Ns" reply instead of touching Gemini at all. Tune it with `ASK_COOLDOWN_MS` if your key's limit differs. `/fetch` makes no LLM calls, so it isn't gated.

It needs the SQLite database described below, plus `GOOGLE_API_KEY` in `.env` (get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)):

```bash
bun run scrape:shamela   # build/refresh data/shamela.sqlite (see below)
```

`/ask` doesn't just read from page 1 — that only worked for short treatises. A large reference work like *al-Mughni* (Ibn Qudamah's ~7,000-page Hanbali fiqh encyclopedia) devotes its opening pages to biographical front matter, so a question about a specific ruling landed nowhere near the actual discussion; tested against a real question, that produced a useless "the text provided doesn't cover this" answer. [src/lib/book-retrieval.ts](src/lib/book-retrieval.ts) fixes this: it first asks the LLM for a short Arabic search phrase for the question (e.g. "what is the ruling on tawasul?" → "حكم التوسل بالأنبياء والصالحين" — Gemini's extraction turned out to specifically name "prophets and the righteous," which is what made the fix below work as well as it did), searches *within that specific book* using shamela.ws's own in-book search (the "بحث في هذا الكتاب" box — found by reading its page JS, since it's not a documented API), and fetches the full text of whichever pages it matches, stopping at `GEMINI_MAX_CONTEXT_CHARS` (default 12,000 characters). Only if that search step fails or finds nothing does it fall back to reading from page 1, same as before — reasonable for a short book, a last resort for a long one. The reply's footer says which happened, and for a search-grounded answer, what phrase was searched.

**Switching providers surfaced its own pitfalls, worth knowing about regardless of which one you use.** First: don't trust a model name from memory, or even from a docs page fetched live — before wiring Gemini in, one fetched doc page confidently listed `gemini-2.5-pro` as "the most advanced" model, and a request to it 404'd outright ("no longer available to new users"). What actually worked was querying `GET /v1beta/models` with the real key and reading the live list back, and then individually smoke-testing each candidate — that's how [gemini.ts](src/lib/gemini.ts) settled on its default model list (re-run that query first if any of them stop working — model availability drifts by account and over time).

Second: the exact same failure class from the Groq days reappeared under a different name. Gemini's flash models "think" before answering, and — verified empirically, the same way the Groq bug was diagnosed — a small `maxOutputTokens` let invisible "thinking" tokens consume the entire budget and return empty content. Unlike Groq, `thinkingBudget: 0` is flatly rejected on these models (400 error); the field that actually works is `thinkingLevel`. Testing every value found that `"minimal"` costs zero thinking tokens on gemini-3.5/3.6-flash — used for the cheap search-term extraction — while `"low"`/`"medium"`/`"high"` trade real token overhead for better reasoning, worth it for the harder synthesis call. Testing also found this isn't uniform across models: `gemini-3.7-flash` flatly rejects `thinkingLevel: "minimal"` with a 400, a config quirk `callModel` in gemini.ts now handles generically (retry once without `thinkingConfig`) rather than assuming every model in the fallback chain below behaves like the first one. [llm-text-safety.ts](src/lib/llm-text-safety.ts) holds `stripDegenerateRepetition` (the repeated-character backstop from the Groq days) as a shared utility, since it's a generic LLM-output safety net rather than something specific to one provider.

**Multi-model fallback:** this account's Gemini key is capped at 5 requests/minute (see the cooldown below), and Gemini's free-tier quotas are scoped per model rather than shared across a key's whole lineup — so falling back to a *different* model on a rate limit genuinely helps, rather than hitting the same wall again immediately. `GEMINI_MODELS` (`.env.example`) is an ordered, comma-separated list — `gemini-3.6-flash,gemini-3.5-flash,gemini-3.7-flash` by default, each individually verified against a real key before being included. `askGemini` tries them in order and only advances to the next one on an actual 429; any other error (a bad request, a safety block) is surfaced immediately instead of being retried across every model, since that kind of failure would just repeat. Verified with a mocked rate-limit response: falls through to the next model on 429 and returns its answer; does *not* try a second model on a non-429 error.

**The reply is two embeds**, not one: a neutral amber "book card" (title, author, type, and the question, with a `Grounding` field so you can tell at a glance whether the answer is search-grounded or a fallback), then the answer itself as a second embed colored green for a targeted match or amber for the fallback case — the same color signal as the footer text, just visible without reading it.

**A single matched page can still mislead, even when the search itself worked.** Found by testing a real question against *al-Mughni*: asking for the ruling on *tawasul* (seeking intercession — a theological topic normally covered in creed books) matched a page that does contain the word التوسل, but only in its everyday sense of "resorting to a means," inside one narrow ruling about a sales-transaction trick — completely unrelated to the theological question. Read on its own, the page looked like a general ruling on tawasul; it wasn't. [shamela-reader.ts](src/lib/shamela-reader.ts) extracts each page's nearest named heading from the book's own table of contents (e.g. "مسألة ٧٤٩: whoever sells a commodity on credit...") — free, no extra request, it's already in the page's HTML — and passes it to the LLM alongside the page text, with an explicit instruction to flag a narrowly-scoped ruling or an unexpected sense of a key term rather than presenting it as general. Re-tested end to end on Gemini: the answer now opens by stating outright that التوسل here does *not* refer to the theological topic of seeking intercession, then separately explains both matched passages (a Book of Manumission ruling and the Book of Sales one) under their real, narrow scope. This is a real, verified improvement, not a complete fix — correctly recognizing that a term is being used in an unrelated sense is a judgment call the model can still miss, not something a heading alone guarantees.

### `/fetch` — open a book and page through it

`/fetch` uses the same `author`/`type`/`book` picker as `/ask`, but instead of asking a question it just opens the book: it replies with the book's actual text and ◀ Prev / Next ▶ buttons so you can page through it, scoped to whoever ran the command.

- `page` — open exactly this one page.
- `pagestart` / `pageend` — browse a specific range, either end optional (defaults to page 1 / the book's last page). Prev/Next stay bounded to this range rather than wandering into the rest of the book. Not combinable with `page`.
- With none of these set, `/fetch` browses the whole book starting from page 1, as before.

Since a single shamela.ws page is rarely enough on its own to fill a Discord embed, `/fetch` combines consecutive pages into each reply — but as **separate embeds, one per page**, rather than joining their text into one block. Discord gives each embed its own colored left border, so adjacent pages alternate between blue and purple and the boundary between them is unmistakable, no inline separator text needed; a page's embed title also links straight to that page on shamela.ws. A neutral amber "book card" embed sits on top with the title, author, type, and the page range currently shown. Clicking Next only fetches further pages once you've paged past what's already loaded — it doesn't pull the whole book up front — and clicking Prev walks backward from the current chunk's start the same way, reproducing the exact boundary the forward direction would have landed on, still respecting a `pagestart`/`pageend` scope if one was given.

Combining stops at whichever comes first: a soft ~3000-character budget, or a hard cap of 6 pages per reply — Discord allows at most 10 embeds in one message (1 is always the book card), and shamela.ws pages can be short enough that the character budget alone wouldn't reliably stop well under that limit. Verified directly: forcing a huge character budget on a real book still stopped at exactly 6 pages.

Both commands read book text via [src/lib/shamela-reader.ts](src/lib/shamela-reader.ts): a book's own page (e.g. `https://shamela.ws/book/12876`) only shows a bibliographic card and table of contents, not text — the actual reader is at `.../book/12876/{pageNumber}`, page numbers are a simple sequential counter starting at 1, and each page's own "jump to last page" link is how the book's total page count is found (no page-count field exists anywhere else on the page).

## Discord bot's book database (shamela.ws)

`bun run scrape:shamela` builds `data/shamela.sqlite` — see "Shamela scraper" further below for how it works and its schema (`authors` / `books` / `book_authors`, plus a `book_listing` view that joins each book to its accredited author(s)). [src/lib/db.ts](src/lib/db.ts) is what `/ask` and `/fetch` actually query: it reads `book_listing` for search/narrowing, and resolves an `author` filter to "any book crediting this author id" via `book_authors` — so a co-authored book is found regardless of which of its authors you filtered by.

This replaced an earlier version of the bot's database, built by scraping islamicbook.ws instead (`bun run scrape:ar`, `data/books.sqlite`, [scrape-arabic-library.ts](src/scripts/scrape-arabic-library.ts)). That script and its output are no longer used by the bot but are still here — the standalone [Book API](#book-api) below still scrapes islamicbook.ws directly (it doesn't use either SQLite database), and the old script works fine if you want that data again; just point `BOOKS_DB_PATH` at it. `src/lib/scraper.ts` (islamicbook.ws's reader) is likewise now only used by the Book API — it still refuses, with a clear error, to be pointed at a non-islamicbook.ws URL, which is what first surfaced that `/ask`/`/fetch` needed their own shamela.ws-specific reader instead of reusing it.

## Book API

A separate HTTP service scrapes islamicbook.ws. The site uses two different page layouts, and the scraper auto-detects which one it's looking at:

- **Arabic's topical libraries** (Quran sciences, Hadith, Creed, Fiqh, History, Literature, and the General Library — 7 of Arabic's 8 sections) use a table with an author column, a title column, a PDF download icon, and a "book" icon linking to an in-site HTML reader. This is the only layout with both an author field and full readable text.
- **Every other language** (English, Urdu, French, and ~30 more — see `GET /api/languages`), plus Arabic's own Quran section, use a card catalog: a cover image, a title, and a PDF download link. There's no author field and no in-site reader here — only a PDF.

Start it with:

```bash
bun run api       # one-off run, http://localhost:3000
bun run api:dev   # watch mode
```

### Endpoints

- `GET /api/languages` — every browsable section, discovered live from the site's own navigation: `arabicSections` (Arabic's 8 topical libraries) and `languages` (Arabic plus every other language, ~35 total). Each entry has a `code` (use it as `lang` below), a `label`, and its index `url`.
- `GET /api/books?lang=&q=&limit=&offset=&maxPages=` — book listings for one section. `lang` is a section `code` from `/api/languages` (default `ar`, Arabic's general library). `q` filters by author/title substring, `limit`/`offset` paginate the response, `maxPages` caps how many of the *source* site's own catalog pages to follow for languages with multi-page listings (default 15, max 50). `author` and `contentUrl` are only populated for Arabic's topical libraries — elsewhere they're `null` and only `pdfUrl`/`coverImageUrl` are available.
- `GET /api/books/page?url=` — a single reader page's text, given a `contentUrl` from the index (Arabic's topical libraries only).
- `GET /api/books/full?url=&maxPages=` — a book's full text, starting from its `contentUrl` and following its page-by-page navigation (`maxPages` caps how many pages are fetched, default 100, max 300).

`url` must be an `https://islamicbook.ws/...` (or `www.` subdomain) link — the server rejects anything else, since the value is fetched server-side. The two `/page` and `/full` endpoints also reject any URL that isn't actually an in-site reader page (e.g. passing a catalog or PDF URL returns a clear error instead of garbage).

Requests to the source site are cached in memory for 10 minutes, and multi-page fetches (`full`, and `books` for paginated catalogs) run sequentially with a short delay between requests to stay light on islamicbook.ws.

### Notes

- The library's own footer states its texts' rights are open to all Muslims, and Arabic topical-library authors (e.g. Ibn Muflih al-Maqdisi, Ibn al-Qayyim) are centuries-deceased classical scholars — public-domain material either way. This service only indexes and re-serves what the site already publishes for free; it fetches from islamicbook.ws at request time rather than storing a local copy.
- Some catalog entries (e.g. several Urdu listings) only carry a generic "Book Cover" placeholder as their title in the site's own markup — that's not a parsing bug, the source page genuinely has no real title text for those, only a PDF.

## Shamela scraper (standalone — not wired into the bot)

`src/shamela/` is a separate scraper for [shamela.ws](https://shamela.ws) (المكتبة الشاملة), a much larger Arabic Islamic library (~8,600 books across 40 categories). It's independent of everything above: its own database, its own script, no imports from `src/commands/`, `src/index.ts`, or `src/deploy-commands.ts`, and nothing here is exposed as a bot command yet.

```bash
bun run scrape:shamela   # builds/refreshes data/shamela.sqlite
```

shamela.ws's category pages each load their entire book list in one request (no pagination to follow, verified up to 1,245 books on the largest category), so the whole catalog takes about 41 HTTP requests. Schema:

```sql
CREATE TABLE authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shamela_author_id INTEGER UNIQUE,  -- NULL for a co-author with no shamela.ws profile of their own
  name TEXT NOT NULL,
  name_key TEXT NOT NULL             -- normalized, for de-duplicating free-text-only co-authors
);
CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_name TEXT NOT NULL,
  book_type TEXT NOT NULL,  -- the shamela.ws category, e.g. "العقيدة"
  uri TEXT NOT NULL UNIQUE
);
CREATE TABLE book_authors (
  book_id INTEGER NOT NULL REFERENCES books(id),
  author_id INTEGER NOT NULL REFERENCES authors(id),
  PRIMARY KEY (book_id, author_id)
);
```

**Multiple authors:** shamela.ws structurally links only one author per book (a stable `author/N` id), even for books that are genuinely co-authored. Its free-text "المؤلف:" description line does list every author when there's more than one, joined by "و" ("and") — so [author-split.ts](src/shamela/author-split.ts) splits that line back into separate names and links each as a co-author. This is a text heuristic, not real parsing, and it was tuned against real false positives found by manually auditing every multi-author result across the full catalog — e.g. a name that itself starts with the letter و ("ابن وهب"), and "و" connecting two facts about one author rather than naming a second one ("...المشهور (أبو بكر)...", "لا تصح نسبته...", an alias introduction). After that tuning it flags 6 books as multi-author, all of which check out as genuine on inspection (e.g. تفسير الجلالين, authored jointly by al-Mahalli and al-Suyuti; a father-and-son continuation on الإبهاج في شرح المنهاج). It can still miss or misjudge a case worded differently than anything seen so far.

## Project structure

```text
src/
  index.ts               # Discord bot entrypoint, client + interaction (+ autocomplete) handling
  deploy-commands.ts     # registers Discord slash commands
  commands/
    ping.ts                # example slash command
    ask.ts                 # /ask — question/argument/claim about a book, via Gemini
    fetch.ts               # /fetch — open a book and page through it with buttons
  lib/
    scraper.ts            # islamicbook.ws layout detection, language discovery, index + reader parsing (Book API only, see below)
    shamela-reader.ts      # shamela.ws book-page reader (used by /ask and /fetch)
    db.ts                  # read-only SQLite access (author/type/book search, lookup by uri) — now shamela.ws-backed
    book-picker.ts         # shared author/type/book autocomplete, used by /ask and /fetch
    text-normalize.ts      # Arabic name normalization (used by src/shamela/'s author de-duplication)
    book-retrieval.ts      # in-book search -> relevant excerpts, with a page-1 fallback
    gemini.ts               # Gemini chat client used by /ask (current default)
    groq.ts                # Groq chat client — unused by default, still wired and working
    command-cooldown.ts    # global (bot-wide) cooldown gate, used by /ask
    llm-text-safety.ts     # stripDegenerateRepetition, shared by gemini.ts and groq.ts
    book-text-cache.ts     # budget-aware shamela.ws book text fetch + in-memory cache
  scripts/
    scrape-arabic-library.ts  # builds data/books.sqlite (bun run scrape:ar)
  api/
    server.ts             # Bun.serve HTTP API for the book library
  shamela/                # standalone shamela.ws scraper — not wired into the bot
    scraper.ts               # category list + per-category book listing parsing
    author-split.ts          # free-text "المؤلف:" line -> individual author names
    db.ts                    # schema + upsert helpers (authors / books / book_authors)
    scrape.ts                # entrypoint (bun run scrape:shamela)
```

To add a new Discord command, create a file in `src/commands/` exporting `data` (a `SlashCommandBuilder`) and `execute`, then register it in both `src/index.ts` and `src/deploy-commands.ts`.

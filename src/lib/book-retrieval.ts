import { askGemini } from "./gemini.ts";
import { searchWithinBook, fetchShamelaPage } from "./shamela-reader.ts";
import { getBookParagraphs, type CachedParagraph } from "./book-text-cache.ts";

const SEARCH_HIT_LIMIT = 5;
const PAGE_DELAY_MS = 150;

export type RetrievedParagraph = CachedParagraph;

export interface RetrievedContext {
  paragraphs: RetrievedParagraph[];
  truncated: boolean;
  /** True if `paragraphs` is grounded in shamela.ws's own search results for the
   *  question, rather than just the book's opening pages. */
  usedSearch: boolean;
  /** The Arabic search phrase used, when usedSearch is true. */
  searchTerm?: string;
}

/**
 * Renders a RetrievedContext into the indexed, citeable text block sent to the
 * LLM: each paragraph tagged with its page and in-page position (e.g. "[P47:¶2]")
 * so the model can cite back to the exact unit its claim came from, grouped under
 * its page and (when known) section heading for readability.
 */
export function formatContextForPrompt(context: RetrievedContext): string {
  const blocks: string[] = [];
  let currentPage: number | null = null;

  for (const p of context.paragraphs) {
    if (p.page !== currentPage) {
      currentPage = p.page;
      const heading = p.sectionHeading ? ` — Section: ${p.sectionHeading}` : "";
      blocks.push(`--- Page ${p.page}${heading} ---`);
    }
    blocks.push(`[P${p.page}:¶${p.paragraph}] ${p.text}`);
  }
  return blocks.join("\n");
}

/**
 * Asks Gemini for a short Arabic search phrase likely to appear verbatim in a
 * classical Arabic text discussing the user's question — e.g. "tawasul" (in
 * English, or however it's asked) -> "التوسل" — used to search *within* one
 * specific book via shamela.ws's own search, instead of reading blind from page 1.
 * A cheap, simple task like this doesn't need real reasoning, so thinkingLevel
 * "minimal" is used — verified to cost zero thinking tokens (see gemini.ts).
 */
async function extractSearchTerm(question: string): Promise<string> {
  const raw = await askGemini(
    "You turn a question about an Islamic religious or legal topic into a short Arabic search phrase " +
      "(2 to 5 words) likely to appear verbatim in a classical Arabic text discussing it — the exact " +
      "technical term or phrase a classical scholar would use, not a paraphrase or translation gloss. " +
      "Respond with ONLY the Arabic phrase itself: no quotes, no explanation, no punctuation, one line.",
    question,
    { maxTokens: 100, temperature: 0, thinkingLevel: "minimal" },
  );
  return raw
    .trim()
    .split("\n")[0]!
    .replace(/^["'«»]+|["'«».]+$/g, "")
    .trim();
}

/**
 * Gets the text most relevant to `question` from a book, as individually-indexed
 * paragraphs: tries shamela.ws's own in-book search first (via a short Arabic
 * phrase Gemini extracts from the question), fetching the full text of whichever
 * pages it matches — since a large reference work can run to several thousand
 * pages, and the answer to a specific question is rarely in its opening pages.
 * Falls back to reading from page 1 (the old behavior) if the search step fails
 * or turns up nothing.
 */
export async function getRelevantBookText(
  bookUri: string,
  question: string,
  targetChars: number,
): Promise<RetrievedContext> {
  try {
    const searchTerm = await extractSearchTerm(question);
    if (searchTerm) {
      const hits = await searchWithinBook(bookUri, searchTerm, SEARCH_HIT_LIMIT);
      if (hits.length > 0) {
        const paragraphs: RetrievedParagraph[] = [];
        let length = 0;
        let truncated = false;

        outer: for (const [i, hit] of hits.entries()) {
          if (i > 0) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
          const page = await fetchShamelaPage(bookUri, hit.pageNumber);

          // The section heading matters more than it might look: a page's text alone
          // can read as a general statement when it's actually a narrow remark tied
          // to one specific case — found in testing, where a fiqh book's throwaway
          // use of "التوسل" ("resorting to [a means]") inside one ruling about a sales
          // trick got mistaken by the model for a general statement on the unrelated
          // theological topic of the same word. Labeling which case/chapter a page
          // falls under is what lets the model catch that itself.
          for (const [j, text] of page.paragraphs.entries()) {
            if (!text) continue;
            if (length + text.length > targetChars) {
              truncated = true;
              break outer;
            }
            paragraphs.push({ page: hit.pageNumber, paragraph: j + 1, text, sectionHeading: page.sectionHeading });
            length += text.length;
          }
        }

        if (paragraphs.length > 0) {
          return { paragraphs, truncated, usedSearch: true, searchTerm };
        }
      }
    }
  } catch (err) {
    console.error("Search-based retrieval failed, falling back to reading from page 1:", err);
  }

  const fallback = await getBookParagraphs(bookUri, targetChars);
  return { paragraphs: fallback.paragraphs, truncated: fallback.truncated, usedSearch: false };
}

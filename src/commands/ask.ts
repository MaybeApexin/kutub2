import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getBookByUri } from "../lib/db.ts";
import { getRelevantBookText, formatContextForPrompt } from "../lib/book-retrieval.ts";
import { askGeminiJSON } from "../lib/gemini.ts";
import { handleBookPickerAutocomplete, truncate } from "../lib/book-picker.ts";
import { createCooldown } from "../lib/command-cooldown.ts";
import { CITATION_ANSWER_SCHEMA, verifyCitations, type AnswerWithCitations } from "../lib/citation.ts";

// ~2.5 chars/token is a safe estimate for this Arabic source text.
const MAX_CONTEXT_CHARS = Number(process.env.GEMINI_MAX_CONTEXT_CHARS ?? 12_000);

// Discord's own per-embed field cap.
const MAX_REFERENCES = 25;

// Each /ask call makes 2 Gemini requests (search-term extraction + the answer),
// and this account's key is capped at 5 requests per minute — shared across every
// Discord user hitting the bot, not per user. A flat minimum gap of 31s between
// invocation starts guarantees at most 2 can ever start within any 60-second
// window (3 would need >=62s of spread at a 31s gap), capping steady-state usage
// at 4 of the 5 RPM with a full request of margin. Override with ASK_COOLDOWN_MS
// if your key's limit is different.
const ASK_COOLDOWN_MS = Number(process.env.ASK_COOLDOWN_MS ?? 31_000);
const cooldown = createCooldown(ASK_COOLDOWN_MS);

export const data = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("Ask a question, argument, or claim about a classical Arabic Islamic text")
  .addStringOption((opt) =>
    opt
      .setName("author")
      .setDescription("Filter by author first to narrow the book list (optional)")
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("type")
      .setDescription("Filter by book type/category first to narrow the book list (optional)")
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt.setName("book").setDescription("The book to ask about — required").setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("question")
      .setDescription("Your question, argument, or claim — required")
      .setMaxLength(500),
  );

export const autocomplete = handleBookPickerAutocomplete;

export async function execute(interaction: ChatInputCommandInteraction) {
  const bookUri = interaction.options.getString("book");
  const question = interaction.options.getString("question");

  if (!bookUri) {
    await interaction.reply({
      content:
        "Please choose a book — start typing in the `book` option and pick one from the suggestions " +
        "(optionally choose an `author` and/or `type` first to narrow the list).",
      ephemeral: true,
    });
    return;
  }
  if (!question) {
    await interaction.reply({
      content: "Please include a `question` — your question, argument, or claim about the book.",
      ephemeral: true,
    });
    return;
  }

  const book = getBookByUri(bookUri);
  if (!book) {
    await interaction.reply({
      content: "That book wasn't found in the database — please pick one from the autocomplete list.",
      ephemeral: true,
    });
    return;
  }

  // Gate on the cooldown here — after the free validation above, right before the
  // first Gemini call — so a mistyped/missing option doesn't burn a shared slot
  // that was meant to protect the API rate limit.
  const waitMs = cooldown.tryAcquire();
  if (waitMs !== null) {
    await interaction.reply({
      content: `This command is answering another question right now — please try again in ${Math.ceil(waitMs / 1000)}s.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const context = await getRelevantBookText(book.uri, question, MAX_CONTEXT_CHARS);
    const excerpt = formatContextForPrompt(context);

    const systemPrompt =
      "You are a careful research assistant answering questions about one specific classical Arabic " +
      "Islamic text. You are given an excerpt from the book — " +
      (context.usedSearch
        ? "several separate passages found by searching the book for terms related to the question, " +
          "each labeled with its page number and, where known, the specific chapter/case (مسألة/باب/كتاب) " +
          "it falls under; they are not necessarily contiguous with each other"
        : "its opening pages, since a more targeted search of the book for this question turned up nothing") +
      " — and a question, argument, or claim from the user. Base your answer only on the provided text — " +
      "if it doesn't address the question, say so plainly instead of guessing or using outside knowledge. " +
      "Pay close attention to each passage's labeled chapter/case: a classical fiqh text often makes a " +
      "narrow remark scoped to one specific case, and a key term can carry a different, more mundane sense " +
      "there than its common technical meaning elsewhere (e.g. \"التوسل\" meaning plain \"resorting to a " +
      "means\" inside a ruling on a sales transaction, not the theological topic of seeking intercession). " +
      "If a passage's ruling looks scoped to a specific case rather than the general topic, or a term looks " +
      "like it's being used in an unexpected sense, say so explicitly rather than presenting it as a general " +
      "ruling.\n\n" +
      "You must respond as structured JSON matching the given schema: break your answer into a small number " +
      "of distinct factual claims (typically 2 to 6 — do not split into one claim per sentence). Every " +
      "paragraph in the excerpt is tagged like \"[P47:¶2]\" (page 47, paragraph 2) — each claim's citations " +
      "array must cite the exact page and paragraph number(s) that support it, taken only from those tags. " +
      "Never cite a page/paragraph that isn't tagged in the excerpt. If a claim draws on more than one " +
      "paragraph, cite all of them. If the excerpt doesn't support part of your answer, don't state that " +
      "part as fact — set \"uncertain\" to true instead, and only include claims you can actually cite. " +
      "Each claim's \"text\" should explain and synthesize in your own words; you may quote a short phrase " +
      "for precision, but never reproduce long verbatim passages. Write in the same language the user asked in.";

    const userPrompt =
      `Book: ${book.book_name}\nAuthor: ${book.author_name}\nType: ${book.book_type}\n\n` +
      `--- Excerpt${context.truncated ? " (truncated to fit)" : ""} ---\n${excerpt}\n--- End of excerpt ---\n\n` +
      `User's question/argument/claim: ${question}`;

    // The scoping/sense-check instructions above, plus decomposing into cited
    // claims, need a bit more reasoning room than a flat free-text answer —
    // thinkingLevel "low" keeps some reasoning capacity for that judgment call
    // (recognizing a narrowly-scoped ruling, an unexpected term sense, or which
    // paragraph actually backs a claim) while keeping overhead modest; maxTokens
    // has headroom for both that overhead and the structured output itself.
    const result = await askGeminiJSON<AnswerWithCitations>(systemPrompt, userPrompt, {
      maxTokens: 2000,
      thinkingLevel: "low",
      responseSchema: CITATION_ANSWER_SCHEMA,
      // Fires at most once, only if answering is taking longer than usual (a
      // model fallback or retry sweep) — keeps the deferred reply reassuring
      // instead of silent, without revealing why it's taking longer.
      onRetrying: () => {
        interaction.editReply("Still working on it — grounding your answer now…").catch(() => {});
      },
    });

    const verifiedClaims = verifyCitations(result, context);

    const footerNotes: string[] = [];
    if (context.usedSearch) {
      footerNotes.push(`Grounded in passages matching "${context.searchTerm}" found within the book.`);
      if (context.truncated) footerNotes.push("Not every matching passage fit within the length budget.");
    } else {
      footerNotes.push(
        `No targeted match was found for this question, so ${context.truncated ? "only the opening portion of" : "the (short) full text of"} this book was used.`,
      );
    }
    if (result.uncertain) {
      footerNotes.push("⚠️ The model flagged this answer as not fully grounded in the excerpt.");
    }

    // A neutral "book card" up top, mirroring /fetch's layout — colored by how the
    // excerpt itself was grounded (targeted search vs. opening-pages fallback).
    const metaEmbed = new EmbedBuilder()
      .setTitle(truncate(book.book_name, 256))
      .setURL(book.uri)
      .setColor(0xd69e2e)
      .addFields(
        { name: "Type", value: truncate(book.book_type, 1024), inline: true },
        {
          name: "Grounding",
          value: context.usedSearch ? "🟢 Targeted match" : "🟠 Book opening (fallback)",
          inline: true,
        },
        { name: "Question", value: truncate(question, 1024) },
      );
    if (book.author_name) metaEmbed.setAuthor({ name: truncate(book.author_name, 256) });

    // Assign each distinct {page, paragraph} a stable footnote-style number, in
    // order of first appearance across claims, so the same cited paragraph reused
    // by two claims gets one shared number rather than two.
    const citationKey = (page: number, paragraph: number) => `${page}:${paragraph}`;
    const citationNumbers = new Map<string, number>();
    const references: { number: number; page: number; paragraph: number; verified: boolean; snippet?: string }[] = [];
    let anyUncitedClaims = false;

    for (const claim of verifiedClaims) {
      if (claim.citations.length === 0) anyUncitedClaims = true;
      for (const c of claim.citations) {
        const key = citationKey(c.page, c.paragraph);
        if (!citationNumbers.has(key)) {
          citationNumbers.set(key, references.length + 1);
          references.push({ number: references.length + 1, page: c.page, paragraph: c.paragraph, verified: c.verified, snippet: c.snippet });
        }
      }
    }

    // Prose answer with inline [1][2] markers — "[!]" flags a claim the model
    // gave no citation for at all, rather than silently presenting it as sourced.
    const answerText =
      verifiedClaims.length === 0
        ? "The excerpt didn't support any citable claim for this question."
        : verifiedClaims
            .map((claim) => {
              const markers =
                claim.citations.length > 0
                  ? claim.citations.map((c) => `[${citationNumbers.get(citationKey(c.page, c.paragraph))}]`).join("")
                  : "[!]";
              return `${claim.text} ${markers}`;
            })
            .join(" ");

    const answerEmbed = new EmbedBuilder()
      .setTitle("💬 Answer")
      .setDescription(truncate(answerText, 4000))
      .setColor(context.usedSearch ? 0x38a169 : 0xdd6b20);

    // One numbered field per citation — green-ish page marker when the cited
    // paragraph checks out against what was actually retrieved, a warning marker
    // when it doesn't (a provable hallucination — see citation.ts).
    const referencesEmbed = new EmbedBuilder().setTitle("📚 Sources").setColor(0x4a5568);
    if (references.length === 0) {
      referencesEmbed.setDescription("No citations were given for this answer.");
    } else {
      for (const ref of references.slice(0, MAX_REFERENCES)) {
        referencesEmbed.addFields(
          ref.verified
            ? { name: `📖 [${ref.number}] Page ${ref.page}, ¶${ref.paragraph}`, value: truncate(ref.snippet!, 1024) }
            : {
                name: `⚠️ [${ref.number}] Page ${ref.page}, ¶${ref.paragraph}`,
                value: "This citation doesn't match any paragraph actually retrieved for this answer — treat it with caution.",
              },
        );
      }
      if (references.length > MAX_REFERENCES) {
        footerNotes.push(`Showing ${MAX_REFERENCES} of ${references.length} citations.`);
      }
    }
    if (anyUncitedClaims) {
      footerNotes.push("[!] marks a claim the model gave no citation for.");
    }
    if (footerNotes.length > 0) {
      referencesEmbed.setFooter({ text: footerNotes.join(" ") });
    }

    await interaction.editReply({ embeds: [metaEmbed, answerEmbed, referencesEmbed] });
  } catch (error) {
    console.error("Error in /ask:", error);
    await interaction.editReply(
      `Sorry, something went wrong answering that: ${error instanceof Error ? error.message : "please try again."}`,
    );
  }
}

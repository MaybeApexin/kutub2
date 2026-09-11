import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getBookByUri } from "../lib/db.ts";
import { fetchShamelaPage } from "../lib/shamela-reader.ts";
import { handleBookPickerAutocomplete, truncate } from "../lib/book-picker.ts";

const DISCORD_CHUNK_CHARS = 3000; // soft target — several page embeds share Discord's 6000-char-per-message cap
// Discord hard-caps a message at 10 embeds total; 1 is always the metadata embed,
// so at most 9 page embeds can ever fit. Capped lower than that (6) for margin —
// the char budget above is usually what stops a chunk first, but shamela.ws pages
// can be very short (a line or two), and without this a run of tiny pages could
// otherwise combine well past what a single Discord message can hold at all.
const MAX_PAGES_PER_CHUNK = 6;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // stop listening for button clicks after 10 min idle
const PAGE_DELAY_MS = 150;

const META_COLOR = 0xd69e2e; // amber — the book-info embed
const PAGE_COLORS = [0x2b6cb0, 0x6b46c1]; // blue / purple, alternating per page so adjacent pages are visually distinct

export const data = new SlashCommandBuilder()
  .setName("fetch")
  .setDescription("Open a classical Arabic text and page through its actual text")
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
    opt.setName("book").setDescription("The book to open — required").setAutocomplete(true),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("page")
      .setDescription("Open exactly this one page (can't be combined with pageStart/pageEnd)")
      .setMinValue(1),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("pagestart")
      .setDescription("Start browsing from this page (defaults to page 1)")
      .setMinValue(1),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("pageend")
      .setDescription("Don't browse past this page (defaults to the book's last page)")
      .setMinValue(1),
  );

export const autocomplete = handleBookPickerAutocomplete;

interface PageBlock {
  pageNumber: number;
  url: string;
  text: string;
}

interface Chunk {
  startPage: number;
  endPage: number;
  lastPageNumber: number;
  pages: PageBlock[];
}

/**
 * shamela.ws paginates far more finely than islamicbook.ws did — a single book can
 * run into the thousands of pages, each holding only a paragraph or two — so a
 * single page is rarely enough to fill a Discord embed on its own. These combine
 * consecutive shamela.ws pages, starting from `fromPage` (forward) or ending at
 * `toPage` (backward, for the Prev button, so it lands just before wherever the
 * current chunk starts), until roughly `maxChars` of text has been collected —
 * never crossing `scopeLimit` (the requested page / pageStart-pageEnd bound, or
 * Infinity/1 for an unscoped whole-book browse).
 */
export async function loadChunkForward(
  bookUri: string,
  fromPage: number,
  maxChars: number,
  scopeEnd = Infinity,
): Promise<Chunk> {
  let page = fromPage;
  const pages: PageBlock[] = [];
  let length = 0;
  let lastPageNumber = Infinity;

  while (page <= Math.min(lastPageNumber, scopeEnd)) {
    if (page > fromPage) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    const fetched = await fetchShamelaPage(bookUri, page);
    lastPageNumber = fetched.lastPageNumber;

    const text = fetched.paragraphs.join("\n\n");
    if (text) {
      pages.push({ pageNumber: page, url: fetched.url, text });
      length += text.length;
    }
    if (length >= maxChars || pages.length >= MAX_PAGES_PER_CHUNK) {
      return { startPage: fromPage, endPage: page, lastPageNumber, pages };
    }
    page++;
  }
  return {
    startPage: fromPage,
    endPage: Math.min(page - 1, lastPageNumber, scopeEnd),
    lastPageNumber,
    pages,
  };
}

export async function loadChunkBackward(
  bookUri: string,
  toPage: number,
  maxChars: number,
  scopeStart = 1,
): Promise<Chunk> {
  let page = toPage;
  const pages: PageBlock[] = [];
  let length = 0;
  let lastPageNumber = Infinity;

  while (page >= scopeStart) {
    if (page < toPage) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    const fetched = await fetchShamelaPage(bookUri, page);
    lastPageNumber = fetched.lastPageNumber;

    const text = fetched.paragraphs.join("\n\n");
    if (text) {
      pages.unshift({ pageNumber: page, url: fetched.url, text });
      length += text.length;
    }
    if (length >= maxChars || pages.length >= MAX_PAGES_PER_CHUNK) {
      return { startPage: page, endPage: toPage, lastPageNumber, pages };
    }
    page--;
  }
  return { startPage: Math.max(page + 1, scopeStart), endPage: toPage, lastPageNumber, pages };
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const bookUri = interaction.options.getString("book");

  if (!bookUri) {
    await interaction.reply({
      content:
        "Please choose a book — start typing in the `book` option and pick one from the suggestions " +
        "(optionally choose an `author` and/or `type` first to narrow the list).",
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

  const page = interaction.options.getInteger("page");
  const pageStartOpt = interaction.options.getInteger("pagestart");
  const pageEndOpt = interaction.options.getInteger("pageend");

  if (page !== null && (pageStartOpt !== null || pageEndOpt !== null)) {
    await interaction.reply({
      content: "Please use either `page` on its own, or `pagestart`/`pageend` — not both.",
      ephemeral: true,
    });
    return;
  }
  if (pageStartOpt !== null && pageEndOpt !== null && pageStartOpt > pageEndOpt) {
    await interaction.reply({
      content: "`pagestart` must be less than or equal to `pageend`.",
      ephemeral: true,
    });
    return;
  }

  const scopeStart = page ?? pageStartOpt ?? 1;
  const scopeEnd = page ?? pageEndOpt ?? Infinity;

  await interaction.deferReply();

  try {
    let chunk = await loadChunkForward(book.uri, scopeStart, DISCORD_CHUNK_CHARS, scopeEnd);

    const render = () => {
      const lastPageShown = Math.min(chunk.lastPageNumber, scopeEnd);
      const rangeLabel =
        scopeStart === 1 && scopeEnd === Infinity
          ? `Page ${chunk.startPage === chunk.endPage ? chunk.startPage : `${chunk.startPage}–${chunk.endPage}`} of ${chunk.lastPageNumber}`
          : `Page ${chunk.startPage === chunk.endPage ? chunk.startPage : `${chunk.startPage}–${chunk.endPage}`} (of requested range ${scopeStart}–${lastPageShown === Infinity ? chunk.lastPageNumber : lastPageShown})`;

      const metaEmbed = new EmbedBuilder()
        .setTitle(truncate(book.book_name, 256))
        .setURL(book.uri)
        .setColor(META_COLOR)
        .addFields(
          { name: "Type", value: truncate(book.book_type, 1024), inline: true },
          { name: "Range", value: rangeLabel, inline: true },
        );
      if (book.author_name) metaEmbed.setAuthor({ name: truncate(book.author_name, 256) });

      const pageEmbeds = chunk.pages.map(
        (p, i) =>
          new EmbedBuilder()
            .setTitle(`── Page ${p.pageNumber} ──`)
            .setURL(p.url)
            .setDescription(truncate(p.text, 4000))
            .setColor(PAGE_COLORS[i % PAGE_COLORS.length]!),
      );
      // A chunk can legitimately have zero pages (every page in range had no
      // extractable text) — an embed with no description would be invalid.
      if (pageEmbeds.length === 0) {
        pageEmbeds.push(new EmbedBuilder().setDescription("*(no extractable text on this page)*").setColor(PAGE_COLORS[0]!));
      }

      const atStart = chunk.startPage <= scopeStart;
      const atEnd = chunk.endPage >= lastPageShown;

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("fetch_prev")
          .setLabel("◀ Prev")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(atStart),
        new ButtonBuilder()
          .setCustomId("fetch_next")
          .setLabel("Next ▶")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(atEnd),
      );

      return { embeds: [metaEmbed, ...pageEmbeds], components: [row] };
    };

    const message = await interaction.editReply(render());
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      idle: IDLE_TIMEOUT_MS,
    });

    collector.on("collect", async (btn) => {
      if (btn.user.id !== interaction.user.id) {
        await btn.reply({
          content: "Only the person who ran this command can page through it.",
          ephemeral: true,
        });
        return;
      }

      const lastPageShown = Math.min(chunk.lastPageNumber, scopeEnd);
      if (btn.customId === "fetch_next" && chunk.endPage < lastPageShown) {
        chunk = await loadChunkForward(book.uri, chunk.endPage + 1, DISCORD_CHUNK_CHARS, scopeEnd);
      } else if (btn.customId === "fetch_prev" && chunk.startPage > scopeStart) {
        chunk = await loadChunkBackward(book.uri, chunk.startPage - 1, DISCORD_CHUNK_CHARS, scopeStart);
      }

      await btn.update(render());
    });

    collector.on("end", async () => {
      try {
        await interaction.editReply({ components: [] });
      } catch {
        // Original message may already be gone — nothing to clean up.
      }
    });
  } catch (error) {
    console.error("Error in /fetch:", error);
    await interaction.editReply(
      `Sorry, something went wrong opening that book: ${error instanceof Error ? error.message : "please try again."}`,
    );
  }
}

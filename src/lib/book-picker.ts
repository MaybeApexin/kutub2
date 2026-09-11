import type { AutocompleteInteraction } from "discord.js";
import { searchAuthors, searchBookTypes, searchBooks } from "./db.ts";

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Shared autocomplete handling for the "author" / "type" / "book" option trio used by
 * both /ask and /fetch: picking an author and/or type narrows the book suggestions,
 * since both are read from the interaction's already-filled-in option values.
 */
export async function handleBookPickerAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);

  if (focused.name === "author") {
    const authors = searchAuthors(focused.value, 25);
    await interaction.respond(authors.map((a) => ({ name: truncate(a.name, 100), value: a.key })));
    return;
  }

  if (focused.name === "type") {
    const types = searchBookTypes(focused.value, 25);
    await interaction.respond(types.map((t) => ({ name: truncate(t, 100), value: t })));
    return;
  }

  if (focused.name === "book") {
    const authorKey = interaction.options.getString("author") ?? undefined;
    const bookType = interaction.options.getString("type") ?? undefined;
    const books = searchBooks(focused.value, { authorKey, bookType }, 25);
    await interaction.respond(
      books.map((b) => ({
        name: truncate(`${b.book_name} — ${b.author_name}`, 100),
        value: b.uri,
      })),
    );
  }
}

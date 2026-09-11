/**
 * Normalizes an Arabic author name into a grouping key so that superficial spelling
 * variants (different hamza-on-alef forms, tatweel padding, "ابن" vs "بن") collapse
 * to the same author. This is a best-effort fix for scraped data, not a full authority
 * file: names that differ by real content (a fuller nasab in one listing than another,
 * e.g. "ابن القيم" vs "محمد بن أبي بكر بن قيم الجوزية") are legitimately different
 * strings and won't merge without a curated alias table.
 */
export function normalizeAuthorKey(raw: string): string {
  return raw
    .replace(/[ً-ٰٟ]/g, "") // strip Arabic diacritics (tashkeel)
    .replace(/ـ/g, "") // strip tatweel
    .replace(/[أإآ]/g, "ا") // unify hamza-on-alef forms (أ إ آ) to bare alef (ا)
    // "ابن" and "بن" are the same naming particle. JS's \b only recognizes ASCII word
    // characters, so it never matches inside Arabic text — use explicit whitespace
    // boundaries instead.
    .replace(/(^|\s)ابن(?=\s|$)/g, "$1بن")
    .replace(/\s+/g, " ")
    .trim();
}

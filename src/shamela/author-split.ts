/**
 * Shamela's category listings link exactly one author per book (a stable
 * https://shamela.ws/author/N id) — even for books that are genuinely co-authored,
 * such as تفسير الجلالين (authored jointly by al-Mahalli and al-Suyuti). The free-text
 * "المؤلف:" description line, however, does list every author when there's more than
 * one, joined by the conjunction "و" ("and") — e.g. "...المحلي (ت ٨٦٤هـ) وجلال الدين
 * ...السيوطي (ت ٩١١هـ)" or the simpler "ابن تيمية و ابن القيم".
 *
 * This splits that free-text line back into individual author-name segments so a
 * second (or third...) author can be captured even though only the first has a
 * shamela.ws author id. It's a text heuristic, not a real parser, and it was tuned
 * against real false positives found while testing against live category pages:
 *
 *   - "أبو محمد عبد الله بن وهب بن مسلم..." — "وهب" ("Wahb") is a name that itself
 *     starts with the letter و; it is not the "and" conjunction plus "هب".
 *   - "...الكرماني، ويعرف بتاج القراء..." — "و" here connects two facts about ONE
 *     author ("...al-Karmani, AND [he] is known as..."), not two different authors.
 *   - "...رحمه الله وتقبله في الشهداء..." — likewise, a pious phrase about one person.
 *
 * In every false positive, "و" was glued directly onto the next word with no space
 * (normal Arabic orthography for the attached conjunction) AND not preceded by a
 * closing paren. The one genuine case found (تفسير الجلالين) had "و" glued to the
 * next word too, but immediately after the closing paren of a death-date, e.g.
 * "(ت ٨٦٤هـ) وجلال ...". So this only splits on "و" when either:
 *   1. it directly follows a ")" (a name segment's death-date/attribution just
 *      closed), or
 *   2. it stands alone as its own word — a space on *both* sides, not glued to the
 *      next word — which is how a short bare-name list like "ابن تيمية و ابن القيم"
 *      is normally written.
 * Neither condition holds for any of the false positives above.
 */
/**
 * Segments that look like they're continuing a biographical note about the FIRST
 * author, rather than introducing a different one — found by manually auditing every
 * multi-segment result across all ~8,600 books. Each is a real example:
 *
 *   - "المشهور (أبو بكر) المصري الشافعي المراغي (ت ٨١٦هـ)" — restates the same
 *     person's other kunya/name ("known as (Abu Bakr)...").
 *   - "المتوفى بها سنة (١٠٥٢ هـ) رحمه اللَّه تعالى" — "[who] died there in ... —
 *     may God have mercy on him", not a name.
 *   - "لا تصح نسبته ... " — "its attribution to him isn't correct" (a doubt note).
 *   - "غيره من كتاب المجلة" — "and others among the magazine's writers" (vague, no name).
 *   - "بـ (كاتب جلبي) ..." — "as (Katib Chelebi)", an alias for the SAME person.
 *
 * "ولده تاج ... السبكي (ت ٧٧١ هـ)" ("his son Taj ... al-Subki") is deliberately NOT
 * on this list — a father/son continuation like that is a genuine second author.
 */
const NOT_AN_AUTHOR_NAME = [
  /^لا\s+تصح/, // "[attribution] isn't correct..."
  /^غيره/, // "others than him..."
  /^المتوفى/, // "[who] died..." — restates death info about the first author
  /^المشهور\s*\(/, // "known as (...)" — an alias insert, not a new person
  /^بـ?\s*\(/, // "as (...)" — likewise an alias insert
  /^رحمه/, // "may God have mercy on him..." — a pious continuation
  /^تعالى/,
];

function looksLikeAuthorName(segment: string): boolean {
  return !NOT_AN_AUTHOR_NAME.some((pattern) => pattern.test(segment));
}

export function splitAuthorNames(raw: string): string[] {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const parts = cleaned
    .split(/(?<=\))\s*و(?=\s*[ء-ي])|(?<=\s)و(?=\s[ء-ي])/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) return [cleaned];

  // The first segment is always kept — it's presumed to be the same person as
  // shamela's own linked author, just possibly a differently-complete text form.
  // Only later segments are checked for whether they plausibly name a different
  // person at all, versus continuing to describe the first one.
  return [parts[0]!, ...parts.slice(1).filter(looksLikeAuthorName)];
}

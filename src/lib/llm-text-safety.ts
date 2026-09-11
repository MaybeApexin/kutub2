/**
 * Defends against a token-repetition failure mode seen in testing (with Groq's
 * openai/gpt-oss-120b): the model quoting a short phrase and then spiraling into
 * the same character (or very short pattern) repeated hundreds of times until it
 * hit the token limit, instead of stopping. If a long run like that is found,
 * everything from where it starts is dropped — legitimate text doesn't repeat an
 * identical 1-5 character sequence back-to-back 8+ times. Shared across LLM
 * backends (groq.ts, gemini.ts) since it's a generic output-safety net, not
 * specific to one provider.
 */
export function stripDegenerateRepetition(text: string): string {
  const match = text.match(/(.{1,5}?)\1{7,}/su);
  if (!match || match.index === undefined) return text;
  return text.slice(0, match.index).trimEnd();
}

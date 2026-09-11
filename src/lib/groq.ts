import { stripDegenerateRepetition } from "./llm-text-safety.ts";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

interface GroqChatResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
  error?: { message?: string };
}

/** Sends a single system+user turn to Groq's OpenAI-compatible chat completions API. */
export async function askGroq(
  systemPrompt: string,
  userPrompt: string,
  options: {
    maxTokens?: number;
    temperature?: number;
    /** GROQ_MODEL (openai/gpt-oss-120b) is a reasoning model that spends tokens on
     *  invisible "thinking" before its visible answer — at the default effort it can
     *  burn through maxTokens entirely on reasoning and return no content at all
     *  (seen in testing: 150 maxTokens, ~148 spent reasoning, empty response).
     *  Defaulting to "low" keeps that overhead small and reliable, especially given
     *  Groq's per-minute token budget (see book-retrieval.ts, ask.ts). */
    reasoningEffort?: "low" | "medium" | "high";
  } = {},
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY in environment (.env)");
  }

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 600,
      reasoning_effort: options.reasoningEffort ?? "low",
      // Mitigates a real failure seen in testing: the model quoting a short Arabic
      // phrase, then spiraling into hundreds of repeated quote-mark characters until
      // it hit max_tokens. A frequency penalty makes that kind of token-repetition
      // loop less likely in the first place; stripDegenerateRepetition (below) is
      // the backstop if it happens anyway.
      frequency_penalty: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const data = (await res.json().catch(() => null)) as GroqChatResponse | null;

  if (!res.ok) {
    const message = data?.error?.message ?? `${res.status} ${res.statusText}`;
    throw new Error(`Groq API request failed: ${message}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens;
    const finishReason = data?.choices?.[0]?.finish_reason;
    throw new Error(
      `Groq API returned an empty response (finish_reason=${finishReason ?? "unknown"}` +
        (reasoningTokens
          ? `, spent ${reasoningTokens} tokens on internal reasoning before hitting the token limit`
          : "") +
        `) — try a higher maxTokens or a lower reasoningEffort.`,
    );
  }
  return stripDegenerateRepetition(content);
}

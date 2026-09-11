import { stripDegenerateRepetition } from "./llm-text-safety.ts";

/**
 * Ordered fallback chain: tried in order, moving to the next model only when the
 * current one is rate-limited (HTTP 429) — Gemini's free-tier quotas are scoped
 * per model, not shared across an API key's whole model lineup, so a different
 * model genuinely has separate headroom rather than hitting the same wall
 * immediately. Every entry here was verified individually against this account's
 * key before being added — a plausible-looking model name is not the same as one
 * that actually works (gemini-2.5-flash, for example, 404s as "no longer
 * available to new users" despite being a real, documented model id).
 */
const GEMINI_MODELS = (process.env.GEMINI_MODELS ?? "gemini-3.6-flash,gemini-3.5-flash,gemini-3.7-flash")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

class GeminiRateLimitError extends Error {}

async function callGenerateContent(
  model: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ res: Response; data: GeminiResponse | null }> {
  const res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as GeminiResponse | null;
  return { res, data };
}

/**
 * Calls one specific model, with a defensive retry baked in: not every Gemini
 * model accepts the same thinkingConfig shape — gemini-3.7-flash, unlike 3.5/3.6,
 * flatly rejects thinkingLevel "minimal" with a 400 (verified in testing) — so on
 * that specific error this retries once without thinkingConfig at all, rather than
 * treating a config mismatch as a hard failure or (worse) burning a fallback slot
 * meant for actual rate-limit relief on it.
 */
async function callModel(
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  options: { maxTokens: number; temperature: number; thinkingLevel: string },
): Promise<string> {
  const baseBody = {
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
  };

  let { res, data } = await callGenerateContent(model, apiKey, {
    ...baseBody,
    generationConfig: {
      temperature: options.temperature,
      maxOutputTokens: options.maxTokens,
      thinkingConfig: { thinkingLevel: options.thinkingLevel },
    },
  });

  if (!res.ok && res.status === 400 && /thinking level/i.test(data?.error?.message ?? "")) {
    ({ res, data } = await callGenerateContent(model, apiKey, {
      ...baseBody,
      generationConfig: {
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
      },
    }));
  }

  if (res.status === 429) {
    throw new GeminiRateLimitError(`${model} is rate-limited: ${data?.error?.message ?? "429"}`);
  }
  if (!res.ok) {
    throw new Error(
      `Gemini API request to ${model} failed: ${data?.error?.message ?? `${res.status} ${res.statusText}`}`,
    );
  }
  if (data?.promptFeedback?.blockReason) {
    throw new Error(
      `Gemini (${model}) blocked the request before generating a response: ${data.promptFeedback.blockReason}`,
    );
  }

  const candidate = data?.candidates?.[0];
  const content = candidate?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!content) {
    const thoughtsTokens = data?.usageMetadata?.thoughtsTokenCount;
    throw new Error(
      `Gemini (${model}) returned an empty response (finishReason=${candidate?.finishReason ?? "unknown"}` +
        (thoughtsTokens
          ? `, spent ${thoughtsTokens} tokens on internal reasoning before hitting the token limit`
          : "") +
        `) — try a higher maxTokens or a lower thinkingLevel.`,
    );
  }
  return stripDegenerateRepetition(content);
}

/**
 * Sends a single system+user turn to Google's Gemini API, trying each model in
 * GEMINI_MODELS (in order) and falling back to the next one only when the current
 * model is rate-limited. A non-rate-limit error (bad request, safety block, ...)
 * is surfaced immediately instead of silently retried across every model — that
 * kind of failure would just repeat.
 */
export async function askGemini(
  systemPrompt: string,
  userPrompt: string,
  options: {
    maxTokens?: number;
    temperature?: number;
    /**
     * gemini-3.5-flash / gemini-3.6-flash "think" before answering, and — like
     * Groq's reasoning model before them — that can silently consume the whole
     * token budget and return empty content (seen in testing: maxOutputTokens 20,
     * 16 spent on invisible thinking, empty response). `thinkingBudget: 0` is
     * REJECTED (400) on these models; `thinkingLevel` is the field that works.
     * Verified empirically: "minimal" costs zero thinking tokens — best for a
     * cheap, simple task (search-term extraction). "low"/"medium"/"high" add real
     * overhead in exchange for better reasoning — worth it for harder synthesis.
     * Not every model in the fallback chain supports every level (see callModel).
     */
    thinkingLevel?: "minimal" | "low" | "medium" | "high";
  } = {},
): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY in environment (.env)");
  }
  if (GEMINI_MODELS.length === 0) {
    throw new Error("No Gemini models configured (GEMINI_MODELS is empty)");
  }

  const resolved = {
    maxTokens: options.maxTokens ?? 1000,
    temperature: options.temperature ?? 0.3,
    thinkingLevel: options.thinkingLevel ?? "low",
  };

  let lastError: unknown;
  for (const [i, model] of GEMINI_MODELS.entries()) {
    try {
      return await callModel(model, apiKey, systemPrompt, userPrompt, resolved);
    } catch (err) {
      lastError = err;
      const isLast = i === GEMINI_MODELS.length - 1;
      if (err instanceof GeminiRateLimitError && !isLast) {
        console.warn(`[gemini] ${err.message} — falling back to ${GEMINI_MODELS[i + 1]}`);
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All Gemini models failed");
}

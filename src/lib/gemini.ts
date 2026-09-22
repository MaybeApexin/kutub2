import { stripDegenerateRepetition } from "./llm-text-safety.ts";

/**
 * Ordered fallback chain: tried in order, moving to the next model when the
 * current one is temporarily unavailable — rate-limited (HTTP 429) or overloaded
 * (HTTP 503, Gemini's "currently experiencing high demand" error) — since
 * Gemini's free-tier quotas and load are scoped per model, not shared across an
 * API key's whole model lineup, so a different model genuinely has separate
 * headroom rather than hitting the same wall immediately. Every entry here was
 * verified individually against this account's key before being added — a
 * plausible-looking model name is not the same as one that actually works
 * (gemini-2.5-flash, for example, 404s as "no longer available to new users"
 * despite being a real, documented model id).
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

/** Thrown for a transient, model-specific failure (rate limit or "high demand"
 *  overload) — the caller falls back to the next model in the chain rather than
 *  giving up. */
class GeminiRetryableError extends Error {}

/** Thrown when every model in the fallback chain, across every retry sweep, was
 *  still temporarily unavailable. Its message is user-facing and deliberately
 *  generic — callers can surface it directly without leaking provider-specific
 *  detail (model names, HTTP codes, "high demand" wording). */
class GeminiUnavailableError extends Error {}

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
  options: {
    maxTokens: number;
    temperature: number;
    thinkingLevel: string;
    /** When set, constrains Gemini's output to valid JSON matching this schema
     *  (Gemini's own OpenAPI-subset schema format) instead of free-form text. */
    responseSchema?: Record<string, unknown>;
  },
): Promise<string> {
  const baseBody = {
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
  };
  const jsonConfig = options.responseSchema
    ? { responseMimeType: "application/json", responseSchema: options.responseSchema }
    : {};

  let { res, data } = await callGenerateContent(model, apiKey, {
    ...baseBody,
    generationConfig: {
      temperature: options.temperature,
      maxOutputTokens: options.maxTokens,
      thinkingConfig: { thinkingLevel: options.thinkingLevel },
      ...jsonConfig,
    },
  });

  if (!res.ok && res.status === 400 && /thinking level/i.test(data?.error?.message ?? "")) {
    ({ res, data } = await callGenerateContent(model, apiKey, {
      ...baseBody,
      generationConfig: {
        temperature: options.temperature,
        maxOutputTokens: options.maxTokens,
        ...jsonConfig,
      },
    }));
  }

  // 429 (RESOURCE_EXHAUSTED) is a rate limit; 503 (UNAVAILABLE) is Gemini's
  // "currently experiencing high demand" overload error. Both are transient and
  // specific to this model, so both fall back to the next model in the chain
  // rather than failing the whole request.
  if (res.status === 429 || res.status === 503) {
    throw new GeminiRetryableError(
      `${model} is temporarily unavailable (${res.status}): ${data?.error?.message ?? res.statusText}`,
    );
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
  return content;
}

/**
 * Tries each model in GEMINI_MODELS (in order) against `attempt`, falling back to
 * the next one only when the current model is transiently unavailable
 * (GeminiRetryableError — rate limit or "high demand" overload). A non-retryable
 * error (bad request, safety block, ...) is surfaced immediately instead of
 * silently retried across every model — that kind of failure would just repeat.
 *
 * If every model in the chain is still unavailable after a full sweep, pauses and
 * sweeps the whole chain again — a "high demand" overload is typically brief (per
 * Gemini's own error message), so a second sweep shortly after often lands on a
 * model that's recovered — before giving up with a clean, generic error.
 */
async function withModelFallback<T>(
  attempt: (model: string) => Promise<T>,
  onRetrying: (() => void) | undefined,
): Promise<T> {
  if (GEMINI_MODELS.length === 0) {
    throw new Error("No Gemini models configured (GEMINI_MODELS is empty)");
  }

  const SWEEP_COUNT = 2;
  const SWEEP_BACKOFF_MS = 1500;

  let notifiedRetrying = false;
  const notifyRetrying = () => {
    if (notifiedRetrying) return;
    notifiedRetrying = true;
    onRetrying?.();
  };

  for (let sweep = 0; sweep < SWEEP_COUNT; sweep++) {
    for (const [i, model] of GEMINI_MODELS.entries()) {
      try {
        return await attempt(model);
      } catch (err) {
        if (!(err instanceof GeminiRetryableError)) throw err;
        notifyRetrying();
        const isLastModelInSweep = i === GEMINI_MODELS.length - 1;
        if (!isLastModelInSweep) {
          console.warn(`[gemini] ${err.message} — falling back to ${GEMINI_MODELS[i + 1]}`);
        }
      }
    }
    const isLastSweep = sweep === SWEEP_COUNT - 1;
    if (!isLastSweep) {
      console.warn(`[gemini] every model is temporarily unavailable — retrying the chain in ${SWEEP_BACKOFF_MS}ms`);
      await new Promise((r) => setTimeout(r, SWEEP_BACKOFF_MS));
    }
  }

  throw new GeminiUnavailableError("The answering service is unusually busy right now — please try again shortly.");
}

interface AskGeminiOptions {
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
  /**
   * Called at most once per call — the first time a transient error (rate limit
   * or "high demand" overload) forces a fallback to another model or a retry
   * sweep. Lets a caller with a deferred Discord reply surface a lightweight
   * "still working" status without leaking provider-specific detail, and without
   * spamming an edit on every retry. Not called at all in the common case where
   * the first model just answers.
   */
  onRetrying?: () => void;
}

function resolveOptions(options: AskGeminiOptions) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY in environment (.env)");
  }
  return {
    apiKey,
    maxTokens: options.maxTokens ?? 1000,
    temperature: options.temperature ?? 0.3,
    thinkingLevel: options.thinkingLevel ?? "low",
  };
}

/**
 * Sends a single system+user turn to Google's Gemini API and returns its free-text
 * reply, with model fallback (see withModelFallback) on transient failures.
 */
export async function askGemini(systemPrompt: string, userPrompt: string, options: AskGeminiOptions = {}): Promise<string> {
  const resolved = resolveOptions(options);
  const content = await withModelFallback(
    (model) => callModel(model, resolved.apiKey, systemPrompt, userPrompt, resolved),
    options.onRetrying,
  );
  return stripDegenerateRepetition(content);
}

/**
 * Sends a single system+user turn to Google's Gemini API, constraining the reply
 * to valid JSON matching `responseSchema` (Gemini's own schema-constrained
 * decoding — not just a prompted suggestion, so malformed output is rare) and
 * parsing it as `T`. Same model fallback behavior as askGemini.
 */
export async function askGeminiJSON<T>(
  systemPrompt: string,
  userPrompt: string,
  options: AskGeminiOptions & { responseSchema: Record<string, unknown> },
): Promise<T> {
  const resolved = resolveOptions(options);
  const content = await withModelFallback(
    (model) =>
      callModel(model, resolved.apiKey, systemPrompt, userPrompt, {
        ...resolved,
        responseSchema: options.responseSchema,
      }),
    options.onRetrying,
  );
  try {
    return JSON.parse(content) as T;
  } catch (err) {
    throw new Error(
      `Gemini returned malformed JSON despite a response schema: ${err instanceof Error ? err.message : err}`,
    );
  }
}

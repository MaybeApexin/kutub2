import type { RetrievedContext } from "./book-retrieval.ts";

/** Gemini's own OpenAPI-schema-subset format for constrained JSON decoding — this
 *  is enforced at generation time (the model literally can't sample tokens outside
 *  it), not just a prompted suggestion, which is what makes citations here
 *  structurally reliable rather than a free-text convention the model can drop. */
export const CITATION_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          citations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                page: { type: "integer" },
                paragraph: { type: "integer" },
              },
              required: ["page", "paragraph"],
            },
          },
        },
        required: ["text", "citations"],
      },
    },
    // True when the model could not fully ground the answer in the excerpt —
    // surfaced to the user as a caveat rather than silently dropped.
    uncertain: { type: "boolean" },
  },
  required: ["claims", "uncertain"],
} as const;

export interface CitationRef {
  page: number;
  paragraph: number;
}

export interface Claim {
  text: string;
  citations: CitationRef[];
}

export interface AnswerWithCitations {
  claims: Claim[];
  uncertain: boolean;
}

export interface VerifiedCitation extends CitationRef {
  /** True if this {page, paragraph} was actually among the paragraphs fed to the
   *  model — a citation pointing anywhere else is provably hallucinated, since the
   *  model never saw that location. This does NOT confirm the cited paragraph
   *  semantically supports the claim, only that it's real retrieved text. */
  verified: boolean;
  /** The cited paragraph's own text, when verified. */
  snippet?: string;
}

export interface VerifiedClaim {
  text: string;
  citations: VerifiedCitation[];
}

/**
 * Checks each claim's citations against the paragraphs actually retrieved and
 * shown to the model. A citation naming a {page, paragraph} outside that set
 * could not have been grounded in anything the model read — it's flagged rather
 * than trusted. This is a structural check only (does the cited location exist),
 * not a semantic one (does it actually support the claim).
 */
export function verifyCitations(answer: AnswerWithCitations, context: RetrievedContext): VerifiedClaim[] {
  const known = new Map<string, string>();
  for (const p of context.paragraphs) {
    known.set(`${p.page}:${p.paragraph}`, p.text);
  }

  return answer.claims.map((claim) => ({
    text: claim.text,
    citations: claim.citations.map((c) => {
      const snippet = known.get(`${c.page}:${c.paragraph}`);
      return snippet !== undefined
        ? { page: c.page, paragraph: c.paragraph, verified: true, snippet }
        : { page: c.page, paragraph: c.paragraph, verified: false };
    }),
  }));
}

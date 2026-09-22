import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { fetchShamelaPage, type ShamelaPage, type ParagraphKind } from "./shamela-reader.ts";
import { cached, type CacheStore } from "../api/http-utils.ts";

// Amiri: OFL-licensed, modeled on the Bulaq Press Naskh type used in real early
// printed classical Arabic books — see assets/fonts/Amiri-OFL.txt. @napi-rs/canvas
// (Skia-backed) shapes Arabic correctly out of the box (verified empirically:
// proper letter joining/ligatures with plain fillText + direction "rtl"), unlike
// most lightweight canvas libraries, so no separate text-shaping engine is needed.
const FONT_FAMILY = "Amiri";
GlobalFonts.registerFromPath(`${import.meta.dir}/../../assets/fonts/Amiri-Regular.ttf`, FONT_FAMILY);

const CACHE_TTL_MS = 10 * 60 * 1000;
const pageCache: CacheStore = new Map();
const imageCache: CacheStore = new Map();

async function getFullPage(bookUri: string, pageNumber: number): Promise<ShamelaPage> {
  return cached(pageCache, CACHE_TTL_MS, `${bookUri}::${pageNumber}`, () => fetchShamelaPage(bookUri, pageNumber));
}

export interface PageHighlight {
  /** 1-indexed, matching ShamelaPage.paragraphs position + 1 — same convention as
   *  RetrievedParagraph.paragraph in book-retrieval.ts. */
  paragraph: number;
  /** Hex highlight color, also used for this citation's badge at the top. */
  color: string;
  citationNumber: number;
}

const WIDTH = 1000;
const MARGIN_X = 70;
const MARGIN_TOP = 110; // room for the citation-badge row
const MARGIN_BOTTOM = 80; // room for the page-number footer
const BODY_FONT_SIZE = 28;
const FOOTNOTE_FONT_SIZE = 20; // matches the real site: hashiyah renders visibly smaller
const LINE_HEIGHT_RATIO = 1.7;
const PARAGRAPH_GAP = 16;
const BACKGROUND = "#faf6ec";
// "body" (the faqarat — the actual paragraph/verse text) is dark red; "title"
// (a paragraph that's entirely a bracketed editorial annotation, e.g.
// "[قافية التاء]") and "footnote" (hamesh) both render in the same gray — see
// ParagraphKind's docs in shamela-reader.ts for how these are detected.
const BODY_COLOR = "#7a1420";
const MUTED_COLOR = "#6b6b6b";
const CONTENT_WIDTH = WIDTH - MARGIN_X * 2;

function fontSizeForKind(kind: ParagraphKind): number {
  return kind === "footnote" ? FOOTNOTE_FONT_SIZE : BODY_FONT_SIZE;
}

function colorForKind(kind: ParagraphKind): string {
  return kind === "body" ? BODY_COLOR : MUTED_COLOR;
}

interface LaidOutLine {
  text: string;
  y: number;
  highlightColor: string | null;
  kind: ParagraphKind;
  fontSize: number;
  lineHeight: number;
}

function wrapParagraph(measure: (s: string) => number, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && measure(test) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function layOutPage(
  ctx: SKRSContext2D,
  paragraphs: string[],
  kinds: ParagraphKind[],
  highlightByParagraph: Map<number, PageHighlight>,
) {
  const lines: LaidOutLine[] = [];
  let y = MARGIN_TOP;
  for (const [i, text] of paragraphs.entries()) {
    const kind = kinds[i] ?? "body";
    const fontSize = fontSizeForKind(kind);
    const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
    ctx.font = `${fontSize}px "${FONT_FAMILY}"`;
    const measure = (s: string) => ctx.measureText(s).width;

    const highlight = highlightByParagraph.get(i + 1) ?? null;
    for (const lineText of wrapParagraph(measure, text, CONTENT_WIDTH)) {
      lines.push({ text: lineText, y, highlightColor: highlight?.color ?? null, kind, fontSize, lineHeight });
      y += lineHeight;
    }
    y += PARAGRAPH_GAP;
  }
  return { lines, contentBottom: y + MARGIN_BOTTOM };
}

/**
 * Draws one page's worth of already-fetched paragraphs as a standalone image —
 * the full page's text laid out right-to-left in Amiri, with any highlighted
 * paragraph(s) colored and given a matching [N] badge at the top. Pure and
 * synchronous: no network fetch, no cache — callers that already have the page's
 * paragraphs in hand (like /fetch, which fetches them anyway for the text embeds)
 * can call this directly instead of paying for a second fetch of the same page.
 *
 * "Reader page N" is deliberately the label at the bottom, not just "N" or
 * anything styled to look like a scan — shamela.ws's page numbers are its own
 * reader's sequential pagination, not the printed book's real page number (see
 * fetchShamelaPage's docs), and this is a generated image, not an actual scan.
 * Mislabeling either would overstate how authoritative this image is.
 *
 * `kinds`, when given (same length/order as `paragraphs`), colors the faqarat
 * dark red and titles/hashiyah gray (hashiyah also renders smaller), matching
 * shamela.ws's own convention — see ParagraphKind in shamela-reader.ts. Omitted
 * entirely, every paragraph is treated as "body" (plain dark red), which is
 * exactly what most ordinary prose pages are anyway.
 */
export function drawPageImage(
  paragraphs: string[],
  pageNumber: number,
  highlights: PageHighlight[] = [],
  kinds: ParagraphKind[] = [],
): Buffer {
  const highlightByParagraph = new Map(highlights.map((h) => [h.paragraph, h]));

  // Measuring pass on a throwaway canvas, purely to get correct text metrics
  // (which depend on the registered font) before the real canvas — sized to fit
  // however much text this specific page turns out to have — is created.
  const { lines, contentBottom } = layOutPage(createCanvas(10, 10).getContext("2d"), paragraphs, kinds, highlightByParagraph);

  const canvas = createCanvas(WIDTH, contentBottom);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Citation badges at top, one per highlight on this page, each colored to match
  // its highlight below. No highlights (the plain /fetch case) means no badges.
  const badgeFontSize = 26;
  const badgeHeight = badgeFontSize + 20;
  ctx.font = `bold ${badgeFontSize}px "${FONT_FAMILY}"`;
  ctx.direction = "ltr";
  ctx.textAlign = "left";
  let badgeX = MARGIN_X;
  for (const h of highlights.slice().sort((a, b) => a.citationNumber - b.citationNumber)) {
    const label = `[${h.citationNumber}]`;
    const labelWidth = ctx.measureText(label).width;
    const chipWidth = labelWidth + 24;
    ctx.fillStyle = h.color;
    ctx.fillRect(badgeX, 40, chipWidth, badgeHeight);
    ctx.fillStyle = "#1a1a1a";
    ctx.fillText(label, badgeX + 12, 40 + badgeFontSize + 2);
    badgeX += chipWidth + 12;
  }

  // Body text: highlight rectangle first (so it sits behind the glyphs like a
  // real highlighter stroke), then the line's text on top, sized and colored by
  // its paragraph's kind (faqarat dark red at full size; titles/hashiyah gray,
  // hashiyah also smaller).
  ctx.direction = "rtl";
  ctx.textAlign = "right";
  for (const line of lines) {
    ctx.font = `${line.fontSize}px "${FONT_FAMILY}"`;
    if (line.highlightColor) {
      const w = ctx.measureText(line.text).width;
      ctx.fillStyle = line.highlightColor;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(WIDTH - MARGIN_X - w - 6, line.y - line.fontSize, w + 12, line.lineHeight);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = colorForKind(line.kind);
    ctx.fillText(line.text, WIDTH - MARGIN_X, line.y);
  }

  // Footer — see the "Reader page N" note in this function's docs above.
  ctx.font = "20px Arial";
  ctx.fillStyle = "#888888";
  ctx.direction = "ltr";
  ctx.textAlign = "center";
  ctx.fillText(`Reader page ${pageNumber}`, WIDTH / 2, contentBottom - 30);

  const buf = canvas.toBuffer("image/png");
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as Uint8Array);
}

/**
 * Fetch-and-cache wrapper around drawPageImage, for callers (like /ask) that
 * don't already have the page's paragraphs in hand. Caches both the underlying
 * page fetch and the rendered image, keyed by book+page+highlight set.
 */
export async function renderPageImage(bookUri: string, pageNumber: number, highlights: PageHighlight[]): Promise<Buffer> {
  const highlightKey = highlights
    .slice()
    .sort((a, b) => a.paragraph - b.paragraph)
    .map((h) => `${h.paragraph}:${h.color}:${h.citationNumber}`)
    .join(",");
  const cacheKey = `${bookUri}::${pageNumber}::${highlightKey}`;

  const buf = await cached(imageCache, CACHE_TTL_MS, cacheKey, async () => {
    const page = await getFullPage(bookUri, pageNumber);
    return drawPageImage(page.paragraphs, pageNumber, highlights, page.paragraphKinds);
  });

  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as Uint8Array);
}

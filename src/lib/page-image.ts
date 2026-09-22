import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { fetchShamelaPage, type ShamelaPage } from "./shamela-reader.ts";
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
const LINE_HEIGHT = Math.round(BODY_FONT_SIZE * 1.7);
const PARAGRAPH_GAP = 16;
const BACKGROUND = "#faf6ec";
const TEXT_COLOR = "#20201c";
const CONTENT_WIDTH = WIDTH - MARGIN_X * 2;

interface LaidOutLine {
  text: string;
  y: number;
  highlightColor: string | null;
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

function layOutPage(ctx: SKRSContext2D, paragraphs: string[], highlightByParagraph: Map<number, PageHighlight>) {
  ctx.font = `${BODY_FONT_SIZE}px "${FONT_FAMILY}"`;
  const measure = (s: string) => ctx.measureText(s).width;

  const lines: LaidOutLine[] = [];
  let y = MARGIN_TOP;
  for (const [i, text] of paragraphs.entries()) {
    const highlight = highlightByParagraph.get(i + 1) ?? null;
    for (const lineText of wrapParagraph(measure, text, CONTENT_WIDTH)) {
      lines.push({ text: lineText, y, highlightColor: highlight?.color ?? null });
      y += LINE_HEIGHT;
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
 */
export function drawPageImage(paragraphs: string[], pageNumber: number, highlights: PageHighlight[] = []): Buffer {
  const highlightByParagraph = new Map(highlights.map((h) => [h.paragraph, h]));

  // Measuring pass on a throwaway canvas, purely to get correct text metrics
  // (which depend on the registered font) before the real canvas — sized to fit
  // however much text this specific page turns out to have — is created.
  const { lines, contentBottom } = layOutPage(createCanvas(10, 10).getContext("2d"), paragraphs, highlightByParagraph);

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
  // real highlighter stroke), then the line's text on top.
  ctx.font = `${BODY_FONT_SIZE}px "${FONT_FAMILY}"`;
  ctx.direction = "rtl";
  ctx.textAlign = "right";
  for (const line of lines) {
    if (line.highlightColor) {
      const w = ctx.measureText(line.text).width;
      ctx.fillStyle = line.highlightColor;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(WIDTH - MARGIN_X - w - 6, line.y - BODY_FONT_SIZE, w + 12, LINE_HEIGHT);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = TEXT_COLOR;
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
    return drawPageImage(page.paragraphs, pageNumber, highlights);
  });

  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as Uint8Array);
}

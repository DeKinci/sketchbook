/**
 * Pure text metrics + wrapping for text shapes — the model's single source of
 * truth for where lines break and how big a text block is. Everything downstream
 * (canvas render, bbox/hit/attach, SVG export, the edit overlay's box) derives
 * from the SAME wrap, so they can never disagree.
 *
 * Width is PIXEL-EXACT by measuring the actual board face with the browser's
 * canvas `measureText` wherever a canvas exists (every real board render) — the
 * same engine Konva paints with, so the model's line widths and wrap points
 * match the rendered glyphs to the pixel, KERNING and every embedded glyph
 * (Latin-1 accents, typographic punctuation, €, …) included. A per-glyph
 * summation can't: it misses kerning and needs a table entry per glyph, so any
 * character outside the baked ASCII/Cyrillic tables (é, ñ, Ö, æ, —, …) fell back
 * to a 0.6em guess and produced boxes too short to hold their own text.
 *
 * The baked advance tables below stay the Node/SSR fallback (no canvas there):
 * ASCII from the canonical Arial/Helvetica table, Cyrillic measured from the
 * embedded Arimo subset (Arimo is Arial-metric-compatible), both exact for the
 * glyphs they cover; the 0.6em fallback only bites glyphs the FONT can't render
 * either (CJK/emoji → platform fallback, inherently approximate).
 */
import { BOARD_FONT_FAMILY, BOARD_FONT_STACK } from "./boardFontStack.ts";

/** Arial/Helvetica advance widths for ASCII 32..126, in 1/1000 em. */
// prettier-ignore
const ARIAL_W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // sp ! " # $ % & ' ( ) * + , - . /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9 : ; < = > ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z [ \ ] ^ _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,      // p-z { | } ~
];
/** Arimo advance widths for Cyrillic U+0400-045F, in 1/1000 em — measured off
 *  the embedded face itself (canvas measureText at 1000px), so these ARE the
 *  advances both the Konva canvas and the textarea lay glyphs with. */
// prettier-ignore
const CYR_W = [
  667, 667, 865, 542, 719, 667, 278, 278, 500, 1057, 1010, 854, 583, 719, 635, 719, // Ѐ-Џ
  667, 656, 667, 542, 677, 667, 923, 604, 719, 719, 583, 656, 833, 722, 778, 719,   // А-П
  667, 722, 611, 635, 760, 667, 740, 667, 917, 938, 792, 885, 656, 719, 1010, 722,  // Р-Я
  556, 573, 531, 365, 583, 556, 669, 458, 559, 559, 438, 583, 688, 552, 556, 542,   // а-п
  556, 500, 458, 500, 823, 500, 573, 521, 802, 823, 625, 719, 521, 510, 750, 542,   // р-я
  556, 556, 556, 365, 510, 500, 222, 278, 222, 906, 813, 556, 438, 559, 500, 552,   // ѐ-џ
];
/** The embedded cyrillic subset's stragglers outside the contiguous block. */
const EXTRA_W = new Map<number, number>([
  [0x490, 489], [0x491, 411], // Ґґ
  [0x4b0, 556], [0x4b1, 500], // Ұұ
  [0x2116, 1073], // №
  [0x301, 0], // combining acute
]);
const FALLBACK_W = 600;

/** Konva Text's default lineHeight (1 em per line); the edit textarea matches
 *  with `leading-none`. The block height is simply lines × fontSize. */
export const TEXT_LINE_H = 1;

// ── Canvas measurer (the browser IS the rendered width) ──────────────────────
// Measured at the ACTUAL fontSize — canvas advances are NOT perfectly linear
// across sizes (measuring at 1000px and scaling drifts ~1% from the real size,
// enough to overflow a box), so we set the true px size and read the width off
// it, exactly as Konva paints. The ctx is created lazily and ONLY once the
// embedded face is actually loaded (document.fonts.check), so it can never bind
// — and then cache — the platform fallback taken before the font settled (the
// long-lived-context staleness boardFont.ts warns about). Absent in Node/SSR
// and before the font loads → null, and the baked tables carry the layout.
let measureCtx: CanvasRenderingContext2D | null = null;
let measureFont = ""; // the font string currently set on measureCtx
function boardMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === "undefined" || !document.fonts?.check) return null;
  // check() throws on a malformed font string and can be false until load —
  // both mean "not ready", fall back to the tables for now (retried next call).
  let ready = false;
  try {
    ready = document.fonts.check(`1000px ${BOARD_FONT_FAMILY}`);
  } catch {
    ready = false;
  }
  if (!ready) return null;
  measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/** Rendered width of a single line (no newlines) at `fontSize`. Canvas-measured
 *  against the real board face at that exact size where possible (kerning +
 *  every embedded glyph exact); the per-glyph advance tables are the Node/
 *  pre-load fallback. */
export function lineWidth(line: string, fontSize: number): number {
  if (line === "") return 0;
  const ctx = boardMeasureCtx();
  if (ctx) {
    const f = `${fontSize}px ${BOARD_FONT_STACK}`;
    if (f !== measureFont) {
      ctx.font = f; // bound AFTER the face loaded → resolves the real face
      measureFont = f;
    }
    return ctx.measureText(line).width;
  }
  let w = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0)!;
    w +=
      code >= 32 && code <= 126 ? ARIAL_W[code - 32]
      : code >= 0x400 && code <= 0x45f ? CYR_W[code - 0x400]
      : EXTRA_W.get(code) ?? FALLBACK_W;
  }
  return (w / 1000) * fontSize;
}

/**
 * Break text into rendered lines: explicit newlines always break; with
 * `maxWidth` each paragraph greedy-word-wraps at it, and a single word longer
 * than the box hard-breaks mid-word (the box wins — text must not grow out of
 * it). Whitespace is preserved verbatim inside lines; runs that land ON a wrap
 * boundary are dropped (browser soft-wrap behavior).
 */
export function wrapLines(text: string, fontSize: number, maxWidth?: number): string[] {
  const paragraphs = text.split("\n");
  if (maxWidth === undefined || maxWidth <= 0) return paragraphs;
  const out: string[] = [];
  for (const para of paragraphs) {
    const start = out.length;
    let line = "";
    for (const token of para.match(/\s+|\S+/g) ?? []) {
      const isSpace = /^\s+$/.test(token);
      if (line !== "" && lineWidth(line + token, fontSize) > maxWidth) {
        // Close the line; a whitespace run dies at the wrap boundary.
        out.push(line.replace(/\s+$/, ""));
        line = isSpace ? "" : token;
      } else {
        line += token;
      }
      // A lone word wider than the box hard-breaks mid-word (the box wins).
      while (lineWidth(line, fontSize) > maxWidth && line.length > 1) {
        let cut = 1;
        while (cut < line.length - 1 && lineWidth(line.slice(0, cut + 1), fontSize) <= maxWidth) cut++;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    // Close the paragraph — but trailing spaces that already closed a line
    // must not mint an extra blank one. (A genuinely empty paragraph still
    // emits its line: explicit newlines are preserved.)
    if (line !== "" || out.length === start) out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

/** The rendered block box of a text shape: wrap width when boxed (the BOX is
 *  the shape, whatever the lines fill), else the widest line; height = line
 *  count × fontSize (see {@link TEXT_LINE_H}). */
export function textBlockSize(text: string, fontSize: number, maxWidth?: number): { width: number; height: number } {
  const lines = wrapLines(text, fontSize, maxWidth);
  const width = maxWidth !== undefined && maxWidth > 0 ? maxWidth : Math.max(8, ...lines.map((ln) => lineWidth(ln, fontSize)));
  return { width, height: Math.max(1, lines.length) * fontSize * TEXT_LINE_H };
}

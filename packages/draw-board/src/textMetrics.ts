/**
 * Pure text metrics + wrapping for text shapes — the model's single source of
 * truth for where lines break and how big a text block is. Everything downstream
 * (canvas render, bbox/hit/attach, SVG export, the edit overlay's box) derives
 * from the SAME wrap, so they can never disagree.
 *
 * Measurement uses the canonical Arial/Helvetica advance-width table (Arial is
 * metric-compatible with Helvetica by design) — the board renders text in Arial
 * everywhere (Konva's default, the textarea's fontFamily, the SVG export), so
 * the pure estimate tracks real glyphs within ~1%. Non-ASCII falls back to a
 * 0.6em average (the old whole-string heuristic).
 */

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
const FALLBACK_W = 0.6;

/** Konva Text's default lineHeight (1 em per line); the edit textarea matches
 *  with `leading-none`. The block height is simply lines × fontSize. */
export const TEXT_LINE_H = 1;

/** Rendered width of a single line (no newlines) at `fontSize`. */
export function lineWidth(line: string, fontSize: number): number {
  let w = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0)!;
    w += code >= 32 && code <= 126 ? ARIAL_W[code - 32] / 1000 : FALLBACK_W;
  }
  return w * fontSize;
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

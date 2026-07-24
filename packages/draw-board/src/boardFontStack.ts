/**
 * The board face's family name + CSS stack — the ONE place both are spelled, so
 * the FontFace registration (boardFont.ts), the Konva/textarea/SVG font strings,
 * and the model's canvas measurer (textMetrics.ts) can never drift apart. Kept
 * in its own tiny module (no React, no embedded blobs) so the pure metrics can
 * import it without pulling the whole font loader in.
 */

/** The registered FontFace family — the embedded Arimo subset. */
export const BOARD_FONT_FAMILY = "DrawBoardSans";

/** Family list used VERBATIM by the Konva text nodes, the edit textarea, the
 *  SVG exports, and the model's canvas measurer — one string, one resolution
 *  path. The fallbacks only engage where the embedded face is absent (an
 *  exported SVG opened elsewhere, a glyph outside the embedded subsets); Arial's
 *  metric compatibility keeps layout stable even then. */
export const BOARD_FONT_STACK = `${BOARD_FONT_FAMILY}, Arial, sans-serif`;

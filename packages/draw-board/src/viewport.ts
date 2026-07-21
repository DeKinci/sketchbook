/**
 * Pure viewport (camera) math for the drawing board's pan/zoom.
 *
 * The camera maps logical (model) coordinates to screen (stage-container) pixels:
 *   screen = logical * scale + (x, y)
 * Konva's `getRelativePointerPosition()` inverts this automatically for input, so
 * everything here is only about *driving* the camera: zoom-to-a-point, panning,
 * fitting content, and the bounded-policy clamps.
 *
 * Policies (a DrawEditor-level choice, not the board's):
 *  - "infinite" — unbounded pan/zoom; the blank-sketch default.
 *  - "bounded"  — pan/zoom clamped to the doc box (fit is the zoom-out floor);
 *                 the image-annotation default.
 *  - "fixed"    — no gestures at all; the camera is always the fit view (the
 *                 legacy fit-to-container behavior, kept for component users).
 */

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export type ViewportPolicy = "infinite" | "bounded" | "fixed";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  w: number;
  h: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 40;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const clampScale = (s: number, min = MIN_SCALE, max = MAX_SCALE) => clamp(s, min, max);

export function screenToLogical(v: Viewport, pt: { x: number; y: number }): { x: number; y: number } {
  return { x: (pt.x - v.x) / v.scale, y: (pt.y - v.y) / v.scale };
}

export function logicalToScreen(v: Viewport, pt: { x: number; y: number }): { x: number; y: number } {
  return { x: pt.x * v.scale + v.x, y: pt.y * v.scale + v.y };
}

/** Zoom by `factor` keeping the logical point under `screenPt` fixed on screen. */
export function zoomAt(v: Viewport, screenPt: { x: number; y: number }, factor: number, min = MIN_SCALE, max = MAX_SCALE): Viewport {
  const scale = clampScale(v.scale * factor, min, max);
  if (scale === v.scale) return v;
  const k = scale / v.scale;
  return {
    scale,
    x: screenPt.x - (screenPt.x - v.x) * k,
    y: screenPt.y - (screenPt.y - v.y) * k,
  };
}

export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { ...v, x: v.x + dx, y: v.y + dy };
}

/** The logical rect currently visible through an `avail`-sized container. */
export function visibleLogicalRect(v: Viewport, avail: Size): Box {
  return { x: -v.x / v.scale, y: -v.y / v.scale, width: avail.w / v.scale, height: avail.h / v.scale };
}

/** The scale at which `box` exactly fits inside `avail` (letterboxing the other
 *  axis), clamped to the camera's range. `minScale` defaults to the camera's
 *  {@link MIN_SCALE} — right for every real camera, but a MINIATURE camera
 *  (minimap, thumbnail) mapping a huge world into a strip of pixels needs a
 *  legitimately smaller scale: those pass `minScale: 0`, else the "fit" stops
 *  fitting and overflows its target. */
export function fitScale(box: Box, avail: Size, maxScale = MAX_SCALE, minScale = MIN_SCALE): number {
  if (box.width <= 0 || box.height <= 0 || avail.w <= 0 || avail.h <= 0) return 1;
  return clampScale(Math.min(avail.w / box.width, avail.h / box.height), minScale, maxScale);
}

/** The camera that shows `box` centered at its fit scale. */
export function fitView(box: Box, avail: Size, opts?: { maxScale?: number; minScale?: number }): Viewport {
  const scale = fitScale(box, avail, opts?.maxScale ?? MAX_SCALE, opts?.minScale ?? MIN_SCALE);
  return {
    scale,
    x: (avail.w - box.width * scale) / 2 - box.x * scale,
    y: (avail.h - box.height * scale) / 2 - box.y * scale,
  };
}

/** Grow a box by `pad` on every side. */
export function padBox(box: Box, pad: number): Box {
  return { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
}

/** Union of two boxes. */
export function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * The bounded-policy clamp: the doc box can never be zoomed out past its fit
 * scale, and can never be panned to pull an edge inside the view — an axis where
 * the doc is smaller than the container (letterboxed at fit) stays centered.
 * `maxFit` caps the fit scale used as the zoom-out floor (a tiny doc in a huge
 * container shouldn't be FORCED to a blown-up view; zooming in past it is fine).
 */
export function clampBounded(v: Viewport, doc: Box, avail: Size, maxFit = MAX_SCALE): Viewport {
  const scale = clampScale(v.scale, fitScale(doc, avail, maxFit), MAX_SCALE);
  const w = doc.width * scale;
  const h = doc.height * scale;
  // Screen position of the doc box's top-left is v.x + doc.x*scale; clamp THAT.
  const left = v.x + doc.x * scale;
  const top = v.y + doc.y * scale;
  const cLeft = w <= avail.w ? (avail.w - w) / 2 : clamp(left, avail.w - w, 0);
  const cTop = h <= avail.h ? (avail.h - h) / 2 : clamp(top, avail.h - h, 0);
  const next = { scale, x: cLeft - doc.x * scale, y: cTop - doc.y * scale };
  return next.scale === v.scale && next.x === v.x && next.y === v.y ? v : next;
}

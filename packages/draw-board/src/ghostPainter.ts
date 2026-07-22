/**
 * Canvas-2D ghost painter — the schematic shape silhouettes shared by the
 * minimap and doc thumbnails (sidebar hover previews). Draws in LOGICAL
 * coordinates; the caller owns the transform and line width.
 */
import { boundingBox, contentBounds, diamondPoints, isContrastInk, isEnclosed, isNoStroke, paintOrder, textBgBox, CANVAS_BG_DARK, type DrawDoc, type Shape } from "./drawModel.ts";
import { fitView, padBox, type Size } from "./viewport.ts";

/** Ghost color for the adaptive contrast ink (ghosts sit on a dark ground). */
export const GHOST_INK = "#f5f5f5";
/** Max points per pen ghost — silhouettes, not fidelity. */
const PEN_GHOST_POINTS = 24;

export function paintShapeGhosts(ctx: CanvasRenderingContext2D, shapes: readonly Shape[]): void {
  /** Faint fill wash under a ghost outline (same treatment as image blocks). */
  const wash = (fill: string, paint: () => void) => {
    const prev = ctx.globalAlpha;
    ctx.fillStyle = fill;
    ctx.globalAlpha = prev * 0.27;
    paint();
    ctx.globalAlpha = prev;
  };
  // Ghosts stack like the board: paintOrder puts image blocks below every
  // vector silhouette, whatever the draw order.
  for (const sh of paintOrder(shapes)) {
    // "transparent" (a real CSS color) — an invalid strokeStyle assignment
    // would silently KEEP the previous shape's color and paint a ghost the
    // board doesn't show.
    const color = isContrastInk(sh.stroke) ? GHOST_INK : isNoStroke(sh.stroke) ? "transparent" : sh.stroke;
    ctx.strokeStyle = color;
    if (sh.type === "line" || sh.type === "arrow") {
      ctx.beginPath();
      ctx.moveTo(sh.points[0], sh.points[1]);
      ctx.lineTo(sh.points[2], sh.points[3]);
      ctx.stroke();
    } else if (sh.type === "pen") {
      const n = sh.points.length / 2;
      const step = Math.max(1, Math.ceil(n / PEN_GHOST_POINTS));
      ctx.beginPath();
      ctx.moveTo(sh.points[0], sh.points[1]);
      for (let i = step; i < n; i += step) ctx.lineTo(sh.points[i * 2], sh.points[i * 2 + 1]);
      ctx.lineTo(sh.points[(n - 1) * 2], sh.points[(n - 1) * 2 + 1]);
      if (sh.fill && isEnclosed(sh.points)) {
        ctx.closePath();
        wash(sh.fill, () => ctx.fill());
      }
      ctx.stroke();
    } else if (sh.type === "ellipse") {
      const b = boundingBox(sh);
      ctx.beginPath();
      ctx.ellipse(b.x + b.width / 2, b.y + b.height / 2, b.width / 2, b.height / 2, 0, 0, Math.PI * 2);
      if (sh.fill) wash(sh.fill, () => ctx.fill());
      ctx.stroke();
    } else if (sh.type === "diamond") {
      const p = diamondPoints(boundingBox(sh));
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      ctx.closePath();
      if (sh.fill) wash(sh.fill, () => ctx.fill());
      ctx.stroke();
    } else {
      const b = boundingBox(sh);
      if (sh.type === "image") {
        wash(color, () => ctx.fillRect(b.x, b.y, b.width, b.height));
      } else if ((sh.type === "rect" || sh.type === "text") && sh.fill) {
        const fb = sh.type === "text" ? textBgBox(sh) : b;
        wash(sh.fill, () => ctx.fillRect(fb.x, fb.y, fb.width, fb.height));
      }
      ctx.strokeRect(b.x, b.y, b.width, b.height);
    }
  }
}

/**
 * Render a whole doc as a thumbnail into `canvas` (CSS size `size`, HiDPI
 * aware): dark ground (or the annotation's background image), content fitted
 * with a small pad, ghost silhouettes on top. Async only for the background
 * decode; ghost painting is synchronous.
 */
export async function renderDocThumbnail(canvas: HTMLCanvasElement, doc: DrawDoc, size: Size): Promise<void> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  canvas.width = size.w * dpr;
  canvas.height = size.h * dpr;
  const frame = doc.background
    ? { x: 0, y: 0, width: doc.width || 1, height: doc.height || 1 }
    : contentBounds(doc.shapes) ?? { x: 0, y: 0, width: doc.width || 1, height: doc.height || 1 };
  const world = padBox(frame, Math.max(frame.width, frame.height) * 0.04);
  // minScale: 0 — a thumbnail is a miniature camera; sprawling content may
  // need a fit below the interactive camera's MIN_SCALE floor.
  const m = fitView(world, size, { minScale: 0 });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = CANVAS_BG_DARK;
  ctx.fillRect(0, 0, size.w, size.h);
  ctx.translate(m.x, m.y);
  ctx.scale(m.scale, m.scale);
  if (doc.background) {
    try {
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("bg decode"));
        img.src = `data:${doc.background!.mediaType};base64,${doc.background!.dataBase64}`;
      });
      ctx.drawImage(img, 0, 0, doc.width, doc.height);
    } catch {
      // ghost-only preview beats none
    }
  }
  ctx.lineWidth = 1 / m.scale;
  ctx.globalAlpha = 0.85;
  paintShapeGhosts(ctx, doc.shapes);
}

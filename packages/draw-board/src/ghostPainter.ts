/**
 * Canvas-2D ghost painter — the schematic shape silhouettes shared by the
 * minimap and doc thumbnails (sidebar hover previews). Draws in LOGICAL
 * coordinates; the caller owns the transform and line width.
 */
import { boundingBox, contentBounds, isContrastInk, CANVAS_BG_DARK, type DrawDoc, type Shape } from "./drawModel.ts";
import { fitView, padBox, type Size } from "./viewport.ts";

/** Ghost color for the adaptive contrast ink (ghosts sit on a dark ground). */
export const GHOST_INK = "#f5f5f5";
/** Max points per pen ghost — silhouettes, not fidelity. */
const PEN_GHOST_POINTS = 24;

export function paintShapeGhosts(ctx: CanvasRenderingContext2D, shapes: readonly Shape[]): void {
  for (const sh of shapes) {
    const color = isContrastInk(sh.stroke) ? GHOST_INK : sh.stroke;
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
      ctx.stroke();
    } else if (sh.type === "ellipse") {
      const b = boundingBox(sh);
      ctx.beginPath();
      ctx.ellipse(b.x + b.width / 2, b.y + b.height / 2, b.width / 2, b.height / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const b = boundingBox(sh);
      if (sh.type === "image") {
        const prev = ctx.globalAlpha;
        ctx.fillStyle = color;
        ctx.globalAlpha = prev * 0.27;
        ctx.fillRect(b.x, b.y, b.width, b.height);
        ctx.globalAlpha = prev;
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
  const m = fitView(world, size);
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

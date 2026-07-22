/**
 * Pure DrawDoc → SVG serializer.
 *
 * A reconstruction, not a Konva screenshot: geometry is exact, styling matches
 * the board's renderer (dark ground, fills, stroke widths, arrowheads via the
 * same size formula), with two documented approximations — pen strokes
 * smooth through midpoint quadratics (Konva uses its own tension spline) and
 * the adaptive contrast ink resolves against fills/paper only (per-pixel
 * adaptation over an IMAGE needs a raster; an image-covered contrast stroke
 * exports bright).
 *
 * The "rich" flag embeds the doc as JSON inside a <metadata> element keyed by
 * {@link SVG_META_ID}, making the file re-importable as a full board — the SVG
 * sibling of the PNG iTXt chunk.
 */
import { boundingBox, contrastSolidOver, dashFor, fillAt, isContrastInk, isEnclosed, isNoStroke, paintOrder, textBgBox, CANVAS_BG_DARK, type DrawDoc, type SegmentShape, type Shape } from "./drawModel.ts";
import { wrapLines } from "./textMetrics.ts";
import { BOARD_FONT_STACK } from "./boardFont.ts";
import { contentCropLogical } from "./exportPng.ts";

export const SVG_META_ID = "draw-board-doc";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/** Adaptive ink resolves against the topmost FILL under the shape's center
 *  (else the dark ground → bright) — matching the board's sampler, minus
 *  images (per-pixel adaptation over a raster stays a documented
 *  approximation: an image-covered contrast stroke exports bright). */
function inkOf(sh: Shape, shapes: Shape[]): string {
  if (isNoStroke(sh.stroke)) return "none"; // literal SVG none — fill-only shape
  if (!isContrastInk(sh.stroke)) return sh.stroke;
  const b = boundingBox(sh);
  return contrastSolidOver(fillAt(shapes, b.x + b.width / 2, b.y + b.height / 2));
}

/** Midpoint-quadratic smoothing — visually close to the board's tension spline. */
function penPath(points: number[]): string {
  const n = points.length / 2;
  if (n < 2) return "";
  let d = `M ${num(points[0])} ${num(points[1])}`;
  if (n === 2) return `${d} L ${num(points[2])} ${num(points[3])}`;
  for (let i = 1; i < n - 1; i++) {
    const cx = points[i * 2];
    const cy = points[i * 2 + 1];
    const mx = (cx + points[(i + 1) * 2]) / 2;
    const my = (cy + points[(i + 1) * 2 + 1]) / 2;
    d += ` Q ${num(cx)} ${num(cy)} ${num(mx)} ${num(my)}`;
  }
  d += ` L ${num(points[(n - 1) * 2])} ${num(points[(n - 1) * 2 + 1])}`;
  return d;
}

/** Filled triangle arrowhead at (x2,y2) pointing away from (x1,y1) — the same
 *  pointerLength/Width = 8 + strokeWidth the board renders with. */
function arrowHead(x1: number, y1: number, x2: number, y2: number, sw: number, color: string): string {
  const len = 8 + sw;
  const wid = 8 + sw;
  const a = Math.atan2(y2 - y1, x2 - x1);
  const bx = x2 - len * Math.cos(a);
  const by = y2 - len * Math.sin(a);
  const ox = (wid / 2) * Math.sin(a);
  const oy = (wid / 2) * -Math.cos(a);
  return `<path d="M ${num(x2)} ${num(y2)} L ${num(bx + ox)} ${num(by + oy)} L ${num(bx - ox)} ${num(by - oy)} Z" fill="${color}"/>`;
}

function shapeSvg(sh: Shape, shapes: Shape[]): string {
  const color = inkOf(sh, shapes);
  const sw = sh.strokeWidth;
  // Stroke style → dasharray (same width-derived pattern the board renders);
  // dotted boxes need the round cap the open strokes already carry.
  const dashArr = dashFor(sh.strokeStyle, sw);
  const dash = dashArr ? ` stroke-dasharray="${dashArr.map(num).join(" ")}"` : "";
  const boxCap = sh.strokeStyle === "dotted" ? ' stroke-linecap="round"' : "";
  switch (sh.type) {
    case "rect": {
      const b = boundingBox(sh);
      return `<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.width)}" height="${num(b.height)}" fill="${sh.fill ?? "none"}" stroke="${color}" stroke-width="${sw}"${dash}${boxCap}/>`;
    }
    case "ellipse": {
      const b = boundingBox(sh);
      return `<ellipse cx="${num(b.x + b.width / 2)}" cy="${num(b.y + b.height / 2)}" rx="${num(b.width / 2)}" ry="${num(b.height / 2)}" fill="${sh.fill ?? "none"}" stroke="${color}" stroke-width="${sw}"${dash}${boxCap}/>`;
    }
    case "line": {
      const [x1, y1, x2, y2] = sh.points;
      return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"${dash}/>`;
    }
    case "arrow": {
      const [x1, y1, x2, y2] = sh.points;
      const parts = [
        `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"${dash}/>`,
        arrowHead(x1, y1, x2, y2, sw, color),
      ];
      if ((sh as SegmentShape).doubleHead) parts.push(arrowHead(x2, y2, x1, y1, sw, color));
      return parts.join("");
    }
    case "pen": {
      // An ENCLOSED doodle's fill: a closed strokeless twin UNDER the real
      // stroke (mirrors the board — the visible stroke keeps its open path).
      const fillPath =
        sh.fill && isEnclosed(sh.points) ? `<path d="${penPath(sh.points)} Z" fill="${sh.fill}" stroke="none"/>` : "";
      return `${fillPath}<path d="${penPath(sh.points)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
    }
    case "text": {
      // Background highlight first (the padded block), then one <text> per
      // rendered line — the SAME wrap the board draws (model-owned).
      const bg = sh.fill
        ? (() => {
            const b = textBgBox(sh);
            return `<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.width)}" height="${num(b.height)}" rx="${num(b.pad)}" fill="${sh.fill}"/>`;
          })()
        : "";
      return (
        bg +
        wrapLines(sh.text, sh.fontSize, sh.width)
          .map((ln, i) => `<text x="${num(sh.x)}" y="${num(sh.y + sh.fontSize * (i + 1))}" font-family="${BOARD_FONT_STACK}" font-size="${sh.fontSize}" fill="${color}">${esc(ln)}</text>`)
          .join("")
      );
    }
    case "image": {
      return `<image x="${num(sh.x)}" y="${num(sh.y)}" width="${num(sh.width)}" height="${num(sh.height)}" href="data:${sh.mediaType};base64,${sh.dataBase64}" preserveAspectRatio="none"/>`;
    }
  }
}

export interface SvgExportOptions {
  /** Embed the doc for full re-import (default true — the "rich" export). */
  rich?: boolean;
}

/** Serialize a doc to a standalone SVG. ViewBox follows the PNG export's crop
 *  rules: an annotation exports its doc box; a blank sketch trims to content
 *  (+pad), unclamped — the infinite plane has no edges. */
export function exportSvg(doc: DrawDoc, opts?: SvgExportOptions): string {
  const rich = opts?.rich !== false;
  // Annotation: the image IS the frame (doc box). Blank sketch: trim to content
  // (+pad) unclamped; an empty board falls back to the legacy doc box.
  const crop = doc.background
    ? { x: 0, y: 0, width: doc.width || 1, height: doc.height || 1 }
    : contentCropLogical(doc, { clamp: false }) ?? { x: 0, y: 0, width: doc.width || 1, height: doc.height || 1 };
  const body = paintOrder(doc.shapes)
    .map((sh) => shapeSvg(sh, doc.shapes))
    .join("\n  ");
  const bg = doc.background
    ? `<image x="0" y="0" width="${num(doc.width)}" height="${num(doc.height)}" href="data:${doc.background.mediaType};base64,${doc.background.dataBase64}" preserveAspectRatio="none"/>`
    : `<rect x="${num(crop.x)}" y="${num(crop.y)}" width="${num(crop.width)}" height="${num(crop.height)}" fill="${CANVAS_BG_DARK}"/>`;
  const meta = rich
    ? `\n  <metadata id="${SVG_META_ID}">${esc(JSON.stringify({ v: 1, kind: "draw-board", doc }))}</metadata>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(crop.x)} ${num(crop.y)} ${num(crop.width)} ${num(crop.height)}" width="${num(crop.width)}" height="${num(crop.height)}">${meta}
  ${bg}
  ${body}
</svg>`;
}

/** Parse a rich SVG's embedded doc, or null (foreign/slim SVG, junk). */
export function readSvgDoc(text: string): DrawDoc | null {
  const open = text.indexOf(`<metadata id="${SVG_META_ID}">`);
  if (open < 0) return null;
  const start = open + `<metadata id="${SVG_META_ID}">`.length;
  const end = text.indexOf("</metadata>", start);
  if (end < 0) return null;
  const raw = text
    .slice(start, end)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  try {
    const parsed = JSON.parse(raw) as { kind?: string; doc?: DrawDoc };
    return parsed?.kind === "draw-board" && parsed.doc && Array.isArray(parsed.doc.shapes) ? parsed.doc : null;
  } catch {
    return null;
  }
}

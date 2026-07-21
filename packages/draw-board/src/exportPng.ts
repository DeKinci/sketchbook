import type Konva from "konva";
import { contentBounds, type DrawDoc } from "./drawModel.ts";

/** Padding (logical px) kept around the drawn content when a blank sketch is
 *  trimmed to its used region on export. */
const EXPORT_PAD = 30;

/** Hard cap on the exported PNG's width/height (px) — an infinite board can hold
 *  content spread over a huge logical area; the flattened attachment must stay a
 *  sane raster. */
const MAX_EXPORT_PX = 4096;

/** The logical crop rect for a blank sketch — the union bbox of every shape grown
 *  by {@link EXPORT_PAD}. With `clamp` (the bounded/fixed policies) the rect is
 *  clamped to the canvas box, so the trimmed piece keeps its dark board background
 *  but discards the empty rest; without it (the infinite policy) content lives
 *  anywhere in the plane and the rect is used as-is. Null = export the whole
 *  canvas: an image annotation (the image IS the content) or an empty board. */
export function contentCropLogical(doc: DrawDoc, opts?: { clamp?: boolean }): { x: number; y: number; width: number; height: number } | null {
  if (doc.background || doc.shapes.length === 0) return null;
  const b = contentBounds(doc.shapes)!;
  if (opts?.clamp === false) {
    return { x: b.x - EXPORT_PAD, y: b.y - EXPORT_PAD, width: Math.max(1, b.width + EXPORT_PAD * 2), height: Math.max(1, b.height + EXPORT_PAD * 2) };
  }
  const x = Math.max(0, b.x - EXPORT_PAD);
  const y = Math.max(0, b.y - EXPORT_PAD);
  const width = Math.max(1, Math.min(doc.width, b.x + b.width + EXPORT_PAD) - x);
  const height = Math.max(1, Math.min(doc.height, b.y + b.height + EXPORT_PAD) - y);
  return { x, y, width, height };
}

/**
 * Flatten a Konva stage to a PNG {@link File} ready for the attachment tray.
 *
 * The stage's live transform is now a free camera (pan/zoom), so the export can't
 * be derived from it: the stage is temporarily driven to a deterministic export
 * transform (scale = output px per logical px, positioned so the crop rect fills
 * the whole stage), snapshotted, and restored. This renders the SAME pixels
 * whatever the user's current pan/zoom:
 *  - an annotated image exports at the source's natural resolution;
 *  - a blank sketch exports at 2× its logical content size (crisp on HiDPI),
 *    capped at {@link MAX_EXPORT_PX} for sprawling infinite boards.
 *
 * `clampCrop=false` (the infinite policy) lets the content trim rect extend
 * beyond the doc box — content lives anywhere in the plane there.
 */
/** Output px per logical px for an export: the natural resolution (annotation)
 *  or 2× (sketch), reduced so NEITHER output dimension exceeds
 *  {@link MAX_EXPORT_PX} — an oversized canvas silently breaks `toBlob`
 *  (browsers return null past their canvas dimension limits). Pure. */
export function exportScale(doc: DrawDoc, crop: { width: number; height: number }): number {
  const base = doc.background ? Math.min(doc.background.width, MAX_EXPORT_PX) / crop.width : 2;
  return Math.min(base, MAX_EXPORT_PX / crop.width, MAX_EXPORT_PX / crop.height);
}

export async function exportStagePng(stage: Konva.Stage, doc: DrawDoc, name: string, opts?: { clampCrop?: boolean }): Promise<File> {
  const crop = contentCropLogical(doc, { clamp: opts?.clampCrop !== false }) ?? { x: 0, y: 0, width: doc.width || 1, height: doc.height || 1 };
  const s = exportScale(doc, crop);

  const prev = {
    x: stage.x(),
    y: stage.y(),
    scaleX: stage.scaleX(),
    scaleY: stage.scaleY(),
    width: stage.width(),
    height: stage.height(),
  };
  // Content strokes render in SCREEN space (DrawCanvas: strokeScaleEnabled:false
  // + width × camera scale, floored for zoomed-out legibility). The export
  // transform is its own "camera", so drive each stroke to its proportional
  // width at the export scale — model width × s, WITHOUT the floor (a screen
  // aid, not part of the artwork) — and restore the live widths after.
  const strokeOverrides: Array<{ node: Konva.Shape; live: number }> = [];
  for (const sh of doc.shapes) {
    if (sh.type === "text" || sh.type === "image") continue; // no stroked outline
    const found = stage.findOne<Konva.Node>(`#${sh.id}`);
    // An ellipse's id sits on its positioning Group; the stroked node is inside.
    const node = found?.getClassName?.() === "Group" ? (found as Konva.Group).findOne<Konva.Shape>("Ellipse") : (found as Konva.Shape | undefined);
    if (!node) continue;
    strokeOverrides.push({ node, live: node.strokeWidth() });
    node.strokeWidth(sh.strokeWidth * s);
  }
  try {
    stage.scale({ x: s, y: s });
    stage.position({ x: -crop.x * s, y: -crop.y * s });
    stage.size({ width: Math.max(1, Math.round(crop.width * s)), height: Math.max(1, Math.round(crop.height * s)) });
    stage.draw();
    // konva types `toBlob` as `Promise<unknown>`; it resolves to a Blob — or
    // null when the browser refuses the canvas (never silently attach that).
    const blob = (await stage.toBlob({ mimeType: "image/png", pixelRatio: 1 })) as Blob | null;
    if (!blob) throw new Error("the browser could not render the export (canvas too large?)");
    return new File([blob], name, { type: "image/png" });
  } finally {
    for (const { node, live } of strokeOverrides) node.strokeWidth(live);
    stage.scale({ x: prev.scaleX, y: prev.scaleY });
    stage.position({ x: prev.x, y: prev.y });
    stage.size({ width: prev.width, height: prev.height });
    stage.draw();
  }
}

/** A `.png` file name for an exported drawing. A new sketch gets a short unique
 *  name; an annotated image keeps its stem so the tray label stays recognizable. */
export function sketchFileName(existing = ""): string {
  const stem = existing.replace(/\.[a-z0-9]+$/i, "").trim();
  if (stem) return `${stem}.png`;
  return `sketch-${crypto.randomUUID().slice(0, 6)}.png`;
}

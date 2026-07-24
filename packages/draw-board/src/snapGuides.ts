/**
 * Centerline snapping — the pure geometry behind the board's alignment guides.
 *
 * A shape has two centerlines: a VERTICAL one at its horizontal center (x = cx)
 * and a HORIZONTAL one at its vertical center (y = cy). While a shape is dragged
 * or resized, its centerlines gently snap to any OTHER shape's matching
 * centerline within a small (screen-true) threshold, and a guide line is drawn
 * through the aligned shapes. The two axes snap INDEPENDENTLY — vertical to one
 * shape, horizontal to another, or both to a single shape's dead center.
 *
 * This module is pure and view-agnostic (plain boxes in, a nudge + guide lines
 * out); the canvas feeds it the live drag/resize box each frame, applies the
 * returned nudge, and paints the guides. Threshold is passed in LOGICAL units
 * (the caller divides its screen px by the zoom, so the pull feels the same at
 * any zoom).
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single alignment guide. `axis: "x"` is a VERTICAL line at `pos` on the x
 *  axis (vertical centerlines met); `axis: "y"` is a HORIZONTAL line at `pos`.
 *  `from`/`to` are the extent along the perpendicular axis — the line spans every
 *  shape sharing the centerline, so it visibly connects them. */
export interface SnapGuide {
  axis: "x" | "y";
  pos: number;
  from: number;
  to: number;
}

export interface SnapResult {
  /** Nudge to add to the moving box so its centerlines land on the snapped
   *  target(s). Zero on an axis that didn't snap. */
  dx: number;
  dy: number;
  /** Guide lines to draw (0–2): a vertical when x snapped, a horizontal when y
   *  snapped, both on a dead-center landing. */
  guides: SnapGuide[];
}

const cx = (b: Box) => b.x + b.width / 2;
const cy = (b: Box) => b.y + b.height / 2;
/** Centerlines within this many logical units are treated as the SAME line when
 *  gathering a guide's extent (targets sharing the snapped centerline). */
const SAME_LINE_EPS = 0.5;

/**
 * Snap `moving`'s centerlines to the nearest target centerline per axis, within
 * `threshold` (logical units). Returns the nudge to align and the guide lines to
 * draw — each spanning `moving` (post-nudge) plus every target on that line.
 */
export function snapCenterlines(moving: Box, targets: Box[], threshold: number): SnapResult {
  const mcx = cx(moving);
  const mcy = cy(moving);
  let bestX: { pos: number; dist: number } | null = null;
  let bestY: { pos: number; dist: number } | null = null;
  for (const t of targets) {
    const dxDist = Math.abs(cx(t) - mcx);
    if (dxDist <= threshold && (!bestX || dxDist < bestX.dist)) bestX = { pos: cx(t), dist: dxDist };
    const dyDist = Math.abs(cy(t) - mcy);
    if (dyDist <= threshold && (!bestY || dyDist < bestY.dist)) bestY = { pos: cy(t), dist: dyDist };
  }
  const dx = bestX ? bestX.pos - mcx : 0;
  const dy = bestY ? bestY.pos - mcy : 0;
  const snapped: Box = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: SnapGuide[] = [];
  if (bestX !== null) {
    // Vertical line at x = bestX.pos, spanning the moving box and every target
    // whose vertical centerline is that line.
    let from = snapped.y;
    let to = snapped.y + snapped.height;
    for (const t of targets) {
      if (Math.abs(cx(t) - bestX.pos) > SAME_LINE_EPS) continue;
      from = Math.min(from, t.y);
      to = Math.max(to, t.y + t.height);
    }
    guides.push({ axis: "x", pos: bestX.pos, from, to });
  }
  if (bestY !== null) {
    let from = snapped.x;
    let to = snapped.x + snapped.width;
    for (const t of targets) {
      if (Math.abs(cy(t) - bestY.pos) > SAME_LINE_EPS) continue;
      from = Math.min(from, t.x);
      to = Math.max(to, t.x + t.width);
    }
    guides.push({ axis: "y", pos: bestY.pos, from, to });
  }
  return { dx, dy, guides };
}

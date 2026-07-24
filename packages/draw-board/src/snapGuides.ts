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

/** The nearest target centerline to `pos` within `threshold`, or null. */
function nearestLine(lines: number[], pos: number, threshold: number): number | null {
  let best: number | null = null;
  let bestDist = threshold;
  for (const l of lines) {
    const d = Math.abs(l - pos);
    if (d <= bestDist) {
      // `<=` so an exact tie prefers a later equal line deterministically; only a
      // strictly-nearer one past the first replaces it.
      if (best === null || d < bestDist) {
        best = l;
        bestDist = d;
      }
    }
  }
  return best;
}

/** A guide along `axis` at `pos`, spanning `box` plus every target whose matching
 *  centerline is that same line — so the drawn line visibly connects them all. */
function guideThrough(axis: "x" | "y", pos: number, box: Box, targets: Box[]): SnapGuide {
  const lineOf = axis === "x" ? cx : cy;
  const lo = axis === "x" ? (b: Box) => b.y : (b: Box) => b.x;
  const hi = axis === "x" ? (b: Box) => b.y + b.height : (b: Box) => b.x + b.width;
  let from = lo(box);
  let to = hi(box);
  for (const t of targets) {
    if (Math.abs(lineOf(t) - pos) > SAME_LINE_EPS) continue;
    from = Math.min(from, lo(t));
    to = Math.max(to, hi(t));
  }
  return { axis, pos, from, to };
}

/**
 * Snap `moving`'s centerlines to the nearest target centerline per axis, within
 * `threshold` (logical units). Returns the nudge to align and the guide lines to
 * draw — each spanning `moving` (post-nudge) plus every target on that line.
 */
export function snapCenterlines(moving: Box, targets: Box[], threshold: number): SnapResult {
  const bestX = nearestLine(targets.map(cx), cx(moving), threshold);
  const bestY = nearestLine(targets.map(cy), cy(moving), threshold);
  const dx = bestX !== null ? bestX - cx(moving) : 0;
  const dy = bestY !== null ? bestY - cy(moving) : 0;
  const snapped: Box = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: SnapGuide[] = [];
  if (bestX !== null) guides.push(guideThrough("x", bestX, snapped, targets));
  if (bestY !== null) guides.push(guideThrough("y", bestY, snapped, targets));
  return { dx, dy, guides };
}

export interface ResizeSnapResult {
  /** The box after snapping — the DRAGGED edge moved onto the target centerline,
   *  the anchor (opposite) edge held. Unchanged axes pass through. */
  box: Box;
  guides: SnapGuide[];
}

/**
 * Resize-time centerline snapping. As a shape is resized, snap its center per
 * axis to the nearest target centerline within `threshold`, moving only the
 * DRAGGED edge (inferred as the one that changed most vs `oldBox`) so the anchor
 * edge stays put. Only an axis whose edges actually moved this frame is
 * considered — a pure horizontal resize never snaps the vertical center. A snap
 * that would collapse the box (≤0) is skipped.
 */
export function snapResize(newBox: Box, oldBox: Box, targets: Box[], threshold: number): ResizeSnapResult {
  let { x, y, width, height } = newBox;
  const guides: SnapGuide[] = [];
  const EPS = 0.01;

  const leftMoved = Math.abs(newBox.x - oldBox.x);
  const rightMoved = Math.abs(newBox.x + newBox.width - (oldBox.x + oldBox.width));
  if (leftMoved > EPS || rightMoved > EPS) {
    const bestX = nearestLine(targets.map(cx), x + width / 2, threshold);
    if (bestX !== null) {
      if (leftMoved > rightMoved) {
        // Left edge dragged → right edge anchored. Move left so the center hits.
        const right = x + width;
        const nx = 2 * bestX - right;
        if (right - nx > EPS) { x = nx; width = right - nx; }
      } else {
        // Right edge dragged → left edge anchored. Widen/narrow to hit.
        const w = 2 * (bestX - x);
        if (w > EPS) width = w;
      }
    }
  }
  const topMoved = Math.abs(newBox.y - oldBox.y);
  const bottomMoved = Math.abs(newBox.y + newBox.height - (oldBox.y + oldBox.height));
  if (topMoved > EPS || bottomMoved > EPS) {
    const bestY = nearestLine(targets.map(cy), y + height / 2, threshold);
    if (bestY !== null) {
      if (topMoved > bottomMoved) {
        const bottom = y + height;
        const ny = 2 * bestY - bottom;
        if (bottom - ny > EPS) { y = ny; height = bottom - ny; }
      } else {
        const h = 2 * (bestY - y);
        if (h > EPS) height = h;
      }
    }
  }

  const box: Box = { x, y, width, height };
  // A guide for each axis that ended up on a target centerline.
  const onX = nearestLine(targets.map(cx), cx(box), SAME_LINE_EPS);
  const onY = nearestLine(targets.map(cy), cy(box), SAME_LINE_EPS);
  if (onX !== null && (leftMoved > EPS || rightMoved > EPS)) guides.push(guideThrough("x", onX, box, targets));
  if (onY !== null && (topMoved > EPS || bottomMoved > EPS)) guides.push(guideThrough("y", onY, box, targets));
  return { box, guides };
}

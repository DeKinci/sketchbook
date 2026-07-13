/**
 * The PURE drawing model — shapes, tool/style, (multi-)selection, and undo/redo —
 * as a reducer with no React and no canvas. Konva rendering (`DrawCanvas`) and
 * PNG export (`exportPng`) are thin shells over this; ALL the load-bearing logic
 * (geometry commit, history, selection bookkeeping, marquee hit-testing) lives
 * here so it's unit-testable without a DOM/canvas (jsdom can't render Konva).
 *
 * IDs are supplied by the caller (in action payloads) rather than minted here,
 * so the reducer stays deterministic/pure for tests.
 */

export type Tool = "select" | "pen" | "rect" | "ellipse" | "line" | "arrow" | "darrow" | "text" | "eraser";

/** Tools that place a shape by dragging (not select/text/eraser). */
export const DRAW_TOOLS: readonly Tool[] = ["pen", "rect", "ellipse", "line", "arrow", "darrow"];

/** A shape attached to ONE parent shape (edge/corner-touching). The edge is STORED
 *  single-parent (child→parent) but is SEMANTICALLY UNDIRECTED for propagation:
 *   - MOVE follows are size-gated from the grabbed seed ("largest drags smallest",
 *     {@link moveClusterIds}) — a heavier node blocks its subtree; strokes are
 *     massless (always follow, never pull); grabbing the smaller of a pair detaches
 *     it. What you grab always moves and wins.
 *   - RESIZE follows are DIRECTION-AGNOSTIC and ungated (§2.5): the neighbor tracks
 *     the moving side whether the edge is `n.attach = S` or `S.attach = n` (an
 *     inverted anchor is synthesized for the latter), and the resized shape's own
 *     anchor is refreshed at the end (no snap-back).
 *   - CREATION paths auto-attach (pen strokes / placed text+images against a shape;
 *     paste preserves intra-batch glue).
 *  A `box` anchor for rectangular parents pins the child's center to a side/corner
 *  (ax,ay ∈ {0,0.5,1} of the parent box) with a gap (dx,dy); a `radial` anchor for
 *  ellipse parents keeps the child at an angle + gap off the ellipse border. No
 *  rotation (a shape binds to only one other). */
export type Attach =
  | { id: string; kind: "box"; ax: number; ay: number; dx: number; dy: number }
  | { id: string; kind: "radial"; angle: number; gap: number };

export interface BaseShape {
  id: string;
  /** Stroke color (also the fill for text). */
  stroke: string;
  strokeWidth: number;
  /** Optional caption bound to the shape (double-click a shape to edit it). It
   *  renders centered and follows the shape on move/resize/delete. */
  label?: string;
  /** Attachment to a parent shape (see {@link Attach}), or none. */
  attach?: Attach;
}
/** Rect + ellipse share an axis-aligned bounding box {x,y,width,height}. The
 *  view converts an ellipse box to Konva's center+radii; keeping the box form
 *  here makes both uniform and resize trivial. width/height may be negative
 *  mid-draw (dragged up/left) — `normalizeBox` fixes sign at commit. */
export interface BoxShape extends BaseShape {
  type: "rect" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
}
/** A bound endpoint, stored relative to the connection direction: `angle` is the
 *  OFFSET from the direction toward the other endpoint at bind time, and `gap` is
 *  the distance BEYOND the shape's border along that direction. Reflow casts to
 *  the actual border (so it clings to a rect's edges, not a circle) + the gap —
 *  keeping where it was drawn, translating with the shape, and rotating along the
 *  border as the two shapes swing relative to one another. */
export interface Bind {
  id: string;
  angle: number;
  gap: number;
}
/** Line + arrow: a flat [x1,y1,x2,y2]. Arrow adds a head in the view. Either end
 *  can be BOUND to another shape (drawn near it): the endpoint keeps its relative
 *  spot and follows when the shape moves/resizes. */
export interface SegmentShape extends BaseShape {
  type: "line" | "arrow";
  points: [number, number, number, number];
  bindStart?: Bind;
  bindEnd?: Bind;
  /** Arrow with a head at BOTH ends (drawn with the `darrow` tool). Only meaningful
   *  for `arrow`; the geometry is otherwise identical to a one-headed arrow, so only
   *  the view differs (`pointerAtBeginning`). */
  doubleHead?: boolean;
}
/** Freehand pen stroke: flat [x1,y1,x2,y2,…]. */
export interface FreehandShape extends BaseShape {
  type: "pen";
  points: number[];
}
export interface TextShape extends BaseShape {
  type: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
}
/** A raster placed onto the canvas (dropped/pasted image) — movable/resizable,
 *  distinct from the single full-canvas background. */
export interface ImageShape extends BaseShape {
  type: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  dataBase64: string;
  mediaType: string;
  /** Non-destructive crop: the SOURCE-pixel region shown in the box. Absent =
   *  full image. Reversible (clear it to uncrop). */
  crop?: { x: number; y: number; width: number; height: number };
}
export type Shape = BoxShape | SegmentShape | FreehandShape | TextShape | ImageShape;

/** An editable drawing: optional background image + vector shapes + the stage
 *  size they were authored at. Held client-side alongside a tray attachment so
 *  a sketch/annotation stays re-editable; only the flattened PNG is ever sent. */
export interface DrawDoc {
  /** Background raster (a dropped/pasted image being annotated), or none for a
   *  blank sketch. Bytes are base64 with no `data:` prefix (attachment form). */
  background?: { dataBase64: string; mediaType: string; width: number; height: number };
  shapes: Shape[];
  /** Authoring canvas size in logical px (independent of on-screen fit scale). */
  width: number;
  height: number;
}

/** The two persistent ("selectable") tools you stay in; every other tool is
 *  one-use and snaps back to the last selectable after a single application. */
export const SELECTABLE_TOOLS: readonly Tool[] = ["select", "pen"];
export const isSelectable = (t: Tool) => t === "select" || t === "pen";

/** The one-use CLUSTER tools. Each cluster owns one toolbar button + number key:
 *  arming it selects the cluster's LAST-USED variant; arming again while already
 *  armed cycles to the next variant (rect⇄ellipse, line→arrow→double-arrow). Drawing
 *  snaps the tool back to `baseTool`, but the remembered variant persists (see
 *  {@link DrawState.shapeVariant}/`lineVariant` + the `armCluster` action). */
export const SHAPE_VARIANTS = ["rect", "ellipse"] as const;
export const LINE_VARIANTS = ["line", "arrow", "darrow"] as const;
export type ShapeVariant = (typeof SHAPE_VARIANTS)[number];
export type LineVariant = (typeof LINE_VARIANTS)[number];

export interface DrawState extends DrawDoc {
  tool: Tool;
  /** The last selectable tool (select/pen) — where one-use tools snap back to,
   *  and what the ` key toggles/returns to. */
  baseTool: "select" | "pen";
  /** Last-used variant of each one-use cluster — remembered across a draw's
   *  snap-back so re-arming the cluster returns the variant you last drew with. */
  shapeVariant: ShapeVariant;
  lineVariant: LineVariant;
  color: string;
  strokeWidth: number;
  /** Currently selected shapes (move/resize/delete/copy), in no particular order. */
  selectedIds: string[];
  /** The shape being drawn/edited during an active gesture, or none. */
  draftId: string | null;
  /** Snapshot of `shapes` captured at gesture start; committed to `past` at
   *  gesture end iff shapes actually changed. Null between gestures. */
  gestureBase: Shape[] | null;
  past: Shape[][];
  future: Shape[][];
}

export const DEFAULT_STROKE_WIDTH = 3;
/** Stroke widths for shapes; for TEXT these same three slots mean small/medium/
 *  large font size (see {@link fontForStroke}). */
export const STROKE_WIDTHS = [3, 6, 10] as const;
export const TEXT_SIZES: Record<number, number> = { 3: 18, 6: 28, 10: 44 };
/** Generic small/medium/large text size for a stroke slot (not stroke-scaled). */
export function fontForStroke(w: number): number {
  return TEXT_SIZES[w] ?? 24;
}
/** The content colors (user's drawing colors — NOT UI chrome; the design-token
 *  rule governs chrome, these are pixels the user paints). The palette shown in
 *  the toolbar is `[primary ink, ...INK_COLORS]`, where primary is the
 *  theme-contrast ink (see {@link defaultInk}). */
export const INK_COLORS = [
  "#e5484d", // red
  "#f5a623", // amber
  "#30a46c", // green
  "#3b82f6", // blue
] as const;

/** Operator is dark-only — a blank sketch canvas is this dark surface. */
export const CANVAS_BG_DARK = "#1a1a1e";
/** The "adaptive" primary ink — a sentinel stroke value. The canvas renders it
 *  white with a `difference` composite so it always contrasts whatever is behind
 *  it, PER PIXEL, updating live as the shape is moved (over dark → light, over a
 *  photo → the negative, over red → cyan). No luminance sampling needed. */
export const CONTRAST_INK = "contrast";
/** Toolbar palette: the adaptive primary ink first, then the fixed colors. */
export const PALETTE: readonly string[] = [CONTRAST_INK, ...INK_COLORS];
/** True for a shape painted with the adaptive ink (render white + `difference`). */
export const isContrastInk = (stroke: string) => stroke === CONTRAST_INK;

const DEFAULT_STAGE = { width: 720, height: 460 };

export function initialDrawState(doc?: DrawDoc, opts?: { color?: string }): DrawState {
  return {
    background: doc?.background,
    shapes: doc ? doc.shapes.map(cloneShape) : [],
    width: doc?.width ?? DEFAULT_STAGE.width,
    height: doc?.height ?? DEFAULT_STAGE.height,
    // Always open in pen — ready to sketch immediately (cursor is one Tab away).
    // The pill keeps cursor first / pen second; the well just starts on pen.
    tool: "pen",
    baseTool: "pen",
    shapeVariant: "rect",
    lineVariant: "arrow",
    color: opts?.color ?? CONTRAST_INK,
    strokeWidth: DEFAULT_STROKE_WIDTH,
    selectedIds: [],
    draftId: null,
    gestureBase: null,
    past: [],
    future: [],
  };
}

/** The doc slice of the state (what gets persisted alongside the attachment). */
export function toDoc(s: DrawState): DrawDoc {
  return {
    background: s.background,
    shapes: s.shapes.map(cloneShape),
    width: s.width,
    height: s.height,
  };
}

export function cloneShape(sh: Shape): Shape {
  switch (sh.type) {
    case "line":
    case "arrow":
      return { ...sh, points: [...sh.points] as [number, number, number, number] };
    case "pen":
      return { ...sh, points: [...sh.points] };
    default:
      return { ...sh };
  }
}

/** Fix a possibly-negative box (dragged up/left) to top-left origin + positive
 *  extent, so resize handles and hit-testing behave. */
export function normalizeBox(b: BoxShape): BoxShape {
  const x = b.width < 0 ? b.x + b.width : b.x;
  const y = b.height < 0 ? b.y + b.height : b.y;
  return { ...b, x, y, width: Math.abs(b.width), height: Math.abs(b.height) };
}

/** Axis-aligned bounding box of any shape (used for marquee + selection outline).
 *  Text width is approximated from character count (we don't measure glyphs). */
export function boundingBox(sh: Shape): { x: number; y: number; width: number; height: number } {
  switch (sh.type) {
    case "rect":
    case "ellipse": {
      const b = normalizeBox(sh);
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
    case "image":
      return { x: sh.x, y: sh.y, width: sh.width, height: sh.height };
    case "line":
    case "arrow": {
      const [x1, y1, x2, y2] = sh.points;
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    }
    case "pen": {
      const xs = sh.points.filter((_, i) => i % 2 === 0);
      const ys = sh.points.filter((_, i) => i % 2 === 1);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    case "text":
      return { x: sh.x, y: sh.y, width: Math.max(8, sh.text.length * sh.fontSize * 0.6), height: sh.fontSize * 1.2 };
  }
}

/** Font size for a shape's bound label — scaled to fit inside the shape. */
export function labelFont(bbox: { width: number; height: number }): number {
  return Math.max(12, Math.min(26, bbox.height * 0.45, bbox.width * 0.28));
}

/** Union bounding box of all shapes, or null for an empty board — the content
 *  extent (used to fit the camera, trim exports, and size the infinite-board
 *  background). */
export function contentBounds(shapes: Shape[]): { x: number; y: number; width: number; height: number } | null {
  if (shapes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sh of shapes) {
    const b = boundingBox(sh);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Ids of shapes whose bounding box intersects a marquee rectangle. */
export function shapesInMarquee(shapes: Shape[], marquee: { x: number; y: number; width: number; height: number }): string[] {
  const m = {
    x: marquee.width < 0 ? marquee.x + marquee.width : marquee.x,
    y: marquee.height < 0 ? marquee.y + marquee.height : marquee.y,
    width: Math.abs(marquee.width),
    height: Math.abs(marquee.height),
  };
  return shapes.filter((sh) => rectsIntersect(boundingBox(sh), m)).map((sh) => sh.id);
}

/** Area shapes an arrow/line can bind to, and that can "contain" other shapes. */
const CONTAINER_TYPES = new Set(["rect", "ellipse", "image", "text"]);
export const BIND_DISTANCE = 22;

/** Segment connectors (line/arrow) connect via `bindStart`/`bindEnd` — they NEVER
 *  take an `attach` edge. Letting one attach made the attach system (which drags +
 *  repositions attached shapes) fight the bind system (which re-clings the endpoint),
 *  drifting a bound arrow's endpoint around its target on every move. So the attach
 *  system excludes connectors as children everywhere: creation ({@link attachAt}),
 *  application ({@link reflowAttachments}), and cluster adjacency ({@link
 *  attachAdjacency}). */
const isConnector = (sh: Shape) => sh.type === "line" || sh.type === "arrow";

const shapeCenter = (sh: Shape) => {
  const b = boundingBox(sh);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** Distance from a shape's center to its border along direction `dir` — a
 *  rectangle's edges for rect/image/text, the ellipse curve for ellipse. Lets a
 *  bound endpoint cling to the actual border as it rotates (not a circle). */
function borderDist(sh: Shape, dir: number): number {
  const b = boundingBox(sh);
  const hx = b.width / 2;
  const hy = b.height / 2;
  if (hx <= 0 || hy <= 0) return 0;
  if (sh.type === "ellipse") {
    const c = Math.cos(dir) / hx;
    const s = Math.sin(dir) / hy;
    const denom = Math.hypot(c, s);
    return denom > 1e-9 ? 1 / denom : Math.max(hx, hy);
  }
  const c = Math.abs(Math.cos(dir));
  const s = Math.abs(Math.sin(dir));
  const tx = c > 1e-9 ? hx / c : Infinity;
  const ty = s > 1e-9 ? hy / s : Infinity;
  return Math.min(tx, ty);
}

/** Id of the nearest area shape whose bbox is within `dist` (default {@link
 *  BIND_DISTANCE}) of a point (0 if inside), or undefined — used for bind
 *  detection + hover highlight. Callers pass a zoom-scaled `dist` so the glue
 *  range stays screen-consistent at any camera scale. */
export function nearestBindableId(pt: { x: number; y: number }, shapes: Shape[], excludeId: string, dist = BIND_DISTANCE): string | undefined {
  let best: string | undefined;
  let bestD = dist;
  for (const sh of shapes) {
    if (sh.id === excludeId || !CONTAINER_TYPES.has(sh.type)) continue;
    const b = boundingBox(sh);
    const dx = Math.max(b.x - pt.x, 0, pt.x - (b.x + b.width));
    const dy = Math.max(b.y - pt.y, 0, pt.y - (b.y + b.height));
    const d = Math.hypot(dx, dy);
    if (d <= bestD) {
      bestD = d;
      best = sh.id;
    }
  }
  return best;
}

/** Id of the nearest area shape whose BORDER the point is near — within {@link
 *  EDGE_TOUCH} of the perimeter, inside OR outside — else undefined. Unlike
 *  {@link nearestBindableId}, the deep interior does NOT match: a box-drawing tool
 *  binds only edge-to-edge (never on mere containment), so its hover highlight must
 *  glow only near a border, not anywhere inside a big shape. */
export function nearestEdgeBindableId(pt: { x: number; y: number }, shapes: Shape[], excludeId: string, dist = EDGE_TOUCH): string | undefined {
  let best: string | undefined;
  let bestD = dist;
  for (const sh of shapes) {
    if (sh.id === excludeId || !CONTAINER_TYPES.has(sh.type)) continue;
    const b = boundingBox(sh);
    const outX = Math.max(b.x - pt.x, 0, pt.x - (b.x + b.width));
    const outY = Math.max(b.y - pt.y, 0, pt.y - (b.y + b.height));
    // Outside the bbox → distance to it; inside → distance to the nearest edge.
    const d =
      outX > 0 || outY > 0
        ? Math.hypot(outX, outY)
        : Math.min(pt.x - b.x, b.x + b.width - pt.x, pt.y - b.y, b.y + b.height - pt.y);
    if (d <= bestD) {
      bestD = d;
      best = sh.id;
    }
  }
  return best;
}

/** Bind a point near a shape, capturing its polar offset relative to the direction
 *  toward `other` (the other endpoint), so it keeps its drawn spot and rotates
 *  with the connection. Undefined if nothing is near enough. */
export function bindAt(pt: { x: number; y: number }, other: { x: number; y: number }, shapes: Shape[], excludeId: string, dist = BIND_DISTANCE): Bind | undefined {
  const id = nearestBindableId(pt, shapes, excludeId, dist);
  if (!id) return undefined;
  const shape = shapes.find((s) => s.id === id)!;
  const c = shapeCenter(shape);
  const dir = Math.atan2(other.y - c.y, other.x - c.x);
  const pointDir = Math.atan2(pt.y - c.y, pt.x - c.x);
  const gap = Math.hypot(pt.x - c.x, pt.y - c.y) - borderDist(shape, pointDir);
  return { id, angle: pointDir - dir, gap };
}

/** Recompute every bound arrow/line endpoint from its target's current center +
 *  the polar offset, using the OTHER end's shape center as the connection
 *  reference (so a two-bound connector swings to face between the two shapes).
 *  Drops bindings whose target is gone. Pure — call after any move/resize/delete. */
export function reflowBindings(shapes: Shape[]): Shape[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  let changed = false;
  const next = shapes.map((sh) => {
    if ((sh.type !== "line" && sh.type !== "arrow") || (!sh.bindStart && !sh.bindEnd)) return sh;
    let [x1, y1, x2, y2] = sh.points;
    let bindStart = sh.bindStart;
    let bindEnd = sh.bindEnd;
    const startShape = bindStart && byId.get(bindStart.id);
    const endShape = bindEnd && byId.get(bindEnd.id);
    if (bindStart) {
      if (!startShape) bindStart = undefined;
      else {
        const c = shapeCenter(startShape);
        const ref = endShape ? shapeCenter(endShape) : { x: x2, y: y2 };
        const dir = Math.atan2(ref.y - c.y, ref.x - c.x) + bindStart.angle;
        const r = borderDist(startShape, dir) + bindStart.gap;
        x1 = c.x + r * Math.cos(dir);
        y1 = c.y + r * Math.sin(dir);
      }
    }
    if (bindEnd) {
      if (!endShape) bindEnd = undefined;
      else {
        const c = shapeCenter(endShape);
        const ref = startShape ? shapeCenter(startShape) : { x: x1, y: y1 };
        const dir = Math.atan2(ref.y - c.y, ref.x - c.x) + bindEnd.angle;
        const r = borderDist(endShape, dir) + bindEnd.gap;
        x2 = c.x + r * Math.cos(dir);
        y2 = c.y + r * Math.sin(dir);
      }
    }
    const same = x1 === sh.points[0] && y1 === sh.points[1] && x2 === sh.points[2] && y2 === sh.points[3] && bindStart === sh.bindStart && bindEnd === sh.bindEnd;
    if (same) return sh;
    changed = true;
    return { ...sh, points: [x1, y1, x2, y2] as [number, number, number, number], bindStart, bindEnd };
  });
  return changed ? next : shapes;
}

export const ATTACH_DIST = 16;
// A child edge counts as "on" a parent side only when its edge is within this
// LITERAL near-touch distance of the parent's edge — a fixed tolerance, NOT a
// fraction of the parent. (A parent-proportional band made a shape resting deep
// inside a large shape count as edge-attached, so it bound + lit up on mere
// containment — the user's "merely placed inside shouldn't light up".) Kept a hair
// above ATTACH_DIST so a shape dragged snug against a border still binds.
export const EDGE_TOUCH = 24;

type Box = { x: number; y: number; width: number; height: number };

/** Which side/corner of the parent the child is pinned to, by EDGE proximity
 *  (works whether the child sits just inside, straddling, or just outside a
 *  parent edge — not a center-position band). ax/ay ∈ {0, 0.5, 1}; 0.5 = not
 *  pinned on that axis (the child is central along it → merely contained, not
 *  attached). */
function sideAnchor(c: Box, p: Box, touch = EDGE_TOUCH): { ax: number; ay: number } {
  const tx = touch;
  const ty = touch;
  const ccx = c.x + c.width / 2;
  const ccy = c.y + c.height / 2;
  const pcx = p.x + p.width / 2;
  const pcy = p.y + p.height / 2;
  const cR = c.x + c.width;
  const pR = p.x + p.width;
  const cB = c.y + c.height;
  const pB = p.y + p.height;
  // A vertical parent edge is "hit" if either child x-edge lands within tx of it.
  const nearRight = Math.min(Math.abs(c.x - pR), Math.abs(cR - pR)) <= tx;
  const nearLeft = Math.min(Math.abs(c.x - p.x), Math.abs(cR - p.x)) <= tx;
  const nearBottom = Math.min(Math.abs(c.y - pB), Math.abs(cB - pB)) <= ty;
  const nearTop = Math.min(Math.abs(c.y - p.y), Math.abs(cB - p.y)) <= ty;
  let ax = 0.5;
  if (nearRight && ccx >= pcx) ax = 1;
  else if (nearLeft && ccx <= pcx) ax = 0;
  let ay = 0.5;
  if (nearBottom && ccy >= pcy) ay = 1;
  else if (nearTop && ccy <= pcy) ay = 0;
  return { ax, ay };
}

/** Detect whether `child` is edge/corner-touching (or near, within {@link
 *  ATTACH_DIST}) an area shape and should attach to it — a box anchor for a
 *  rectangular parent (pinned to the nearest side/corner, inside or outside), a
 *  radial anchor for an ellipse. Returns undefined when the child is
 *  centered-inside (that's plain containment) or nothing is near. */
export function attachAt(child: Shape, shapes: Shape[], distScale = 1): Attach | undefined {
  if (isConnector(child)) return undefined; // connectors bind, they never attach
  const cb = boundingBox(child);
  const cc = { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 };
  let best: Shape | undefined;
  let bestAnchor = { ax: 0.5, ay: 0.5 };
  let bestGap = ATTACH_DIST * distScale;
  for (const sh of shapes) {
    if (sh.id === child.id || !CONTAINER_TYPES.has(sh.type)) continue;
    const b = boundingBox(sh);
    if (!b.width || !b.height) continue;
    const gx = Math.max(b.x - (cb.x + cb.width), cb.x - (b.x + b.width), 0);
    const gy = Math.max(b.y - (cb.y + cb.height), cb.y - (b.y + b.height), 0);
    const gap = Math.hypot(gx, gy);
    const anchor = sideAnchor(cb, b, EDGE_TOUCH * distScale);
    const pinned = anchor.ax !== 0.5 || anchor.ay !== 0.5;
    if (pinned && gap <= bestGap) {
      bestGap = gap;
      best = sh;
      bestAnchor = anchor;
    }
  }
  if (!best) return undefined;
  const b = boundingBox(best);
  if (best.type === "ellipse") {
    const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const angle = Math.atan2(cc.y - c.y, cc.x - c.x);
    return { id: best.id, kind: "radial", angle, gap: Math.hypot(cc.x - c.x, cc.y - c.y) - borderDist(best, angle) };
  }
  const { ax, ay } = bestAnchor;
  return { id: best.id, kind: "box", ax, ay, dx: cc.x - (b.x + ax * b.width), dy: cc.y - (b.y + ay * b.height) };
}

/** Move every attached shape so its center tracks the parent's current anchor —
 *  following the parent on move AND resize. Drops attachments whose parent is
 *  gone. `skip` = shapes being directly dragged (don't yank them back). A few
 *  passes handle shallow nesting. Pure. */
export function reflowAttachments(shapes: Shape[], skip: Set<string>): Shape[] {
  let result = shapes;
  let anyChange = false;
  for (let pass = 0; pass < 3; pass++) {
    const byId = new Map(result.map((s) => [s.id, s]));
    let passChanged = false;
    const next = result.map((sh) => {
      if (!sh.attach || skip.has(sh.id) || isConnector(sh)) return sh; // connectors reflow via bindings, not attach
      const parent = byId.get(sh.attach.id);
      if (!parent) {
        const { attach: _drop, ...rest } = sh;
        passChanged = true;
        return rest as Shape;
      }
      const pb = boundingBox(parent);
      let tx: number;
      let ty: number;
      if (sh.attach.kind === "box") {
        tx = pb.x + sh.attach.ax * pb.width + sh.attach.dx;
        ty = pb.y + sh.attach.ay * pb.height + sh.attach.dy;
      } else {
        const pc = { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 };
        const r = borderDist(parent, sh.attach.angle) + sh.attach.gap;
        tx = pc.x + r * Math.cos(sh.attach.angle);
        ty = pc.y + r * Math.sin(sh.attach.angle);
      }
      const cb = boundingBox(sh);
      const dx = tx - (cb.x + cb.width / 2);
      const dy = ty - (cb.y + cb.height / 2);
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return sh;
      passChanged = true;
      return offsetShape(sh, dx, dy);
    });
    if (!passChanged) break;
    result = next;
    anyChange = true;
  }
  return anyChange ? result : shapes;
}

/** Attachments move shapes, then bindings re-cling to the new positions. */
function reflowAll(shapes: Shape[], skip: Set<string>): Shape[] {
  return reflowBindings(reflowAttachments(shapes, skip));
}

/** Ids of shapes fully contained within any of the given container shapes' boxes
 *  (used to drag a container's contents along with it). Only area shapes act as
 *  containers; the containers themselves are excluded. */
export function containedIds(shapes: Shape[], containerIds: string[]): string[] {
  const boxes = containerIds
    .map((id) => shapes.find((s) => s.id === id))
    .filter((s): s is Shape => !!s && CONTAINER_TYPES.has(s.type))
    .map(boundingBox);
  if (!boxes.length) return [];
  const set = new Set(containerIds);
  const out: string[] = [];
  for (const sh of shapes) {
    if (set.has(sh.id)) continue;
    const b = boundingBox(sh);
    if (boxes.some((A) => b.x >= A.x && b.y >= A.y && b.x + b.width <= A.x + A.width && b.y + b.height <= A.y + A.height)) {
      out.push(sh.id);
    }
  }
  return out;
}

/** Drag-propagation weight ("largest drags smallest"): 0 for stroke-like shapes
 *  (pen/line/arrow — massless followers that never pull), else bounding-box area.
 *  Raw bbox area would misclassify an ENCIRCLING scribble or long diagonal stroke
 *  as "bigger" than the shape it annotates and strand it when that shape is grabbed;
 *  making strokes massless keeps them as pure followers (0 ≤ anything, and a 0
 *  threshold drags only other massless neighbors). Text keeps its bbox weight. */
export function clusterWeight(sh: Shape): number {
  if (sh.type === "pen" || sh.type === "line" || sh.type === "arrow") return 0;
  const b = boundingBox(sh);
  return b.width * b.height;
}

/** Which one-use cluster a shape belongs to (rect/ellipse → "shape";
 *  line/arrow → "line"), or null for pen/text/image. */
export function clusterOf(sh: Shape): "shape" | "line" | null {
  if (sh.type === "rect" || sh.type === "ellipse") return "shape";
  if (sh.type === "line" || sh.type === "arrow") return "line";
  return null;
}

/** A cluster shape's VARIANT identity — rect/ellipse, or line/arrow/darrow (a
 *  double-headed arrow is an `arrow` flagged `doubleHead`). Null if not a cluster
 *  shape. Used to drive selection retyping via the cluster tools. */
export function variantOf(sh: Shape): ShapeVariant | LineVariant | null {
  if (sh.type === "rect" || sh.type === "ellipse") return sh.type;
  if (sh.type === "line") return "line";
  if (sh.type === "arrow") return sh.doubleHead ? "darrow" : "arrow";
  return null;
}

/** Convert a cluster shape to another variant of the SAME cluster, preserving all
 *  geometry + metadata: rect↔ellipse swap `type` (identical box); line/arrow/darrow
 *  swap `type` + `doubleHead` (points/bindings ride along). The caller guarantees
 *  `target` belongs to `sh`'s cluster. */
export function toClusterVariant(sh: Shape, target: ShapeVariant | LineVariant): Shape {
  if (target === "rect" || target === "ellipse") return { ...(sh as BoxShape), type: target };
  if (target === "darrow") return { ...(sh as SegmentShape), type: "arrow", doubleHead: true };
  const { doubleHead: _drop, ...rest } = sh as SegmentShape;
  return { ...rest, type: target }; // "line" | "arrow" (no head-at-start)
}

/** Paint order for the canvas. Images are a BACKGROUND layer: every other (vector)
 *  shape always paints above every image, whatever their sizes — so a small rect
 *  glued behind a big image shows, and a large rect isn't buried by an image either.
 *  Within the image layer the larger image paints lower (smaller images stay visible
 *  on top — `clusterWeight` desc). Non-image shapes keep their INSERTION (draw)
 *  order and are NOT size-sorted among themselves. Stable + pure: the model array is
 *  untouched (undo/paste/hit-testing rely on its order); only the painted copy is
 *  reordered, so z tracks image size live as images resize. */
export function paintOrder(shapes: Shape[]): Shape[] {
  const images = shapes.filter((s) => s.type === "image").sort((a, b) => clusterWeight(b) - clusterWeight(a));
  const rest = shapes.filter((s) => s.type !== "image");
  return [...images, ...rest];
}

/** Undirected attach adjacency: every stored `attach` edge (child→parent) is added
 *  in BOTH directions, so propagation is direction-agnostic. Edges to a missing
 *  target are ignored. Arrow/line `bind` edges are NOT included (they re-cling via
 *  {@link reflowBindings}, they don't drag). */
function attachAdjacency(shapes: Shape[]): Map<string, Set<string>> {
  const ids = new Set(shapes.map((s) => s.id));
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = adj.get(a);
    if (!set) adj.set(a, (set = new Set()));
    set.add(b);
  };
  for (const sh of shapes) {
    if (sh.attach && ids.has(sh.attach.id) && !isConnector(sh)) {
      link(sh.id, sh.attach.id);
      link(sh.attach.id, sh.id);
    }
  }
  return adj;
}

const CLUSTER_EPS = 1e-6;

/**
 * The full set of shape ids a MOVE of `seedIds` drags along ("largest drags
 * smallest"):
 *  - every seed always moves (grabbing = precedence — selection overrides size);
 *  - from each seed, BFS over the UNDIRECTED attach graph, crossing into a
 *    neighbor iff `clusterWeight(neighbor) <= clusterWeight(seed) + eps` — a
 *    heavier node blocks its whole subtree (equal weight comes along);
 *  - plus everything geometrically contained in any dragged container.
 * BFS is per-seed with its own threshold + its own visited set (a node rejected
 * for a small seed must still be reachable from a bigger seed; the visited set
 * also guarantees termination on legacy cyclic `attach` data). Pure; O(shapes²)
 * worst case, but shape counts are tiny. */
export function moveClusterIds(shapes: Shape[], seedIds: string[]): string[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const adj = attachAdjacency(shapes);
  const cluster = new Set<string>();
  for (const seedId of seedIds) {
    const seed = byId.get(seedId);
    if (!seed) continue;
    cluster.add(seedId);
    const threshold = clusterWeight(seed) + CLUSTER_EPS;
    const visited = new Set<string>([seedId]);
    const queue = [seedId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of adj.get(cur) ?? []) {
        if (visited.has(nb)) continue;
        visited.add(nb); // mark even if blocked → a heavier node blocks its subtree
        const nbShape = byId.get(nb);
        if (nbShape && clusterWeight(nbShape) <= threshold) {
          cluster.add(nb);
          queue.push(nb);
        }
      }
    }
  }
  for (const id of containedIds(shapes, [...cluster])) cluster.add(id);
  return [...cluster];
}

/**
 * Build the ghost shape list for a resize of `id` to `box`, plus the synthesized
 * inverted anchors to restore afterwards. The resized shape's geometry is replaced
 * with `box` (box shapes only — a text shape already carries its patch and uses its
 * derived bbox). When the resized shape ITSELF holds the edge (`S.attach = N`), a
 * temporary INVERTED anchor is synthesized on N (computed from the PRE-gesture
 * snapshot via `attachAt(N_pre, [S_pre])` — D9, never per-frame) so the neighbor
 * follows regardless of which side stored the edge. Applied ONLY when N has no real
 * `attach`: a legacy 2-cycle in-edge already reflows N self-consistently, and an
 * edge to a THIRD shape is left alone (never overwrite a real edge). */
function resizeGhost(
  shapes: Shape[],
  base: Shape[] | null,
  id: string,
  box: Box,
  distScale = 1
): { ghost: Shape[]; synthesized: Map<string, Attach | undefined> } {
  const snap = base ?? shapes;
  const synthesized = new Map<string, Attach | undefined>();
  const S = shapes.find((sh) => sh.id === id);
  if (!S) return { ghost: shapes, synthesized };
  let ghost = shapes.map((sh) => {
    if (sh.id !== id) return sh;
    if (sh.type === "rect" || sh.type === "ellipse" || sh.type === "image") {
      return { ...sh, x: box.x, y: box.y, width: box.width, height: box.height } as Shape;
    }
    return sh; // text: no box field — its bbox already reflects the patch
  });
  if (S.attach) {
    const N = ghost.find((sh) => sh.id === S.attach!.id);
    if (N && N.attach === undefined) {
      const Nbase = snap.find((sh) => sh.id === N.id);
      const Sbase = snap.find((sh) => sh.id === S.id);
      const inv = Nbase && Sbase ? attachAt(Nbase, [Sbase], distScale) : undefined;
      if (inv) {
        synthesized.set(N.id, N.attach); // original (undefined) → restore after reflow
        ghost = ghost.map((sh) => (sh.id === N.id ? ({ ...sh, attach: inv } as Shape) : sh));
      }
    }
  }
  return { ghost, synthesized };
}

/** Undo {@link resizeGhost}'s synthesized anchors — the inverted edge is per-op,
 *  never persisted (restore each id's original `attach`, usually `undefined`). */
function restoreSynthesized(shapes: Shape[], synthesized: Map<string, Attach | undefined>): Shape[] {
  if (!synthesized.size) return shapes;
  return shapes.map((sh) => {
    if (!synthesized.has(sh.id)) return sh;
    const orig = synthesized.get(sh.id);
    if (orig === undefined) {
      if (sh.attach === undefined) return sh;
      const { attach: _drop, ...rest } = sh;
      return rest as Shape;
    }
    return { ...sh, attach: orig };
  });
}

/** Refresh a resized shape's OWN stored anchor from its final geometry (fixes
 *  snap-back): keep a fresh anchor if still pinned to the live target, else DROP
 *  the edge (resized away). Only rewrites `attach` metadata — never moves the
 *  shape. */
function refreshOwnAnchor(shapes: Shape[], id: string, distScale = 1): Shape[] {
  return mapShapes(shapes, new Set([id]), (sh) => {
    if (!sh.attach) return sh;
    const target = shapes.find((o) => o.id === sh.attach!.id);
    const at = target ? attachAt(sh, [target], distScale) : undefined;
    if (at) return { ...sh, attach: at };
    const { attach: _drop, ...rest } = sh;
    return rest as Shape;
  });
}

export type DrawAction =
  | { type: "setTool"; tool: Tool }
  // Arm a one-use cluster (shape = rect/ellipse, line = line/arrow/double-arrow):
  // select its last-used variant, or — if this cluster is already the active tool —
  // cycle to the next variant. One key/button both selects and switches.
  | { type: "armCluster"; cluster: "shape" | "line" }
  | { type: "setColor"; color: string }
  | { type: "setStrokeWidth"; width: number }
  | { type: "select"; ids: string[] }
  | { type: "toggleSelect"; id: string }
  // Set the logical canvas size (blank sketch fills its container on open — done
  // once, before anything is drawn, so no shape coordinates need remapping).
  | { type: "resizeCanvas"; width: number; height: number }
  // Resize the blank board to track its container, keeping content CENTERED:
  // shift everything (and the whole history) by half the size delta so widening
  // grows from the center and narrowing trims both sides evenly.
  | { type: "resizeCanvasCentered"; width: number; height: number }
  // Gesture lifecycle (draw a new shape, or move/resize existing ones).
  | { type: "beginDraw"; shape: Shape }
  | { type: "updateDraw"; point: { x: number; y: number } }
  | { type: "extendFreehand"; point: { x: number; y: number } }
  // `minSize` (logical px, default 2) is the degenerate-draft threshold — the view
  // passes a zoom-scaled value so a click-no-drag is judged in SCREEN pixels.
  // `distScale` scales the bind/attach glue distances the same way.
  | { type: "endDraw"; minSize?: number; distScale?: number }
  // Abort the in-progress draft outright (e.g. a second finger landed → the
  // gesture becomes a pinch): restore the pre-draw shapes, no history entry.
  | { type: "cancelDraw" }
  | { type: "beginGesture" }
  | { type: "patchShape"; id: string; patch: Partial<Shape> }
  // Bake a Transformer resize into geometry: apply `patch` to the resized shape,
  // then drag its direction-agnostic neighbors (§2.5) and refresh its own anchor.
  // History-NEUTRAL — the surrounding gesture's endGesture owns the single push.
  // `distScale` keeps the anchor keep-or-drop judgment screen-true (an edge glued
  // at zoom-out must survive a resize judged at the same zoom).
  | { type: "commitResize"; id: string; patch: Partial<Shape>; distScale?: number }
  | { type: "translateShapes"; ids: string[]; dx: number; dy: number }
  // Re-detect shape-to-shape attachments for the given (just-moved) shapes.
  | { type: "reattach"; ids: string[]; distScale?: number }
  // LIVE resize preview: reflow attached/bound children as if `parentId` had
  // `box`, WITHOUT changing the parent itself (its node is mid-Transformer).
  | { type: "reflowChildrenTo"; parentId: string; box: { x: number; y: number; width: number; height: number }; distScale?: number }
  | { type: "endGesture" }
  // Discrete, self-contained commits (own their history push). `detectAttach`
  // (default false) auto-attaches each added shape (without one) to a pre-existing
  // shape it's placed edge-to-edge with — enabled for a single piece of NEW
  // external content (a placed text/image), OFF for paste + multi-file cascades
  // (their fixed offsets sit within ATTACH_DIST and would weld every copy).
  | { type: "addShapes"; shapes: Shape[]; detectAttach?: boolean; distScale?: number }
  // Apply an image crop (new display box + source crop region), reversible.
  | { type: "cropImage"; id: string; box: { x: number; y: number; width: number; height: number }; crop?: { x: number; y: number; width: number; height: number }; distScale?: number }
  | { type: "setText"; id: string; text: string }
  | { type: "deleteSelected" }
  | { type: "deleteShapes"; ids: string[] }
  | { type: "clearAll" }
  | { type: "undo" }
  | { type: "redo" };

/** Push `shapes` onto the undo stack and clear redo — for a discrete commit. */
function commit(s: DrawState, nextShapes: Shape[]): DrawState {
  return { ...s, shapes: nextShapes, past: [...s.past, s.shapes], future: [] };
}

function mapShapes(shapes: Shape[], ids: Set<string>, fn: (sh: Shape) => Shape): Shape[] {
  return shapes.map((sh) => (ids.has(sh.id) ? fn(sh) : sh));
}

/** Shift a shape by (dx,dy) — used by the reducer's move and by clipboard paste. */
export function offsetShape(sh: Shape, dx: number, dy: number): Shape {
  switch (sh.type) {
    case "line":
    case "arrow":
      return {
        ...sh,
        points: [sh.points[0] + dx, sh.points[1] + dy, sh.points[2] + dx, sh.points[3] + dy],
      };
    case "pen":
      return { ...sh, points: sh.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) };
    default:
      return { ...sh, x: sh.x + dx, y: sh.y + dy };
  }
}
const translate = offsetShape;

/** Clone a clipboard batch for paste: fresh ids, translated by (dx,dy). Intra-batch
 *  `attach` and arrow/line `bindStart`/`bindEnd` whose targets are inside the batch
 *  are REMAPPED to the new ids and kept (copy a glued assembly → paste a glued
 *  assembly; both endpoints move by the same offset, so kept edges stay valid);
 *  edges to shapes OUTSIDE the batch are dropped. No attach re-detection (the paste
 *  offset sits within ATTACH_DIST — detecting would weld every copy to its original). */
export function clonePastedShapes(clipboard: Shape[], dx: number, dy: number, newId: () => string): Shape[] {
  const idMap = new Map<string, string>();
  for (const sh of clipboard) idMap.set(sh.id, newId());
  return clipboard.map((sh) => {
    const clone = offsetShape(cloneShape(sh), dx, dy);
    clone.id = idMap.get(sh.id)!;
    if (clone.attach) {
      const mapped = idMap.get(clone.attach.id);
      clone.attach = mapped ? { ...clone.attach, id: mapped } : undefined;
    }
    if (clone.type === "line" || clone.type === "arrow") {
      if (clone.bindStart) {
        const m = idMap.get(clone.bindStart.id);
        clone.bindStart = m ? { ...clone.bindStart, id: m } : undefined;
      }
      if (clone.bindEnd) {
        const m = idMap.get(clone.bindEnd.id);
        clone.bindEnd = m ? { ...clone.bindEnd, id: m } : undefined;
      }
    }
    return clone;
  });
}

const keepExisting = (ids: string[], shapes: Shape[]) => ids.filter((id) => shapes.some((sh) => sh.id === id));

export function drawReducer(s: DrawState, a: DrawAction): DrawState {
  switch (a.type) {
    case "setTool":
      // Leaving select drops the selection (its handles shouldn't linger while
      // drawing). Picking a selectable tool remembers it as the snap-back base;
      // picking a cluster variant directly updates that cluster's memory.
      return {
        ...s,
        tool: a.tool,
        baseTool: isSelectable(a.tool) ? a.tool : s.baseTool,
        selectedIds: a.tool === "select" ? s.selectedIds : [],
        shapeVariant: a.tool === "rect" || a.tool === "ellipse" ? a.tool : s.shapeVariant,
        lineVariant: a.tool === "line" || a.tool === "arrow" || a.tool === "darrow" ? a.tool : s.lineVariant,
      };
    case "armCluster": {
      const members: readonly Tool[] = a.cluster === "shape" ? SHAPE_VARIANTS : LINE_VARIANTS;
      const remembered = a.cluster === "shape" ? s.shapeVariant : s.lineVariant;

      // Selection retype: when the selection is non-empty and lies ENTIRELY within
      // this cluster (all shapes, all connectors, or a single one), the cluster tool
      // retypes the SELECTION instead of arming a draw tool — first unifying every
      // selected shape to the cluster's current variant, then (once they all match)
      // cycling them to the next variant. Selection + tool are kept so repeated taps
      // keep cycling. Undoable (commit).
      const sel = s.shapes.filter((sh) => s.selectedIds.includes(sh.id));
      if (sel.length > 0 && sel.every((sh) => clusterOf(sh) === a.cluster)) {
        const allMatch = sel.every((sh) => variantOf(sh) === remembered);
        const idx = members.indexOf(remembered);
        const target = (allMatch ? members[(idx + 1) % members.length] : remembered) as ShapeVariant | LineVariant;
        const retyped = reflowAll(mapShapes(s.shapes, new Set(s.selectedIds), (sh) => toClusterVariant(sh, target)), new Set());
        return {
          ...commit(s, retyped),
          ...(a.cluster === "shape" ? { shapeVariant: target as ShapeVariant } : { lineVariant: target as LineVariant }),
        };
      }

      // No matching selection → arm/cycle the DRAW tool: arm the remembered variant,
      // or (if this cluster is already the active tool) advance to the next variant —
      // one key/button selects AND cycles. A drawn shape later resets `tool` to
      // `baseTool`, but the remembered variant survives so the next arm returns to it.
      const armedIdx = members.indexOf(s.tool);
      const next = armedIdx >= 0 ? members[(armedIdx + 1) % members.length] : remembered;
      return {
        ...s,
        tool: next,
        selectedIds: [],
        ...(a.cluster === "shape" ? { shapeVariant: next as ShapeVariant } : { lineVariant: next as LineVariant }),
      };
    }
    case "setColor": {
      // Mid-draw: live-recolor the in-progress draft (no history — the draw
      // gesture will commit it). Otherwise recolor the selection (undoable).
      if (s.draftId) {
        return { ...s, color: a.color, shapes: mapShapes(s.shapes, new Set([s.draftId]), (sh) => ({ ...sh, stroke: a.color })) };
      }
      if (s.selectedIds.length) {
        return { ...commit(s, mapShapes(s.shapes, new Set(s.selectedIds), (sh) => ({ ...sh, stroke: a.color }))), color: a.color };
      }
      return { ...s, color: a.color };
    }
    case "setStrokeWidth": {
      if (s.draftId) {
        return { ...s, strokeWidth: a.width, shapes: mapShapes(s.shapes, new Set([s.draftId]), (sh) => ({ ...sh, strokeWidth: a.width })) };
      }
      if (s.selectedIds.length) {
        // For text the stroke slots mean font size (small/medium/large).
        return {
          ...commit(s, mapShapes(s.shapes, new Set(s.selectedIds), (sh) =>
            sh.type === "text" ? { ...sh, fontSize: fontForStroke(a.width) } : { ...sh, strokeWidth: a.width }
          )),
          strokeWidth: a.width,
        };
      }
      return { ...s, strokeWidth: a.width };
    }
    case "resizeCanvas":
      return { ...s, width: a.width, height: a.height };
    case "resizeCanvasCentered": {
      if (a.width === s.width && a.height === s.height) return s;
      const dx = (a.width - s.width) / 2;
      const dy = (a.height - s.height) / 2;
      const shift = (arr: Shape[]) => arr.map((sh) => offsetShape(sh, dx, dy));
      // Shift the live shapes AND the whole undo/redo history so every snapshot
      // stays in the current coordinate frame (undo after a resize stays correct).
      return {
        ...s,
        width: a.width,
        height: a.height,
        shapes: reflowBindings(shift(s.shapes)),
        past: s.past.map(shift),
        future: s.future.map(shift),
        gestureBase: s.gestureBase ? shift(s.gestureBase) : null,
      };
    }
    case "select":
      return { ...s, selectedIds: a.ids };
    case "toggleSelect":
      return {
        ...s,
        selectedIds: s.selectedIds.includes(a.id) ? s.selectedIds.filter((id) => id !== a.id) : [...s.selectedIds, a.id],
      };

    case "beginDraw":
      // Start a draw gesture: stash the pre-draw snapshot, append the draft.
      return {
        ...s,
        shapes: [...s.shapes, a.shape],
        draftId: a.shape.id,
        gestureBase: s.shapes,
        selectedIds: [],
      };
    case "updateDraw": {
      if (!s.draftId) return s;
      const id = new Set([s.draftId]);
      return {
        ...s,
        shapes: mapShapes(s.shapes, id, (sh) => {
          if (sh.type === "rect" || sh.type === "ellipse") {
            return { ...sh, width: a.point.x - sh.x, height: a.point.y - sh.y };
          }
          if (sh.type === "line" || sh.type === "arrow") {
            return { ...sh, points: [sh.points[0], sh.points[1], a.point.x, a.point.y] };
          }
          return sh;
        }),
      };
    }
    case "extendFreehand": {
      if (!s.draftId) return s;
      return {
        ...s,
        shapes: mapShapes(s.shapes, new Set([s.draftId]), (sh) =>
          sh.type === "pen" ? { ...sh, points: [...sh.points, a.point.x, a.point.y] } : sh
        ),
      };
    }
    case "endDraw": {
      if (!s.draftId) return s;
      const draft = s.shapes.find((sh) => sh.id === s.draftId);
      const base = s.gestureBase ?? s.shapes;
      const distScale = a.distScale ?? 1;
      // Drop a degenerate draft (a click that didn't drag).
      if (draft && isDegenerate(draft, a.minSize ?? 2)) {
        return { ...s, shapes: base, draftId: null, gestureBase: null };
      }
      let normalized = s.shapes;
      if (draft && (draft.type === "rect" || draft.type === "ellipse")) {
        normalized = mapShapes(s.shapes, new Set([draft.id]), (sh) => normalizeBox(sh as BoxShape));
        // A shape drawn edge-to-edge with another attaches to it (like an arrow
        // binds) — so drawing a box on/against a shape links them.
        const drawn = normalized.find((sh) => sh.id === draft.id)!;
        const attach = attachAt(drawn, normalized, distScale);
        if (attach) normalized = mapShapes(normalized, new Set([draft.id]), (sh) => ({ ...sh, attach } as Shape));
      } else if (draft && (draft.type === "line" || draft.type === "arrow")) {
        // Bind each endpoint drawn near an area shape, capturing its polar offset
        // relative to the other endpoint — stays where drawn, rotates on move.
        const [x1, y1, x2, y2] = draft.points;
        const bindStart = bindAt({ x: x1, y: y1 }, { x: x2, y: y2 }, s.shapes, draft.id, BIND_DISTANCE * distScale);
        const bindEnd = bindAt({ x: x2, y: y2 }, { x: x1, y: y1 }, s.shapes, draft.id, BIND_DISTANCE * distScale);
        normalized = mapShapes(s.shapes, new Set([draft.id]), (sh) => ({ ...sh, bindStart, bindEnd } as Shape));
      } else if (draft && draft.type === "pen") {
        // A scribble drawn edge-to-edge with a shape attaches to it (like a box) —
        // so annotating a shape with a stroke glues them (it's massless: it follows
        // but never pulls). (attachAt skips the draft itself.)
        const attach = attachAt(draft, s.shapes, distScale);
        if (attach) normalized = mapShapes(s.shapes, new Set([draft.id]), (sh) => ({ ...sh, attach } as Shape));
      }
      // Pen is a persistent tool (stay in it). A one-use shape tool snaps back to
      // the last selectable — auto-selecting the new shape only if we return to
      // the cursor (in pen we don't want a lingering selection).
      const oneUse = !!draft && draft.type !== "pen";
      const nextTool: Tool = oneUse ? s.baseTool : s.tool;
      return {
        ...s,
        shapes: normalized,
        tool: nextTool,
        draftId: null,
        gestureBase: null,
        past: [...s.past, base],
        future: [],
        selectedIds: draft && nextTool === "select" ? [draft.id] : [],
      };
    }

    case "cancelDraw": {
      if (!s.draftId) return s;
      return { ...s, shapes: s.gestureBase ?? s.shapes.filter((sh) => sh.id !== s.draftId), draftId: null, gestureBase: null };
    }

    case "beginGesture":
      return { ...s, gestureBase: s.shapes };
    case "patchShape":
      return { ...s, shapes: reflowAll(mapShapes(s.shapes, new Set([a.id]), (sh) => ({ ...sh, ...a.patch } as Shape)), new Set()) };
    case "translateShapes": {
      const ids = new Set(a.ids);
      // NEW LAW (§2.2): an attached shape follows a move ONLY by being in `ids`
      // (the view passes the full size-gated cluster via moveClusterIds). A shape
      // OUTSIDE `ids` whose `attach` points INTO the moved set was deliberately
      // excluded (too heavy) — FREEZE it so the reflow doesn't drag it toward the
      // moved parent. (Transitive freeze is unnecessary: a frozen shape doesn't
      // move, so its own followers' targets don't move either.) Bound arrows still
      // re-cling via reflowBindings.
      const frozen = s.shapes.filter((sh) => sh.attach && ids.has(sh.attach.id) && !ids.has(sh.id)).map((sh) => sh.id);
      return { ...s, shapes: reflowAll(mapShapes(s.shapes, ids, (sh) => translate(sh, a.dx, a.dy)), new Set([...ids, ...frozen])) };
    }
    case "reflowChildrenTo": {
      // LIVE resize frame: reflow children AND direction-agnostic neighbors against
      // a ghost parent (the live-resizing box), then keep the REAL parent geometry
      // — the Transformer owns its node during the drag (never touch it here, or it
      // resizes from both sides). Restore any synthesized inverted anchor.
      const { ghost, synthesized } = resizeGhost(s.shapes, s.gestureBase, a.parentId, a.box, a.distScale ?? 1);
      const reflowed = restoreSynthesized(reflowAll(ghost, new Set([a.parentId])), synthesized);
      const byId = new Map(reflowed.map((r) => [r.id, r]));
      const next = s.shapes.map((sh) => (sh.id === a.parentId ? sh : byId.get(sh.id) ?? sh));
      return { ...s, shapes: next };
    }
    case "commitResize": {
      // 1. Apply the patch — the resized shape (S) is final now.
      const patched = mapShapes(s.shapes, new Set([a.id]), (sh) => ({ ...sh, ...a.patch } as Shape));
      const S = patched.find((sh) => sh.id === a.id);
      if (!S) return s;
      // 2. Direction-agnostic follow (skip=S so S stays EXACTLY where the user left
      //    it — no snap-back); inverted anchor from the pre-gesture snapshot (D9).
      const { ghost, synthesized } = resizeGhost(patched, s.gestureBase, a.id, boundingBox(S), a.distScale ?? 1);
      let next = restoreSynthesized(reflowAll(ghost, new Set([a.id])), synthesized);
      // 3. Refresh S's OWN anchor (drop if resized away). 4. Arrows re-cling.
      next = reflowBindings(refreshOwnAnchor(next, a.id, a.distScale ?? 1));
      // 5. History-neutral (endGesture owns the push — a commit() here double-pushes).
      return { ...s, shapes: next };
    }
    case "reattach": {
      const moved = new Set(a.ids);
      const distScale = a.distScale ?? 1;
      let next = mapShapes(s.shapes, moved, (sh) => {
        // A kept INTRA-cluster edge: the parent rode along rigidly, so the relative
        // anchor is still valid — preserve it verbatim (fixes latent bug #3, where
        // dragging a glued parent+child together dropped their edge).
        if (sh.attach && moved.has(sh.attach.id)) return sh;
        // A CROSSING edge: re-detect against non-moved candidates (a moved group
        // shouldn't attach to itself), avoiding a 2-cycle back onto this shape.
        const at = attachAt(sh, s.shapes.filter((o) => !moved.has(o.id) && o.attach?.id !== sh.id), distScale);
        if (at) return { ...sh, attach: at };
        return sh.attach ? { ...sh, attach: undefined } : sh;
      });
      // Stayers whose parent departed (their edge crossed the boundary the OTHER
      // way — they were too heavy to be dragged): re-evaluate from their unchanged
      // spot; keep a new adjacency if one exists, else drop the now-stale edge.
      const staleIds = new Set(next.filter((sh) => !moved.has(sh.id) && sh.attach && moved.has(sh.attach.id)).map((sh) => sh.id));
      next = mapShapes(next, staleIds, (sh) => {
        const at = attachAt(sh, next.filter((o) => o.id !== sh.id && o.attach?.id !== sh.id), distScale);
        return { ...sh, attach: at }; // at may be undefined → detached
      });
      return { ...s, shapes: reflowAll(next, new Set()) };
    }
    case "endGesture": {
      const base = s.gestureBase;
      if (!base) return s;
      const changed = base !== s.shapes && !shapesEqual(base, s.shapes);
      return {
        ...s,
        gestureBase: null,
        past: changed ? [...s.past, base] : s.past,
        future: changed ? [] : s.future,
      };
    }

    case "addShapes": {
      if (a.shapes.length === 0) return s;
      // Attach-detection (opt-in) runs against PRE-EXISTING shapes only (never the
      // same batch — no self-gluing/cycles; keeps the 2-cycle guard).
      const added = a.detectAttach
        ? a.shapes.map((sh) => {
            if (sh.attach) return sh;
            const at = attachAt(sh, s.shapes.filter((o) => o.attach?.id !== sh.id), a.distScale ?? 1);
            return at ? ({ ...sh, attach: at } as Shape) : sh;
          })
        : a.shapes;
      return { ...commit(s, [...s.shapes, ...added]), selectedIds: added.map((sh) => sh.id) };
    }
    case "cropImage": {
      if (!s.shapes.some((sh) => sh.id === a.id && sh.type === "image")) return s;
      // A crop is a resize in disguise: same direction-agnostic follow + own-anchor
      // refresh as commitResize, but with its OWN history push (no surrounding
      // gesture) and base=null → the inverted anchor is computed from the pre-crop
      // shapes (no live-follow preceded it).
      const { ghost, synthesized } = resizeGhost(s.shapes, null, a.id, a.box, a.distScale ?? 1);
      const ghostCropped = mapShapes(ghost, new Set([a.id]), (sh) => (sh.type === "image" ? ({ ...sh, crop: a.crop } as Shape) : sh));
      let next = restoreSynthesized(reflowAll(ghostCropped, new Set([a.id])), synthesized);
      next = reflowBindings(refreshOwnAnchor(next, a.id, a.distScale ?? 1));
      return commit(s, next);
    }
    case "setText": {
      const next = mapShapes(s.shapes, new Set([a.id]), (sh) => (sh.type === "text" ? { ...sh, text: a.text } : sh));
      return commit(s, next);
    }
    case "deleteSelected": {
      // Keyboard-only path — ignored while a pointer gesture is in flight (a
      // mid-drag delete would interleave a commit inside the open gesture and
      // corrupt the history pair).
      if (s.gestureBase || s.selectedIds.length === 0) return s;
      const gone = new Set(s.selectedIds);
      return { ...commit(s, reflowAll(s.shapes.filter((sh) => !gone.has(sh.id)), new Set())), selectedIds: [] };
    }
    case "deleteShapes": {
      const gone = new Set(a.ids);
      if (![...gone].some((id) => s.shapes.some((sh) => sh.id === id))) return s;
      const next = reflowAll(s.shapes.filter((sh) => !gone.has(sh.id)), new Set());
      const selectedIds = s.selectedIds.filter((id) => !gone.has(id));
      // Inside a gesture (an eraser DRAG), the change rides it: endGesture pushes
      // the whole swipe as ONE history entry instead of one per erased shape.
      if (s.gestureBase) return { ...s, shapes: next, selectedIds };
      return { ...commit(s, next), selectedIds };
    }
    case "clearAll": {
      if (s.shapes.length === 0) return s;
      return { ...commit(s, []), selectedIds: [] };
    }

    case "undo": {
      // No history moves while a gesture/draft is in flight: an undo mid-drag
      // nulls the gesture's base (its endGesture then can't push), and an undo
      // mid-draft would shove the half-drawn draft into `future` for redo to
      // resurrect. Release first, then undo.
      if (s.gestureBase || s.draftId) return s;
      if (s.past.length === 0) return s;
      const prev = s.past[s.past.length - 1];
      return {
        ...s,
        shapes: prev,
        past: s.past.slice(0, -1),
        future: [s.shapes, ...s.future],
        selectedIds: keepExisting(s.selectedIds, prev),
        draftId: null,
        gestureBase: null,
      };
    }
    case "redo": {
      if (s.gestureBase || s.draftId) return s; // symmetric with undo
      if (s.future.length === 0) return s;
      const next = s.future[0];
      return {
        ...s,
        shapes: next,
        past: [...s.past, s.shapes],
        future: s.future.slice(1),
        selectedIds: keepExisting(s.selectedIds, next),
        draftId: null,
        gestureBase: null,
      };
    }
    default:
      return s;
  }
}

function isDegenerate(sh: Shape, minSize = 2): boolean {
  switch (sh.type) {
    case "rect":
    case "ellipse":
      return Math.abs(sh.width) < minSize && Math.abs(sh.height) < minSize;
    case "line":
    case "arrow": {
      const [x1, y1, x2, y2] = sh.points;
      return Math.abs(x2 - x1) < minSize && Math.abs(y2 - y1) < minSize;
    }
    case "pen": {
      if (sh.points.length < 4) return true; // fewer than 2 points
      if (minSize <= 2) return false; // legacy threshold: any real stroke counts
      // Zoomed out, an accidental micro-drag still produces multiple points —
      // judge the stroke's extent against the (zoom-scaled) threshold instead.
      const b = boundingBox(sh);
      return b.width < minSize && b.height < minSize;
    }
    case "text":
      return sh.text.trim().length === 0;
    case "image":
      return false; // images are added directly, never via a draw gesture
  }
}

function shapesEqual(a: Shape[], b: Shape[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

export const canUndo = (s: DrawState) => s.past.length > 0;
export const canRedo = (s: DrawState) => s.future.length > 0;

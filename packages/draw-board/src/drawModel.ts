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

import { textBlockSize } from "./textMetrics.ts";

export const TOOLS = ["select", "pen", "rect", "ellipse", "diamond", "line", "arrow", "darrow", "text", "eraser"] as const;
export type Tool = (typeof TOOLS)[number];

/** Tools that place a shape by dragging (not select/text/eraser). */
export const DRAW_TOOLS: readonly Tool[] = ["pen", "rect", "ellipse", "diamond", "line", "arrow", "darrow"];

/** Every shape KIND a host can enable/disable ({@link DrawFeatures.shapes}) —
 *  the drag-drawn tools plus text. Select/eraser are board verbs, not shapes,
 *  and are never gated. */
export const SHAPE_TOOLS = ["pen", "rect", "ellipse", "diamond", "line", "arrow", "darrow", "text"] as const satisfies readonly Tool[];
export type ShapeTool = (typeof SHAPE_TOOLS)[number];
export const isShapeTool = (t: Tool): t is ShapeTool => (SHAPE_TOOLS as readonly Tool[]).includes(t);

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

/** A glue edge parked in a member's `dormant` stash when a group formed (an
 *  internal edge that crossed between the forming group's child units). Keyed by
 *  the group `gid` (level-keyed — nesting stashes at each level independently);
 *  restored ONLY by that gid's ungroup, and only into an empty slot (a live edge
 *  stamped during the group's life wins). Invisible to all reflow/adjacency
 *  consumers. See docs/groups-design.md. */
export type DormantEdge = { gid: string; attach?: Attach; bindStart?: Bind; bindEnd?: Bind };

/** Stroke rendering styles, in the cycle order the toolbar / the 4 key walk. */
export const STROKE_STYLES = ["solid", "dashed", "dotted"] as const;
export type StrokeStyle = (typeof STROKE_STYLES)[number];

export interface BaseShape {
  id: string;
  /** Stroke color (also the fill for text). */
  stroke: string;
  strokeWidth: number;
  /** Stroke rendering style; absent = solid (keeps persisted docs slim). */
  strokeStyle?: StrokeStyle;
  /** @deprecated Legacy bound caption — the feature is gone (free text shapes
   *  bond to shapes instead). Kept in the type so old persisted docs still
   *  parse; every load path converts it via {@link migrateLabels}. */
  label?: string;
  /** Attachment to a parent shape (see {@link Attach}), or none. */
  attach?: Attach;
  /** Group ancestry, ROOT FIRST. Absent = ungrouped. A group exists only as the
   *  set of shapes sharing a path prefix — there are no group objects
   *  (docs/groups-design.md). */
  groupPath?: string[];
  /** Level-keyed stash of glue edges parked when each enclosing group formed
   *  (see {@link DormantEdge}). */
  dormant?: DormantEdge[];
  /** Size-CONTROL steps from the natural size (×1.2 each; absent = 0 = natural
   *  "medium"). Only the size dots / -= keys write it, for a whole group
   *  (uniform across members) or a lone image — so the control can render the
   *  unit's remembered position and "mid" can reset to the natural size.
   *  Manual transformer resizes leave it alone (they change the natural size,
   *  not the control steps); group/ungroup strip it (natural rebases). */
  sizeStep?: number;
}
/** Rect + ellipse + diamond share an axis-aligned bounding box {x,y,width,height}.
 *  The view converts an ellipse box to Konva's center+radii and a diamond to its
 *  four edge-midpoint vertices ({@link diamondPoints}); keeping the box form here
 *  makes all three uniform and resize trivial. width/height may be negative
 *  mid-draw (dragged up/left) — `normalizeBox` fixes sign at commit. */
export interface BoxShape extends BaseShape {
  type: "rect" | "ellipse" | "diamond";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Interior fill color, or none (absent). Regular ink options only — never
   *  the adaptive contrast sentinel: contrast is stroke-only, and fills are
   *  what it contrasts AGAINST (they join the sampled background). */
  fill?: string;
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
  /** Interior fill for an ENCLOSED doodle (see {@link isEnclosed}) — stored
   *  regardless, rendered only while the loop is closed, so extending the
   *  stroke can open/close the fill without losing the choice. */
  fill?: string;
}
export interface TextShape extends BaseShape {
  type: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
  /** Wrap-box width (model units) — present once the text is a BOX: stamped by
   *  a parent-capped edit whose text actually wrapped, or by an explicit
   *  side-handle resize. Absent = auto width (lines break only at explicit
   *  newlines). Lines re-wrap from `text` wherever they're rendered — the
   *  stored text is always the unwrapped source. */
  width?: number;
  /** Background highlight painted behind the block (see {@link textBgBox}) —
   *  purely visual: layout/hit/attach metrics stay the bare block. */
  fill?: string;
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
 *  armed cycles to the next variant (rect→ellipse→diamond, line→arrow→double-arrow).
 *  Drawing snaps the tool back to `baseTool`, but the remembered variant persists
 *  (see {@link DrawState.shapeVariant}/`lineVariant` + the `armCluster` action). */
export const SHAPE_VARIANTS = ["rect", "ellipse", "diamond"] as const;
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
  /** Ambient fill for new shapes (rect/ellipse/pen/text bg), or none. */
  fill: string | null;
  /** The lane's ARMED shade per hue family, stroke level — what a click on
   *  that column paints. Durable session state: the shade strip retunes it
   *  ("a changer-picker"), and SELECTING shapes pulls their shades into it —
   *  the lane becomes the palette the selection operates in. */
  strokeShades: Record<HueFamily, string>;
  /** Fill-level counterpart — each family's fill shade is independent of its
   *  stroke shade. Arms the pastel pole out of the box. */
  fillShades: Record<HueFamily, string>;
  /** The SPECIALS column's armed value, stroke level: {@link CONTRAST_INK}
   *  (smart) or a {@link GRAYS} rung. Same lifecycle as the family slots. */
  strokeSpecial: string;
  /** Fill-level specials slot: null (none) or a gray. */
  fillSpecial: string | null;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  /** The host's board config (see {@link DrawFeatures}) — frozen at init,
   *  with ONE exception: `paletteSize` moves at runtime via the lane's resize
   *  handle (setPaletteSize) and round-trips through the session as a scalar
   *  pref. Everything else is config, never part of the doc OR the session. */
  features: DrawFeatures;
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

/** Dash pattern for a stroke style at width `w` — in the same units as the
 *  width (model), so the pattern rides the stage transform with the geometry
 *  and the style reads the same at every zoom and stroke size. Undefined =
 *  solid. Dotted relies on ROUND line caps to render dots (the canvas paints a
 *  cap circle per zero-length dash). */
export function dashFor(style: StrokeStyle | undefined, w: number): number[] | undefined {
  if (style === "dashed") return [w * 3, w * 2];
  if (style === "dotted") return [0.001, w * 2.5];
  return undefined;
}
/** Stroke widths for shapes; for TEXT these same three slots mean small/medium/
 *  large font size (see {@link fontForStroke}). */
export const STROKE_WIDTHS = [3, 6, 10] as const;
/** The FULL size ladder: the three visible slots plus "secret" levels past each
 *  end — the toolbar only ever shows three dots, but -/= (and re-pressing an
 *  extreme dot) keeps walking this ladder. Values off the ladder (legacy docs)
 *  step from the nearest rung. */
export const STROKE_LADDER = [1, 2, 3, 6, 10, 14, 20, 28] as const;
export const TEXT_SIZES: Record<number, number> = { 1: 10, 2: 14, 3: 18, 6: 28, 10: 44, 14: 58, 20: 76, 28: 100 };
/** Generic small/medium/large text size for a stroke slot (not stroke-scaled). */
export function fontForStroke(w: number): number {
  return TEXT_SIZES[w] ?? 24;
}
/** One ladder step from `w` (dir ±1), clamped at the secret ends. */
export function stepStroke(w: number, dir: number): number {
  let idx = 0;
  for (let i = 1; i < STROKE_LADDER.length; i++) {
    if (Math.abs(STROKE_LADDER[i] - w) < Math.abs(STROKE_LADDER[idx] - w)) idx = i;
  }
  return STROKE_LADDER[Math.max(0, Math.min(STROKE_LADDER.length - 1, idx + (dir > 0 ? 1 : -1)))];
}
/** Which of the three visible dots represents `w` (secret sizes light up the
 *  nearest extreme — whose dot then grows/shrinks with the real value). */
export function sizeSlotOf(w: number): 0 | 1 | 2 {
  let slot: 0 | 1 | 2 = 0;
  (STROKE_WIDTHS as readonly number[]).forEach((v, i) => {
    if (Math.abs(v - w) < Math.abs(STROKE_WIDTHS[slot] - w)) slot = i as 0 | 1 | 2;
  });
  return slot;
}
/** The classic content inks (user's drawing colors — NOT UI chrome; the
 *  design-token rule governs chrome, these are pixels the user paints). Each is
 *  the BASE rung of its hue family's ramp — see {@link SHADES} — in wheel
 *  order. A default-width lane shows only the classic four (red/amber/green/
 *  blue); the rest arrive as the host widens the palette. */
export const INK_COLORS = [
  "#e5484d", // red
  "#f97316", // orange
  "#f5a623", // amber
  "#84cc16", // lime
  "#30a46c", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#a855f7", // purple
  "#ec4899", // pink
  "#ad7f58", // brown
] as const;

/** Operator is dark-only — a blank sketch canvas is this dark surface. */
export const CANVAS_BG_DARK = "#1a1a1e";
/** The "adaptive" primary ink — a sentinel STROKE value. Renderers resolve it
 *  to a solid bright/dark ink contrasting the BACKGROUND sampled under the
 *  shape — where "background" is the paper, the annotated/placed images, and
 *  every FILL beneath it (never other strokes). Stroke-only: fills ARE the
 *  background contrast reacts to (an "adaptive fill" would chase itself), so
 *  the fill specials offer none + the {@link GRAYS} instead. */
export const CONTRAST_INK = "contrast";
/** True for a shape painted with the adaptive ink (resolved per background). */
export const isContrastInk = (stroke: string) => stroke === CONTRAST_INK;
/** The "no stroke" sentinel STROKE value — the shape paints only its fill
 *  (renderers resolve it to transparent; the geometry stays selectable).
 *  Lives in the stroke specials strip beside smart, but only on boards WITH
 *  fills ({@link DrawFeatures.fills}) — with fills opted out a strokeless
 *  shape could never be visible, so the option disappears with them. */
export const NO_STROKE = "none";
/** True for a shape with its stroke turned off (fill-only shape). */
export const isNoStroke = (stroke: string) => stroke === NO_STROKE;

/** ALL hue families the board knows — the full 12-column wheel, in display
 *  (wheel) order. How many actually show is the host's palette width — see
 *  {@link visibleHueFamilies} / {@link DrawFeatures.paletteSize}; the default
 *  four are the classic red/amber/green/blue. A family is a COLUMN identity;
 *  which of its shades the column currently paints (per level) lives in
 *  {@link DrawState.strokeShades}/`fillShades`. */
export const HUE_FAMILIES = ["red", "orange", "amber", "lime", "green", "teal", "cyan", "blue", "indigo", "purple", "pink", "brown"] as const;
export type HueFamily = (typeof HUE_FAMILIES)[number];
/** Widening order: growing the palette adds families by DISTINCTNESS — the
 *  classic four first, then the most-separated next hue at each step — not by
 *  wheel position (width 5 adds purple, not orange). */
export const HUE_PRIORITY: readonly HueFamily[] = ["red", "amber", "green", "blue", "purple", "orange", "teal", "pink", "cyan", "lime", "indigo", "brown"];
/** The hue columns a palette of `size` shows: the first `size` families by
 *  {@link HUE_PRIORITY}, displayed in wheel order. Size 1 still resolves (to
 *  [red]) for uniformity, but a 1-wide board never renders a lane at all. */
export function visibleHueFamilies(size: number): HueFamily[] {
  const take = new Set(HUE_PRIORITY.slice(0, Math.max(1, Math.min(HUE_FAMILIES.length, Math.round(size)))));
  return HUE_FAMILIES.filter((f) => take.has(f));
}

/** Host-configurable board capabilities — how much of the board a host mounts
 *  (DrawEditor's `features` prop, frozen at editor mount).
 *  - `paletteSize`: hue columns in the paint lane, 1..{@link MAX_PALETTE}.
 *    1 = a single-color board: the whole color UI (specials included) is gone
 *    and everything draws in the editor's default ink.
 *  - `fills`: the fill level. Off: lane swatches are stroke-only dots, fill
 *    strips/keys are inert, and new shapes never fill.
 *  - `strokeStyling`: the size dots + solid/dashed/dotted cluster (and their
 *    keys). Off: everything draws the default width, solid.
 *  - `paletteResize`: the drag handle at the lane's end that retunes the
 *    visible palette width live (2..MAX_PALETTE, persisted as a session pref —
 *    see setPaletteSize). Off: the lane is exactly `paletteSize` wide, always.
 *  - `grouping`: the group/ungroup control + ⌘G. Existing groups in a loaded
 *    doc still select/move as units (the data stays portable); only
 *    making/dissolving groups is removed.
 *  - `shapes`: which shape tools the board mounts ({@link SHAPE_TOOLS} —
 *    drag-drawn kinds + text; select/eraser are never gated). A disabled kind
 *    loses its toolbar button/key and can't be armed or retyped-to, but shapes
 *    of that kind in a loaded doc still render/select/move (portability, like
 *    grouping). An explicit empty list is honored: a board with no creation
 *    tools at all (view/prune-only). */
export interface DrawFeatures {
  paletteSize: number;
  paletteResize: boolean;
  fills: boolean;
  strokeStyling: boolean;
  grouping: boolean;
  shapes: readonly ShapeTool[];
}
export const MAX_PALETTE = HUE_FAMILIES.length;
export const DEFAULT_FEATURES: DrawFeatures = { paletteSize: 4, paletteResize: true, fills: true, strokeStyling: true, grouping: true, shapes: SHAPE_TOOLS };
/** Resolve a host's partial config: clamp the palette to 1..MAX_PALETTE,
 *  default everything else on. Size 1 implies fills off (no lane → nothing
 *  can arm a fill), so downstream checks read one flag each. `shapes` is
 *  sanitized to known kinds, deduped, canonical order; garbage-only input
 *  falls back to all (like an unparsable paletteSize) while a literal empty
 *  list stays empty (a deliberate no-creation board). */
export function resolveFeatures(f?: Partial<DrawFeatures> | null): DrawFeatures {
  const size =
    typeof f?.paletteSize === "number" && Number.isFinite(f.paletteSize)
      ? Math.max(1, Math.min(MAX_PALETTE, Math.round(f.paletteSize)))
      : DEFAULT_FEATURES.paletteSize;
  const rawShapes = Array.isArray(f?.shapes) ? f.shapes : null;
  const known = new Set((rawShapes ?? []).filter((t): t is ShapeTool => isShapeTool(t as Tool)));
  const shapes =
    rawShapes === null || (known.size === 0 && rawShapes.length > 0) ? SHAPE_TOOLS : SHAPE_TOOLS.filter((t) => known.has(t));
  return {
    paletteSize: size,
    paletteResize: f?.paletteResize ?? DEFAULT_FEATURES.paletteResize,
    fills: size > 1 && (f?.fills ?? DEFAULT_FEATURES.fills),
    strokeStyling: f?.strokeStyling ?? DEFAULT_FEATURES.strokeStyling,
    grouping: f?.grouping ?? DEFAULT_FEATURES.grouping,
    shapes,
  };
}

/** Each family's ramp: two tints, the classic base ink (index
 *  {@link BASE_SHADE} — the INK_COLORS hex), two darks. Hand-tuned for
 *  perceptual evenness; all lowercase (familyOf compares lowercased). The
 *  bright pole stays a clearly-colored pastel — ramps never wash toward
 *  white (tint ceiling ~0.8 lum; the unit suite pins it). */
export const SHADES: Record<HueFamily, readonly string[]> = {
  red: ["#f19a9d", "#eb7074", "#e5484d", "#b02f35", "#7a1e22"],
  orange: ["#fdba74", "#fb923c", "#f97316", "#c2410c", "#7c2d12"],
  amber: ["#f8c165", "#f6b344", "#f5a623", "#c07c14", "#8a570c"],
  lime: ["#a3e635", "#94d925", "#84cc16", "#4d7c0f", "#365314"],
  green: ["#7fc7a4", "#57b588", "#30a46c", "#1f7a4e", "#125033"],
  teal: ["#5eead4", "#2dd4bf", "#14b8a6", "#0f766e", "#134e4a"],
  cyan: ["#4ee1f4", "#22d3ee", "#06b6d4", "#0e7490", "#164e63"],
  blue: ["#86b2f9", "#609af8", "#3b82f6", "#2563c4", "#174a94"],
  indigo: ["#a5b4fc", "#818cf8", "#6366f1", "#4338ca", "#312e81"],
  purple: ["#d8b4fe", "#c084fc", "#a855f7", "#7e22ce", "#581c87"],
  pink: ["#f9a8d4", "#f472b6", "#ec4899", "#be185d", "#831843"],
  brown: ["#cbb096", "#bd9776", "#ad7f58", "#8a6444", "#5f4632"],
};
export const BASE_SHADE = 2;
/** The specials column's own ramp — five neutrals, near-white → near-black.
 *  Its poles ARE the two adaptive resolutions ({@link CONTRAST_BRIGHT} /
 *  {@link CONTRAST_DARK}), so "smart" is literally the auto-pick between this
 *  ramp's ends. Per level the column's palette is `[smart, none, ...GRAYS]`
 *  for strokes (none only on boards with fills) and `[none, ...GRAYS]` for
 *  fills. */
export const GRAYS = ["#f5f5f5", "#b8b8b8", "#7d7d7d", "#454545", "#111111"] as const;
export const isGray = (color: string) => (GRAYS as readonly string[]).includes(color.toLowerCase());
/** A lane column identity: a hue family, or the specials column ("gray" —
 *  home of smart / none / the neutral ramp). */
export type LaneColumn = HueFamily | "gray";
/** The lane column a STROKE value operates in: smart, no-stroke and the grays
 *  belong to the specials column; hue rungs to their family; foreign hexes to
 *  none. */
export function strokeColumnOf(color: string): LaneColumn | null {
  return isContrastInk(color) || isNoStroke(color) || isGray(color) ? "gray" : familyOf(color);
}
/** Fill counterpart — none (null) lives in the specials column too. */
export function fillColumnOf(color: string | null): LaneColumn | null {
  return color === null || isGray(color) ? "gray" : familyOf(color);
}
/** The hue family a color belongs to (any rung of its ramp), or null — the
 *  adaptive sentinel, the grays and legacy/foreign hexes live outside every
 *  hue family. */
export function familyOf(color: string): HueFamily | null {
  const h = color.toLowerCase();
  for (const f of HUE_FAMILIES) if (SHADES[f].includes(h)) return f;
  return null;
}
/** Index of `color` within its family's ramp, or -1. */
export function shadeIndexOf(color: string): number {
  const f = familyOf(color);
  return f ? SHADES[f].indexOf(color.toLowerCase()) : -1;
}
/** A fresh per-family shade map — every column on its classic base ink. */
export function baseShades(): Record<HueFamily, string> {
  return Object.fromEntries(HUE_FAMILIES.map((f) => [f, SHADES[f][BASE_SHADE]])) as Record<HueFamily, string>;
}
/** The pastel pole of every ramp (rung 0) — what the FILL level arms out of
 *  the box: default fills read softer than their strokes, on the same ramps. */
export function pastelShades(): Record<HueFamily, string> {
  return Object.fromEntries(HUE_FAMILIES.map((f) => [f, SHADES[f][0]])) as Record<HueFamily, string>;
}

/** The two solid resolutions of the adaptive ink. */
export const CONTRAST_DARK = "#111111";
export const CONTRAST_BRIGHT = "#f5f5f5";
/** Rec.709 luminance of a #rgb/#rrggbb hex (0..1); non-hex → dark (bright ink). */
export function hexLum(hex: string): number {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const n = parseInt(h, 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
/** Solid ink for the adaptive stroke over a given backdrop color (a fill, or
 *  the paper when none): dark ink on a light ground, bright on a dark one.
 *  Same 0.55 threshold the canvas's raster sampler uses. */
export function contrastSolidOver(backdrop: string | null | undefined): string {
  return hexLum(backdrop ?? CANVAS_BG_DARK) > 0.55 ? CONTRAST_DARK : CONTRAST_BRIGHT;
}

/** Whether a pen doodle is ENCLOSED — its endpoints meet closely enough,
 *  relative to how long the stroke is, to read as a closed loop (then its
 *  `fill` renders). Tolerance grows with path length (hand-drawn loops rarely
 *  land exactly) but is capped so a long open scribble never counts. */
export function isEnclosed(points: number[]): boolean {
  const n = points.length / 2;
  if (n < 3) return false;
  let len = 0;
  for (let i = 0; i + 3 < points.length; i += 2) len += Math.hypot(points[i + 2] - points[i], points[i + 3] - points[i + 1]);
  const gap = Math.hypot(points[points.length - 2] - points[0], points[points.length - 1] - points[1]);
  return gap <= Math.max(16, Math.min(60, len * 0.12)) && len > gap * 2;
}

/** Ray-cast point-in-polygon over a flat [x1,y1,…] ring (implicitly closed). */
export function pointInPolygon(px: number, py: number, points: number[]): boolean {
  let inside = false;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2], yi = points[i * 2 + 1];
    const xj = points[j * 2], yj = points[j * 2 + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The RENDERED box of a text background highlight: the block padded a touch
 *  (font-relative) so the highlight reads as a chip, not a crop. Visual only —
 *  layout/hit/attach metrics stay {@link boundingBox}'s bare block. */
export function textBgBox(sh: TextShape): { x: number; y: number; width: number; height: number; pad: number } {
  const b = textBlockSize(sh.text, sh.fontSize, sh.width);
  const pad = sh.fontSize * 0.15;
  return { x: sh.x - pad, y: sh.y - pad, width: b.width + pad * 2, height: b.height + pad * 2, pad };
}

/** Whether a shape currently PAINTS a fill (pen only while enclosed). */
export function paintsFill(sh: Shape): boolean {
  switch (sh.type) {
    case "rect":
    case "ellipse":
    case "diamond":
    case "text":
      return !!sh.fill;
    case "pen":
      return !!sh.fill && isEnclosed(sh.points);
    default:
      return false;
  }
}

/** The types that CARRY a fill slot (a pen's may lie dormant while open —
 *  {@link paintsFill} is the painted-now check). Single source for setFill,
 *  refill, and the declaration derivation. */
export function isFillable(sh: Shape): sh is BoxShape | FreehandShape | TextShape {
  return sh.type === "rect" || sh.type === "ellipse" || sh.type === "diamond" || sh.type === "pen" || sh.type === "text";
}

/** Set / strip one shape's fill (null STRIPS the field — persisted docs stay
 *  slim). Non-fillable shapes pass through untouched. */
export function applyFill(sh: Shape, fill: string | null): Shape {
  if (!isFillable(sh)) return sh;
  if (fill === null) {
    if (sh.fill === undefined) return sh;
    const next = { ...sh };
    delete next.fill;
    return next;
  }
  return { ...sh, fill };
}

/** The topmost fill color under a point — the backdrop the adaptive ink
 *  contrasts against there (images excluded: pure-land callers — SVG export,
 *  the edit overlay — have no pixels; the canvas's raster sampler adds them).
 *  `limit` bounds the walk to shapes STRICTLY BELOW that id in paint order:
 *  a shape's own backfill is self, and a fill covering it from above hides
 *  its stroke — both are foreground there, not the ground the ink is read
 *  against (callers keep text's own fill — the chip sits BEHIND the glyphs).
 *  An absent id means no bound (a draft floats on top). Null = bare paper. */
export function fillAt(shapes: Shape[], px: number, py: number, limit?: string): string | null {
  let top = shapes.length;
  if (limit !== undefined) {
    const at = shapes.findIndex((s) => s.id === limit);
    if (at !== -1) top = at;
  }
  for (let i = top - 1; i >= 0; i--) {
    const sh = shapes[i];
    switch (sh.type) {
      case "pen":
        if (sh.fill && isEnclosed(sh.points) && pointInPolygon(px, py, sh.points)) return sh.fill;
        continue;
      case "rect":
      case "ellipse":
      case "diamond":
      case "text": {
        if (!sh.fill) continue;
        const b = sh.type === "text" ? textBgBox(sh) : boundingBox(sh);
        if (px < b.x || px > b.x + b.width || py < b.y || py > b.y + b.height) continue;
        if (sh.type === "ellipse" || sh.type === "diamond") {
          // Precise interiors — the fill doesn't reach the box corners.
          const nx = Math.abs(px - (b.x + b.width / 2)) / (b.width / 2 || 1);
          const ny = Math.abs(py - (b.y + b.height / 2)) / (b.height / 2 || 1);
          if ((sh.type === "ellipse" ? nx * nx + ny * ny : nx + ny) > 1) continue;
        }
        return sh.fill;
      }
      default:
        continue;
    }
  }
  return null;
}

const DEFAULT_STAGE = { width: 720, height: 460 };

/** The SESSION slice of the state — everything the toolbar + selection hold
 *  that isn't the document itself: tool + cluster variants, the ambient
 *  paints, the lane's retuned shades and specials, stroke width/style, and
 *  the selection. Hosts persist it NEXT TO their doc storage (never inside
 *  the doc — exports/attachments must not carry UI state) so a reload or a
 *  page switch restores the board exactly as it was left. Undo history and
 *  in-flight gesture state stay transient by design. */
export interface DrawSession {
  tool: Tool;
  baseTool: "select" | "pen";
  shapeVariant: ShapeVariant;
  lineVariant: LineVariant;
  color: string;
  fill: string | null;
  strokeShades: Record<HueFamily, string>;
  fillShades: Record<HueFamily, string>;
  strokeSpecial: string;
  fillSpecial: string | null;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  selectedIds: string[];
  /** The lane width as the user last dragged it (the resize handle) — the one
   *  features field that's a session pref. Absent in legacy sessions; applied
   *  on restore only where the board is resizable at all. */
  paletteSize?: number;
}

/** One enum-ish field of a persisted session, validated against its allowlist
 *  (a stored session is cross-version data, same as docs). */
const oneOf = <T,>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt);

/** A persisted shade record merged over the defaults, per family — a missing
 *  or foreign-shaped record falls back field by field. */
function mergeShades(v: unknown, dflt: Record<HueFamily, string>): Record<HueFamily, string> {
  const out = { ...dflt };
  if (v && typeof v === "object") {
    for (const f of HUE_FAMILIES) {
      const s = (v as Record<string, unknown>)[f];
      if (typeof s === "string" && s) out[f] = s;
    }
  }
  return out;
}

export function initialDrawState(
  doc?: DrawDoc,
  opts?: { color?: string; session?: DrawSession | null; features?: Partial<DrawFeatures> | null }
): DrawState {
  // normalizeGroups + migrateLabels: cross-version safety for every open path
  // (localStorage, PNG/SVG board import, host-supplied docs) — see their docs.
  const shapes = doc ? migrateLabels(normalizeGroups(doc.shapes.map(cloneShape))) : [];
  const features = resolveFeatures(opts?.features);
  const base: DrawState = {
    background: doc?.background,
    shapes,
    width: doc?.width ?? DEFAULT_STAGE.width,
    height: doc?.height ?? DEFAULT_STAGE.height,
    // Always open in pen — ready to sketch immediately (cursor is one Tab away).
    // The pill keeps cursor first / pen second; the well just starts on pen.
    tool: "pen",
    baseTool: "pen",
    shapeVariant: "rect",
    lineVariant: "arrow",
    color: opts?.color ?? CONTRAST_INK,
    fill: null,
    strokeShades: baseShades(),
    fillShades: pastelShades(),
    strokeSpecial: CONTRAST_INK,
    fillSpecial: null,
    strokeWidth: DEFAULT_STROKE_WIDTH,
    strokeStyle: "solid",
    features,
    selectedIds: [],
    draftId: null,
    gestureBase: null,
    past: [],
    future: [],
  };
  const raw = opts?.session;
  // Restore a persisted session over the defaults. Cross-version safety, like
  // the doc paths above: every field is validated — unknown enum values fall
  // back, shade records merge per family, and the selection keeps only ids
  // that still exist in THIS doc (a session may be older than the doc).
  const ids = new Set(shapes.map((sh) => sh.id));
  const baseTool = raw ? (oneOf<Tool>(raw.baseTool, SELECTABLE_TOOLS, "pen") as "select" | "pen") : base.baseTool;
  const state: DrawState =
    !raw || typeof raw !== "object"
      ? base
      : {
          ...base,
          tool: oneOf<Tool>(raw.tool, TOOLS, baseTool),
          baseTool,
          shapeVariant: oneOf(raw.shapeVariant, SHAPE_VARIANTS, base.shapeVariant),
          lineVariant: oneOf(raw.lineVariant, LINE_VARIANTS, base.lineVariant),
          color: typeof raw.color === "string" && raw.color ? raw.color : base.color,
          fill: raw.fill === null || typeof raw.fill === "string" ? raw.fill : base.fill,
          strokeShades: mergeShades(raw.strokeShades, base.strokeShades),
          fillShades: mergeShades(raw.fillShades, base.fillShades),
          strokeSpecial: typeof raw.strokeSpecial === "string" && raw.strokeSpecial ? raw.strokeSpecial : base.strokeSpecial,
          fillSpecial: raw.fillSpecial === null || typeof raw.fillSpecial === "string" ? raw.fillSpecial : base.fillSpecial,
          strokeWidth:
            typeof raw.strokeWidth === "number" && Number.isFinite(raw.strokeWidth) && raw.strokeWidth > 0
              ? raw.strokeWidth
              : base.strokeWidth,
          strokeStyle: oneOf(raw.strokeStyle, STROKE_STYLES, base.strokeStyle),
          selectedIds: Array.isArray(raw.selectedIds)
            ? [...new Set(raw.selectedIds.filter((id): id is string => typeof id === "string" && ids.has(id)))]
            : [],
        };
  // The lane width is the ONE feature the user can change (the resize handle) —
  // restore it like any toolbar pref, but only where the handle exists at all:
  // a fixed-width (paletteResize off) or single-color board keeps the host's
  // exact config.
  if (features.paletteResize && features.paletteSize > 1 && raw && typeof raw.paletteSize === "number" && Number.isFinite(raw.paletteSize)) {
    state.features = { ...features, paletteSize: Math.max(2, Math.min(MAX_PALETTE, Math.round(raw.paletteSize))) };
  }
  // Feature forcing — an opted-out control must leave NO hidden state behind:
  // a restored fill/width/color whose UI is gone would silently style new
  // shapes with no way to see or change it. (Sessions saved under a wider
  // config restore cleanly under a narrower one, and vice versa.)
  if (!features.fills) {
    state.fill = null;
    state.fillSpecial = null;
    // No-stroke rides the fills feature (a strokeless shape needs a fill to be
    // visible) — scrub it from a session saved under a fills board.
    if (isNoStroke(state.color)) state.color = base.color;
    if (isNoStroke(state.strokeSpecial)) state.strokeSpecial = CONTRAST_INK;
  }
  if (!features.strokeStyling) {
    state.strokeWidth = DEFAULT_STROKE_WIDTH;
    state.strokeStyle = "solid";
  }
  if (features.paletteSize === 1) {
    state.color = base.color; // the editor's default ink IS the single color
    state.strokeSpecial = CONTRAST_INK;
  }
  // Disabled shape tools leave no armed state behind either: the active/base
  // tool and both cluster memories must all point at kinds THIS board can
  // draw (a restored session may be wider than the config).
  if (!features.shapes.includes("pen") && state.baseTool === "pen") state.baseTool = "select";
  if (isShapeTool(state.tool) && !features.shapes.includes(state.tool)) state.tool = state.baseTool;
  const shapeVars = SHAPE_VARIANTS.filter((v) => features.shapes.includes(v));
  if (shapeVars.length > 0 && !shapeVars.includes(state.shapeVariant)) state.shapeVariant = shapeVars[0];
  const lineVars = LINE_VARIANTS.filter((v) => features.shapes.includes(v));
  if (lineVars.length > 0 && !lineVars.includes(state.lineVariant)) state.lineVariant = lineVars[0];
  return state;
}

/** The session slice of the state (what hosts persist next to the doc — see
 *  {@link DrawSession}). */
export function toSession(s: DrawState): DrawSession {
  return {
    tool: s.tool,
    baseTool: s.baseTool,
    shapeVariant: s.shapeVariant,
    lineVariant: s.lineVariant,
    color: s.color,
    fill: s.fill,
    strokeShades: { ...s.strokeShades },
    fillShades: { ...s.fillShades },
    strokeSpecial: s.strokeSpecial,
    fillSpecial: s.fillSpecial,
    strokeWidth: s.strokeWidth,
    strokeStyle: s.strokeStyle,
    selectedIds: [...s.selectedIds],
    paletteSize: s.features.paletteSize,
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

/** A box's inscribed diamond — its four edge-midpoint vertices (top, right,
 *  bottom, left) as a flat closed-polygon point list. The ONE diamond geometry
 *  every renderer (Konva / SVG / raster samplers) shares. */
export function diamondPoints(b: { x: number; y: number; width: number; height: number }): number[] {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return [cx, b.y, b.x + b.width, cy, cx, b.y + b.height, b.x, cy];
}

/** Axis-aligned bounding box of any shape (used for marquee + selection outline).
 *  Text width is approximated from character count (we don't measure glyphs). */
export function boundingBox(sh: Shape): { x: number; y: number; width: number; height: number } {
  switch (sh.type) {
    case "rect":
    case "ellipse":
    case "diamond": {
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
    case "text": {
      // The REAL rendered block (Arial advances, wrap-aware) — bbox, hit,
      // attach, and export crops all agree with what the canvas draws.
      const size = textBlockSize(sh.text, sh.fontSize, sh.width);
      return { x: sh.x, y: sh.y, width: size.width, height: size.height };
    }
  }
}

/** Font size a legacy bound label rendered at — kept only so {@link
 *  migrateLabels} can mint its replacement text at the same visual size. */
function labelFont(bbox: { width: number; height: number }): number {
  return Math.max(12, Math.min(26, bbox.height * 0.45, bbox.width * 0.28));
}

/** Legacy bound labels → free text shapes. The label feature is gone; shipped
 *  docs (localStorage boards, PNG/SVG re-imports, clipboard envelopes) may
 *  still carry `label` on shapes, so every load path funnels through this:
 *  each label becomes a standalone text at the position it rendered — centered
 *  on an area shape and bonded to it via the standard placement glue (so it
 *  still follows), or at a stroke's chip midpoint, free (strokes aren't attach
 *  parents). Label-free input passes through by identity. */
export function migrateLabels(shapes: Shape[]): Shape[] {
  if (!shapes.some((sh) => sh.label)) return shapes;
  const stripped: Shape[] = shapes.map((sh) => (sh.label ? { ...sh, label: undefined } : sh));
  const minted: Shape[] = [];
  for (const sh of shapes) {
    if (!sh.label) continue;
    const b = boundingBox(sh);
    const chip = sh.type === "line" || sh.type === "arrow" || sh.type === "pen";
    const fontSize = chip ? 15 : labelFont(b); // chips rendered at a fixed 15
    const mid =
      sh.type === "line" || sh.type === "arrow"
        ? { x: (sh.points[0] + sh.points[2]) / 2, y: (sh.points[1] + sh.points[3]) / 2 }
        : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const size = textBlockSize(sh.label, fontSize);
    const t: TextShape = {
      id: `${sh.id}-label`,
      type: "text",
      stroke: sh.stroke,
      strokeWidth: sh.strokeWidth,
      x: mid.x - size.width / 2,
      y: mid.y - size.height / 2,
      text: sh.label,
      fontSize,
    };
    const attach = attachAt(t, stripped);
    minted.push(attach ? { ...t, attach } : t);
  }
  return [...stripped, ...minted];
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
const CONTAINER_TYPES = new Set(["rect", "ellipse", "diamond", "image", "text"]);
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
 *  rectangle's edges for rect/image/text, the ellipse curve for ellipse, the
 *  rhombus edges for diamond. Lets a bound endpoint cling to the actual border
 *  as it rotates (not a circle). */
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
  if (sh.type === "diamond") {
    // Rhombus |x|/hx + |y|/hy = 1 → the ray hits it at 1/(|cos|/hx + |sin|/hy).
    const denom = Math.abs(Math.cos(dir)) / hx + Math.abs(Math.sin(dir)) / hy;
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
 *  attached). A zero-size box classifies a POINT — the hover preview asks which
 *  edge a hovered spot would pin to. */
export function sideAnchor(c: Box, p: Box, touch = EDGE_TOUCH): { ax: number; ay: number } {
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
  const containsText = (b: Box) =>
    child.type === "text" && cb.x >= b.x && cb.y >= b.y && cb.x + cb.width <= b.x + b.width && cb.y + cb.height <= b.y + b.height;
  for (const sh of shapes) {
    if (sh.id === child.id || !CONTAINER_TYPES.has(sh.type)) continue;
    const b = boundingBox(sh);
    if (!b.width || !b.height) continue;
    // A container FULLY holding a text is judged by the containment bond below,
    // never by box contact: a parent-capped wrap box spans to its cap by
    // construction, and that must not read as "touching the right edge".
    if (containsText(b)) continue;
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
  // TEXT fully inside a container bonds to the innermost one, judged by its
  // PLACEMENT ANCHOR (where the text was set down): an edge the anchor hugs, else
  // the center — so a caption keeps its offset from that seam through parent
  // resizes ("anchor the bonded edge, else center"). A pinned bond to a NEARBY
  // (non-containing) shape wins first — a label beside a small box belongs to the
  // box, not the frame around both. Other types keep centered-inside as plain
  // containment (move-only) — attaching them would weld overlays.
  if (!best && child.type === "text") {
    let inner: Shape | undefined;
    let innerArea = Infinity;
    for (const sh of shapes) {
      if (sh.id === child.id || !CONTAINER_TYPES.has(sh.type)) continue;
      const b = boundingBox(sh);
      if (!b.width || !b.height || !containsText(b)) continue;
      const area = b.width * b.height;
      if (area < innerArea) {
        innerArea = area;
        inner = sh;
      }
    }
    if (inner) {
      const b = boundingBox(inner);
      const touch = EDGE_TOUCH * distScale;
      const tx = child as TextShape;
      const ax = tx.x - b.x <= touch ? 0 : b.x + b.width - tx.x <= touch ? 1 : 0.5;
      const ay = tx.y - b.y <= touch ? 0 : b.y + b.height - tx.y <= touch ? 1 : 0.5;
      return { id: inner.id, kind: "box", ax, ay, dx: cc.x - (b.x + ax * b.width), dy: cc.y - (b.y + ay * b.height) };
    }
  }
  if (!best) return undefined;
  const b = boundingBox(best);
  if (best.type === "ellipse" || best.type === "diamond") {
    // Angled borders → radial anchors (box side/corner anchors assume
    // rectangular edges); borderDist casts to the actual curve/rhombus.
    const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const angle = Math.atan2(cc.y - c.y, cc.x - c.x);
    return { id: best.id, kind: "radial", angle, gap: Math.hypot(cc.x - c.x, cc.y - c.y) - borderDist(best, angle) };
  }
  const { ax, ay } = bestAnchor;
  return { id: best.id, kind: "box", ax, ay, dx: cc.x - (b.x + ax * b.width), dy: cc.y - (b.y + ay * b.height) };
}

/** Move every attached follower so its center tracks the parent's current anchor
 *  — following the parent on move AND resize — at ROOT-UNIT grain: when a
 *  follower's anchor fires, its ENTIRE unit moves rigidly by the same delta
 *  (bound arrows then re-cling via {@link reflowBindings}). INTRA-unit edges are
 *  inert here — rigidity owns geometry inside a unit (they matter again after
 *  ungroup). Drops attachments whose parent is gone. `skip` = shapes being
 *  directly dragged (don't yank them back) — a unit with ANY member in `skip`
 *  never moves. A few passes handle shallow nesting. Pure. */
export function reflowAttachments(shapes: Shape[], skip: Set<string>): Shape[] {
  let result = shapes;
  let anyChange = false;
  for (let pass = 0; pass < 3; pass++) {
    const byId = new Map(result.map((s) => [s.id, s]));
    const units = unitPartition(result);
    // Collect per-unit corrections (≤1 outward edge per unit — first wins on
    // legacy multi-edge data) and dropped edges, then apply in one map.
    const unitDelta = new Map<string, { dx: number; dy: number }>();
    const dropAttach = new Set<string>();
    for (const sh of result) {
      if (!sh.attach || skip.has(sh.id) || isConnector(sh)) continue; // connectors reflow via bindings, not attach
      const parent = byId.get(sh.attach.id);
      if (!parent) {
        dropAttach.add(sh.id);
        continue;
      }
      const key = rootUnitKeyOf(sh);
      if (rootUnitKeyOf(parent) === key) continue; // intra-unit edge: rigid, inert
      if (unitDelta.has(key)) continue;
      if ((units.get(key) ?? []).some((id) => skip.has(id))) continue; // unit is being dragged
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
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) continue;
      unitDelta.set(key, { dx, dy });
    }
    if (!unitDelta.size && !dropAttach.size) break;
    result = result.map((sh) => {
      let out = sh;
      if (dropAttach.has(sh.id)) {
        const { attach: _drop, ...rest } = out;
        out = rest as Shape;
      }
      const d = unitDelta.get(rootUnitKeyOf(out));
      return d ? offsetShape(out, d.dx, d.dy) : out;
    });
    anyChange = true;
  }
  return anyChange ? result : shapes;
}

/** Attachments move shapes, then bindings re-cling to the new positions. */
function reflowAll(shapes: Shape[], skip: Set<string>): Shape[] {
  return reflowBindings(reflowAttachments(shapes, skip));
}

/** Ids of shapes fully contained within any of the given container shapes' boxes
 *  (used to drag a container's contents along with it), at ROOT-UNIT grain: a
 *  container contains only via its members' own boxes (never hull air between
 *  them), and a containee UNIT is admitted whole — only when ALL its members are
 *  inside. Containment is PROPER: a box the container's own size is an overlay,
 *  not content — two identical stacked shapes would otherwise contain each other
 *  symmetrically and weld forever (dragging either moved both; they could never
 *  be pulled apart). Only area shapes act as containers; units overlapping the
 *  container set are excluded. */
export function containedIds(shapes: Shape[], containerIds: string[]): string[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const boxes = containerIds
    .map((id) => byId.get(id))
    .filter((s): s is Shape => !!s && CONTAINER_TYPES.has(s.type))
    .map(boundingBox);
  if (!boxes.length) return [];
  const set = new Set(containerIds);
  const inside = (sh: Shape) => {
    const b = boundingBox(sh);
    return boxes.some(
      (A) =>
        b.x >= A.x &&
        b.y >= A.y &&
        b.x + b.width <= A.x + A.width &&
        b.y + b.height <= A.y + A.height &&
        (b.width < A.width - CLUSTER_EPS || b.height < A.height - CLUSTER_EPS)
    );
  };
  const out: string[] = [];
  for (const [, memberIds] of unitPartition(shapes)) {
    if (memberIds.some((id) => set.has(id))) continue; // the containers' own units
    if (memberIds.every((id) => inside(byId.get(id)!))) out.push(...memberIds);
  }
  return out;
}

/** Drag-propagation weight ("largest drags smallest"): 0 for stroke-like shapes
 *  (pen/line/arrow — massless followers that never pull), else bounding-box area.
 *  Raw bbox area would misclassify an ENCIRCLING scribble or long diagonal stroke
 *  as "bigger" than the shape it annotates and strand it when that shape is grabbed;
 *  making strokes massless keeps them as pure followers (0 < any area weight;
 *  a stroke seed pulls nothing). Text keeps its bbox weight. */
export function clusterWeight(sh: Shape): number {
  if (sh.type === "pen" || sh.type === "line" || sh.type === "arrow") return 0;
  const b = boundingBox(sh);
  return b.width * b.height;
}

/** Which one-use cluster a shape belongs to (rect/ellipse/diamond → "shape";
 *  line/arrow → "line"), or null for pen/text/image. */
export function clusterOf(sh: Shape): "shape" | "line" | null {
  if (sh.type === "rect" || sh.type === "ellipse" || sh.type === "diamond") return "shape";
  if (sh.type === "line" || sh.type === "arrow") return "line";
  return null;
}

/** A cluster shape's VARIANT identity — rect/ellipse/diamond, or line/arrow/darrow
 *  (a double-headed arrow is an `arrow` flagged `doubleHead`). Null if not a cluster
 *  shape. Used to drive selection retyping via the cluster tools. */
export function variantOf(sh: Shape): ShapeVariant | LineVariant | null {
  if (sh.type === "rect" || sh.type === "ellipse" || sh.type === "diamond") return sh.type;
  if (sh.type === "line") return "line";
  if (sh.type === "arrow") return sh.doubleHead ? "darrow" : "arrow";
  return null;
}

/** Convert a cluster shape to another variant of the SAME cluster, preserving all
 *  geometry + metadata: rect/ellipse/diamond swap `type` (identical box);
 *  line/arrow/darrow swap `type` + `doubleHead` (points/bindings ride along). The
 *  caller guarantees `target` belongs to `sh`'s cluster. */
export function toClusterVariant(sh: Shape, target: ShapeVariant | LineVariant): Shape {
  if (target === "rect" || target === "ellipse" || target === "diamond") return { ...(sh as BoxShape), type: target };
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
export function paintOrder(shapes: readonly Shape[]): Shape[] {
  const images = shapes.filter((s) => s.type === "image").sort((a, b) => clusterWeight(b) - clusterWeight(a));
  const rest = shapes.filter((s) => s.type !== "image");
  return [...images, ...rest];
}

/** Root unit key of a shape: its root group id, or its own id when loose. The
 *  glue engine, selection normalization, and outlines all operate at this grain —
 *  a group behaves as ONE unit (docs/groups-design.md). */
export const rootUnitKeyOf = (sh: Shape): string => sh.groupPath?.[0] ?? sh.id;

/** Partition shapes into root units: rootKey → member ids (singleton for loose
 *  shapes). One O(n) pass — cheap at reducer-action frequency; the VIEW uses the
 *  identity-diffed {@link UnitIndex} for per-frame queries instead. */
export function unitPartition(shapes: Shape[]): Map<string, string[]> {
  const units = new Map<string, string[]>();
  for (const sh of shapes) {
    const key = rootUnitKeyOf(sh);
    const arr = units.get(key);
    if (arr) arr.push(sh.id);
    else units.set(key, [sh.id]);
  }
  return units;
}

/** Expand ids to FULL root units (normalizeSelection: any member implies its
 *  whole group). Returns ids in shape order; ids of missing shapes drop out. */
export function expandIdsToUnits(shapes: Shape[], ids: string[]): string[] {
  const want = new Set(ids);
  const keys = new Set<string>();
  for (const sh of shapes) if (want.has(sh.id)) keys.add(rootUnitKeyOf(sh));
  return shapes.filter((sh) => keys.has(rootUnitKeyOf(sh))).map((sh) => sh.id);
}

/** Union AABB of a root unit's members, or null if none exist. */
export function unitBoundsOf(shapes: Shape[], rootKey: string): { x: number; y: number; width: number; height: number } | null {
  return contentBounds(shapes.filter((sh) => rootUnitKeyOf(sh) === rootKey));
}

/** What ⌘G would do to this selection: 'group' (≥2 units), 'ungroup' (selection
 *  EXACTLY covers one unit whose root is a group), or null — including any proper
 *  subset of a unit, which is the deep-select context and never ungroups. Single
 *  source for the reducer guards, the ⌘G handler, and the toolbar affordance. */
export function groupActionFor(shapes: Shape[], selectedIds: string[]): "group" | "ungroup" | null {
  if (selectedIds.length === 0) return null;
  const sel = new Set(selectedIds);
  const keys = new Set<string>();
  for (const sh of shapes) if (sel.has(sh.id)) keys.add(rootUnitKeyOf(sh));
  if (keys.size === 0) return null;
  if (keys.size >= 2) return "group";
  const key = [...keys][0];
  const members = shapes.filter((sh) => rootUnitKeyOf(sh) === key);
  if (members.length !== sel.size) return null; // proper subset — deep-select, never ungroups
  return members[0].groupPath?.length ? "ungroup" : null; // a lone loose shape isn't a group
}

/** What the size controls should SCALE instead of restroke: the member ids when
 *  the selection exactly covers ONE group unit (whole-unit proportional scale) or
 *  is exactly one loose IMAGE (stroke is meaningless there) — else null and the
 *  controls keep their stroke-width meaning. Deep-selects (proper subsets) are
 *  null by construction: members never resize individually. */
export function scaleStepTarget(shapes: Shape[], selectedIds: string[]): string[] | null {
  if (selectedIds.length === 0) return null;
  const sel = new Set(selectedIds);
  const keys = new Set<string>();
  for (const sh of shapes) if (sel.has(sh.id)) keys.add(rootUnitKeyOf(sh));
  if (keys.size !== 1) return null;
  const members = shapes.filter((sh) => keys.has(rootUnitKeyOf(sh)));
  if (members.length !== sel.size) return null; // deep-select subset
  if (members.length > 1) return members.map((sh) => sh.id); // a whole group
  return members[0].type === "image" ? [members[0].id] : null; // a lone image
}

/** The size-control step of the unit the controls target (members carry a
 *  uniform stamp; absent = 0 = natural size). */
export function unitSizeStep(shapes: Shape[], ids: string[]): number {
  const set = new Set(ids);
  return shapes.find((sh) => set.has(sh.id))?.sizeStep ?? 0;
}

/** The color DECLARATION the stroke pill shows for a selection: the distinct
 *  stroke values present on the selected shapes, in encounter order. Images are
 *  excluded — their stroke field never paints. Empty selection (or image-only)
 *  → empty; the editor then falls back to the ambient pen ink. */
export function selectionStrokes(shapes: Shape[], selectedIds: string[]): string[] {
  const sel = new Set(selectedIds);
  const out: string[] = [];
  for (const sh of shapes) if (sel.has(sh.id) && sh.type !== "image" && !out.includes(sh.stroke)) out.push(sh.stroke);
  return out;
}

/** Fill counterpart of {@link selectionStrokes}: the distinct fills across the
 *  selection's FILLABLE members (null = none — the unfilled are a class too,
 *  mergeable like any other). Segments/images carry no interior and contribute
 *  nothing; a selection with no fillable member yields []. */
export function selectionFills(shapes: Shape[], selectedIds: string[]): (string | null)[] {
  const sel = new Set(selectedIds);
  const out: (string | null)[] = [];
  for (const sh of shapes) {
    if (!sel.has(sh.id) || !isFillable(sh)) continue;
    const f = sh.fill ?? null;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** What step a size-dot click means at `step` — the two-mode model. NORMAL zone
 *  (|step| ≤ 1): the dots are ABSOLUTE selectors — small −1 · mid 0 · large +1
 *  (so "large → click small" jumps straight to small). EXTENDED zone (entered by
 *  re-pressing an extreme from at-or-beyond it): the same extreme keeps stepping
 *  OUT, mid still resets to 0, and the OPPOSITE extreme turns into a one-step
 *  walk back IN. The keyboard -/= is always the relative ±1 on top of this. */
export function slotTargetStep(step: number, slot: 0 | 1 | 2): number {
  if (slot === 1) return 0; // mid: absolute reset, from anywhere
  const dir = slot === 2 ? 1 : -1;
  if (step * dir >= 1) return step + dir; // at/past this extreme → further out
  if (step * dir <= -2) return step + dir; // deep past the OPPOSITE → one step back
  return dir; // normal zone → absolute
}

/** Inverse of {@link fontForStroke}: the ladder rung whose text size is nearest
 *  `px` — how a selected text's remembered size lands on the stroke dots. */
export function strokeForFont(px: number): number {
  let best: number = STROKE_LADDER[0];
  for (const w of STROKE_LADDER) if (Math.abs(TEXT_SIZES[w] - px) < Math.abs(TEXT_SIZES[best] - px)) best = w;
  return best;
}

/** Undirected attach adjacency at ROOT-UNIT grain: nodes are root unit keys; any
 *  stored `attach` edge (child→parent) touching any member connects the two UNITS
 *  in both directions — so group↔group glue works by construction. Intra-unit
 *  edges don't self-link. Edges to a missing target are ignored. Arrow/line
 *  `bind` edges are NOT included (they re-cling via {@link reflowBindings}, they
 *  don't drag). */
function attachAdjacency(shapes: Shape[]): Map<string, Set<string>> {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = adj.get(a);
    if (!set) adj.set(a, (set = new Set()));
    set.add(b);
  };
  for (const sh of shapes) {
    if (!sh.attach || isConnector(sh)) continue;
    const target = byId.get(sh.attach.id);
    if (!target) continue;
    const a = rootUnitKeyOf(sh);
    const b = rootUnitKeyOf(target);
    if (a === b) continue;
    link(a, b);
    link(b, a);
  }
  return adj;
}

const CLUSTER_EPS = 1e-6;

/** Drag-propagation weight of a root UNIT: a lone shape keeps {@link
 *  clusterWeight} (strokes massless); a multi-member unit weighs its union-AABB
 *  area — a group is an object even when every member is a stroke, and member
 *  overlap isn't double-counted (docs/groups-design.md). */
function unitWeight(byId: Map<string, Shape>, memberIds: string[]): number {
  if (memberIds.length === 1) return clusterWeight(byId.get(memberIds[0])!);
  const b = contentBounds(memberIds.map((id) => byId.get(id)!));
  return b ? b.width * b.height : 0;
}

/**
 * The full set of shape ids a MOVE of `seedIds` drags along ("largest drags
 * smallest"), at ROOT-UNIT grain:
 *  - seeds expand to their full units, which always move (grabbing = precedence —
 *    selection overrides size);
 *  - from each seed unit, BFS over the UNDIRECTED unit-grained attach graph,
 *    crossing into a neighbor unit iff its {@link unitWeight} < the seed unit's
 *    weight - eps — a heavier OR EQUAL unit blocks its whole subtree. Equal
 *    weight staying put is load-bearing: if equals followed, a same-size glued
 *    pair welded forever (dragging either moved both — they could never be
 *    pulled apart). Move a same-size pair together by multi-selecting it.
 *  - admission is atomic per unit (a unit is dragged whole or not at all);
 *  - plus everything geometrically contained in any dragged container (whole
 *    units, via {@link containedIds}).
 * BFS is per-seed with its own threshold + its own visited set (a unit rejected
 * for a small seed must still be reachable from a bigger seed; the visited set
 * also guarantees termination on legacy cyclic `attach` data). Pure; O(shapes²)
 * worst case, but shape counts are tiny. */
export function moveClusterIds(shapes: Shape[], seedIds: string[]): string[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const units = unitPartition(shapes);
  const adj = attachAdjacency(shapes);
  const weights = new Map<string, number>();
  const weightOf = (key: string) => {
    let w = weights.get(key);
    if (w === undefined) weights.set(key, (w = unitWeight(byId, units.get(key) ?? [])));
    return w;
  };
  const seedKeys = new Set<string>();
  for (const seedId of seedIds) {
    const seed = byId.get(seedId);
    if (seed) seedKeys.add(rootUnitKeyOf(seed));
  }
  const cluster = new Set<string>(); // unit keys
  for (const seedKey of seedKeys) {
    cluster.add(seedKey);
    const threshold = weightOf(seedKey) - CLUSTER_EPS;
    const visited = new Set<string>([seedKey]);
    const queue = [seedKey];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of adj.get(cur) ?? []) {
        if (visited.has(nb)) continue;
        visited.add(nb); // mark even if blocked → a heavier unit blocks its subtree
        if (weightOf(nb) < threshold) {
          cluster.add(nb);
          queue.push(nb);
        }
      }
    }
  }
  const ids = new Set<string>();
  for (const key of cluster) for (const id of units.get(key) ?? []) ids.add(id);
  for (const id of containedIds(shapes, [...ids])) ids.add(id);
  return [...ids];
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
    if (sh.type === "rect" || sh.type === "ellipse" || sh.type === "diamond" || sh.type === "image") {
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

/** Where a bound text's box stays PINNED when its own size changes (typing, the
 *  font-size slots) — the fraction of the box that must not move, per axis:
 *  0 pins the left/top edge (grow right/down — the free-text default), 1 pins
 *  the right/bottom edge (grow left/up), 0.5 pins the center (grow both ways).
 *  Derived from the bond alone: on a seamed axis (box anchor 0 | 1) the child
 *  edge FACING the seam pins — which side the child sits on is the stored
 *  offset's sign — so a text glued above a shape grows upward, away from it.
 *  A seamless axis keeps the default, except the pure-center containment bond
 *  (a caption): that one pins the center on both axes. Radial bonds pin the
 *  along-ray edge (the border gap is what the bond preserves) and center the
 *  cross axis of a near-pole ray (within ±22.5° — the bond centers on the ray,
 *  matching the 8-way quantization boxes get). */
export function growthOrigin(at: Attach | undefined): { gx: number; gy: number } {
  if (!at) return { gx: 0, gy: 0 };
  if (at.kind === "radial") {
    const pole = Math.sin(Math.PI / 8);
    const g = (v: number) => (v < -pole ? 1 : v > pole ? 0 : 0.5);
    return { gx: g(Math.cos(at.angle)), gy: g(Math.sin(at.angle)) };
  }
  const center = at.ax === 0.5 && at.ay === 0.5;
  const g = (a: number, d: number) => (a === 0.5 ? (center ? 0.5 : 0) : d < 0 ? 1 : d > 0 ? 0 : 0.5);
  return { gx: g(at.ax, at.dx), gy: g(at.ay, at.dy) };
}

/** Apply a content/size patch to a text shape and REPOSITION it so its bond's
 *  pinned point (see {@link growthOrigin}) stays put. Callers then restamp the
 *  shape's own anchor and reflow its followers — chips glued to a seam ride
 *  the edge that moved. */
function retypeset(sh: TextShape, patch: Partial<Pick<TextShape, "text" | "fontSize" | "width">>): TextShape {
  const next = { ...sh, ...patch };
  const { gx, gy } = growthOrigin(sh.attach);
  if (!gx && !gy) return next;
  const was = textBlockSize(sh.text, sh.fontSize, sh.width);
  const is = textBlockSize(next.text, next.fontSize, next.width);
  return { ...next, x: next.x - gx * (is.width - was.width), y: next.y - gy * (is.height - was.height) };
}

/** Uniform-scale a unit member about `origin` from its BASE (gesture-start)
 *  geometry: position/extent/points affine; fontSize & strokeWidth ×factor
 *  (continuous values allowed — the toolbar slots highlight nearest); live
 *  INTERNAL glue metrics ×factor (both ends scale together — box dx/dy,
 *  radial/bind gap); image `crop` rects are SOURCE-pixel space — untouched.
 *  Derived from the base each call, so repeated live frames never compound.
 *  Per-member minimum-size clamps deliberately DON'T apply (they'd distort
 *  rigidity; the unit-level screen minimum lives in the view's boundBoxFunc). */
function scaleMemberFrom(base: Shape, memberIds: Set<string>, factor: number, origin: { x: number; y: number }): Shape {
  const px = (x: number) => origin.x + (x - origin.x) * factor;
  const py = (y: number) => origin.y + (y - origin.y) * factor;
  let out: Shape;
  switch (base.type) {
    case "rect":
    case "ellipse":
    case "diamond":
    case "image":
      out = { ...base, x: px(base.x), y: py(base.y), width: base.width * factor, height: base.height * factor };
      break;
    case "text":
      // The wrap box scales with the glyphs — same lines, bigger type.
      out = { ...base, x: px(base.x), y: py(base.y), fontSize: base.fontSize * factor, ...(base.width !== undefined && { width: base.width * factor }) };
      break;
    case "line":
    case "arrow":
      out = {
        ...base,
        points: [px(base.points[0]), py(base.points[1]), px(base.points[2]), py(base.points[3])],
      };
      break;
    case "pen":
      out = { ...base, points: base.points.map((v, i) => (i % 2 === 0 ? px(v) : py(v))) };
      break;
  }
  out.strokeWidth = base.strokeWidth * factor;
  if (out.attach && memberIds.has(out.attach.id)) {
    out.attach =
      out.attach.kind === "box"
        ? { ...out.attach, dx: out.attach.dx * factor, dy: out.attach.dy * factor }
        : { ...out.attach, gap: out.attach.gap * factor };
  }
  if (out.type === "line" || out.type === "arrow") {
    if (out.bindStart && memberIds.has(out.bindStart.id)) out.bindStart = { ...out.bindStart, gap: out.bindStart.gap * factor };
    if (out.bindEnd && memberIds.has(out.bindEnd.id)) out.bindEnd = { ...out.bindEnd, gap: out.bindEnd.gap * factor };
  }
  return out;
}

/** STRETCH a unit member (disproportional axis resize) from its BASE geometry:
 *  internal shapes FOLLOW the scaling — box members (rect/ellipse/image) map
 *  fully affinely per axis (position remaps, width×fx / height×fy), point
 *  members (line/arrow/pen) remap per-point. TEXT is the exception: glyphs
 *  can't stretch, so it keeps its %-position (center remaps affinely) at its
 *  own size. fontSize/strokeWidth never change — there is no uniform factor
 *  (that's the corner-drag {@link scaleMemberFrom}'s job). Bound connectors
 *  are only seeded here — the reflow tail re-clings them to the stretched
 *  targets (bindings win over the raw remap; unbound ones keep the remap). */
function stretchMemberFrom(base: Shape, fx: number, fy: number, origin: { x: number; y: number }): Shape {
  const px = (x: number) => origin.x + (x - origin.x) * fx;
  const py = (y: number) => origin.y + (y - origin.y) * fy;
  switch (base.type) {
    case "rect":
    case "ellipse":
    case "diamond":
    case "image": {
      return { ...base, x: px(base.x), y: py(base.y), width: base.width * fx, height: base.height * fy };
    }
    case "text": {
      // Glyphs can't stretch, but a BOXED text's wrap box does (the lines
      // reflow into the new width); either way the center remaps affinely and
      // the block re-centers there at its own rendered size.
      const b = boundingBox(base);
      const next = base.width !== undefined ? { ...base, width: Math.max(24, base.width * fx) } : base;
      const nb = boundingBox(next);
      return { ...next, x: px(b.x + b.width / 2) - nb.width / 2, y: py(b.y + b.height / 2) - nb.height / 2 };
    }
    case "line":
    case "arrow":
      return { ...base, points: [px(base.points[0]), py(base.points[1]), px(base.points[2]), py(base.points[3])] };
    case "pen":
      return { ...base, points: base.points.map((v, i) => (i % 2 === 0 ? px(v) : py(v))) };
  }
}

/** The shared post-transform settle for a unit whose members just scaled or
 *  stretched (the scaleUnit tail, extracted verbatim):
 *  1. the unit's own OUTWARD anchor (member → non-member) refreshed keep-or-drop
 *     from the new geometry — the target didn't transform, the metrics are stale;
 *  2. followers ride to their (old) anchors against the transformed members;
 *  3. EVERY inbound edge targeting a member re-judged with `distScale`:
 *     keep-or-drop + anchor refresh, metadata-only (the follower stays where the
 *     reflow put it; bound arrows already re-clung via reflowBindings). */
function settleTransformedUnit(shapes: Shape[], memberIds: Set<string>, distScale: number): Shape[] {
  let next = shapes.map((sh) => {
    if (!memberIds.has(sh.id) || !sh.attach || memberIds.has(sh.attach.id)) return sh;
    const target = shapes.find((o) => o.id === sh.attach!.id);
    const at = target ? attachAt(sh, [target], distScale) : undefined;
    if (at) return { ...sh, attach: at };
    const { attach: _drop, ...rest } = sh;
    return rest as Shape;
  });
  next = reflowAll(next, memberIds);
  return next.map((sh) => {
    if (memberIds.has(sh.id) || !sh.attach || !memberIds.has(sh.attach.id) || isConnector(sh)) return sh;
    const target = next.find((o) => o.id === sh.attach!.id);
    const at = target ? attachAt(sh, [target], distScale) : undefined;
    if (at) return { ...sh, attach: at };
    const { attach: _drop, ...rest } = sh;
    return rest as Shape;
  });
}

/** Per-axis metric stretch for a {@link DormantEdge}: box offsets spread with
 *  the layout (dx×fx, dy×fy). Radial gaps/angles are best-effort kept — an
 *  anisotropic stretch has no single factor for a radial distance (the ungroup
 *  settle-reflow absorbs any residual). */
function stretchDormant(d: DormantEdge, fx: number, fy: number): DormantEdge {
  return {
    ...d,
    attach: d.attach && d.attach.kind === "box" ? { ...d.attach, dx: d.attach.dx * fx, dy: d.attach.dy * fy } : d.attach,
  };
}

/** Scale a {@link DormantEdge}'s metrics — dormant edges scale at EVERY level so
 *  a later ungroup restores geometry consistent with the scaled members. */
function scaleDormant(d: DormantEdge, factor: number): DormantEdge {
  return {
    ...d,
    attach: d.attach
      ? d.attach.kind === "box"
        ? { ...d.attach, dx: d.attach.dx * factor, dy: d.attach.dy * factor }
        : { ...d.attach, gap: d.attach.gap * factor }
      : undefined,
    bindStart: d.bindStart ? { ...d.bindStart, gap: d.bindStart.gap * factor } : undefined,
    bindEnd: d.bindEnd ? { ...d.bindEnd, gap: d.bindEnd.gap * factor } : undefined,
  };
}

export type DrawAction =
  | { type: "setTool"; tool: Tool }
  // Arm a one-use cluster (shape = rect/ellipse/diamond, line = line/arrow/double-arrow):
  // select its last-used variant, or — if this cluster is already the active tool —
  // cycle to the next variant. One key/button both selects and switches.
  | { type: "armCluster"; cluster: "shape" | "line" }
  | { type: "setColor"; color: string }
  // Fill (interior / text background): null = none. Mirrors setColor's scope
  // rules; only fillable shapes (rect/ellipse/pen/text) are touched.
  | { type: "setFill"; fill: string | null }
  // Targeted DECLARATION edit (drag one swatch onto another): among the
  // SELECTED shapes, restroke exactly those whose stroke is `from` — the other
  // color classes stay. Ambient prefs untouched (it edits the drawing, not the
  // pen). Images never match (their stroke field doesn't paint).
  | { type: "recolor"; from: string; to: string }
  // Fill counterpart: null = none is a mergeable class too — none→c fills the
  // unfilled, c→none strips exactly that class.
  | { type: "refill"; from: string | null; to: string | null }
  // The shade strip's pick — a CHANGER-PICKER: retune `family`'s armed shade at
  // `level`, durably in the lane. With a selection, every selected shape of
  // that COLUMN at that level repaints to the new shade (one undo step); the
  // ambient pref follows when it operates in that column. Nothing selected →
  // the lane just changes and stays. family "gray" is the specials column:
  // its shades are the GRAYS plus the level special — CONTRAST_INK (stroke) /
  // null = none (fill); smart and none are classes of that column, so they
  // unify along with the grays.
  | { type: "setShade"; level: "stroke" | "fill"; family: LaneColumn; shade: string | null }
  // ` / ⇧` — walk the lane: stroke cycles the specials stop → families, fill
  // likewise, each column contributing its ARMED value (the specials stop
  // paints the armed special — smart/none out of the box, a gray if retuned).
  // Applies exactly like a toolbar click (selection repaint, else ambient).
  | { type: "cyclePaint"; level: "stroke" | "fill"; dir?: 1 | -1 }
  // ⌥` / ⌥⇧` — dig into the current column (the selection's single column at
  // that level when unambiguous, else the ambient's): step its armed shade one
  // rung (wraps) and apply like a strip pick. The specials column steps
  // through [smart|none, ...GRAYS]. Mixed selection → no-op.
  | { type: "cycleShade"; level: "stroke" | "fill"; dir?: 1 | -1 }
  | { type: "setStrokeWidth"; width: number }
  | { type: "setStrokeStyle"; style: StrokeStyle }
  // The lane's end drag-handle: retune the visible palette width live
  // (features.paletteResize boards only). A pref like an unselected
  // setStrokeWidth — never history.
  | { type: "setPaletteSize"; size: number }
  // Select shapes. Non-deep selects NORMALIZE: every id expands to its full root
  // unit (click + marquee + select-all all funnel here). `deep: true` (⌘-click on
  // a member) passes ids through raw — the deep-select context (a proper subset
  // of a unit) that permits only the restricted member edits.
  | { type: "select"; ids: string[]; deep?: boolean }
  | { type: "toggleSelect"; id: string }
  // ⌘G group: stamp the minted `gid` (ids-from-the-view law — the reducer stays
  // pure) onto every member of the ≥2 selected units. Guarded like history ops.
  | { type: "groupSelection"; gid: string }
  // ⌘G ungroup: dissolve ONE level of the single exactly-covered selected group.
  | { type: "ungroup" }
  // Live frame of a proxy-rect unit scale: restamp member geometry from the
  // gestureBase snapshot (absolute factor — no compounding), reflow followers.
  | { type: "scaleUnitGhost"; ids: string[]; factor: number; origin: { x: number; y: number } }
  // Commit a uniform unit scale: full bake (geometry affine, fontSize/strokeWidth
  // ×factor, live internal + dormant glue metrics ×factor, crop untouched) + the
  // inbound-edge re-judge pass. History-NEUTRAL inside begin/endGesture, like
  // commitResize. `distScale` keeps glue judgments screen-true.
  | { type: "scaleUnit"; ids: string[]; factor: number; origin: { x: number; y: number }; distScale?: number }
  // Live frame of a proxy-rect unit STRETCH (side-anchor disproportional
  // resize): members FOLLOW the scaling (boxes affine per axis incl. size,
  // points per-point; text keeps %-position at its own size). Derived from
  // gestureBase — no compounding.
  | { type: "stretchUnitGhost"; ids: string[]; fx: number; fy: number; origin: { x: number; y: number } }
  // Commit a unit stretch: geometry as the ghost, then intra-unit anchors
  // RE-DERIVED from the final geometry (kept verbatim where underivable),
  // dormant box offsets ×fx/×fy, and the same outward-refresh + reflow +
  // inbound re-judge tail as scaleUnit. History-NEUTRAL inside begin/endGesture.
  | { type: "stretchUnit"; ids: string[]; fx: number; fy: number; origin: { x: number; y: number }; distScale?: number }
  // Record the size-control step on a unit's members (dispatched inside the same
  // gesture as its scaleUnit, so the geometry + stamp are one undo entry).
  | { type: "stampSizeStep"; ids: string[]; step: number }
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
  | { type: "setText"; id: string; text: string; width?: number; distScale?: number }
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
 *  offset sits within ATTACH_DIST — detecting would weld every copy to its original).
 *  Group ids remap per batch too (prefix-preserving — a pasted group is a NEW
 *  group, never welded to the original), dormant-edge targets remap through the
 *  same id map (entries whose target or level left the batch drop — else
 *  ungrouping a pasted copy welds it to the ORIGINAL), and groups reduced to a
 *  single member by a partial-batch copy collapse. */
export function clonePastedShapes(clipboard: Shape[], dx: number, dy: number, newId: () => string): Shape[] {
  const idMap = new Map<string, string>();
  for (const sh of clipboard) idMap.set(sh.id, newId());
  const gidMap = new Map<string, string>();
  const gidCount = new Map<string, number>(); // members per gid in THIS batch (for singleton collapse)
  for (const sh of clipboard) {
    for (const gid of sh.groupPath ?? []) {
      if (!gidMap.has(gid)) gidMap.set(gid, newId());
      gidCount.set(gid, (gidCount.get(gid) ?? 0) + 1);
    }
  }
  return clipboard.map((sh) => {
    const clone = offsetShape(cloneShape(sh), dx, dy);
    clone.id = idMap.get(sh.id)!;
    if (sh.groupPath) {
      const path = sh.groupPath.filter((gid) => (gidCount.get(gid) ?? 0) >= 2).map((gid) => gidMap.get(gid)!);
      clone.groupPath = path.length ? path : undefined;
    }
    if (sh.dormant) {
      const kept = sh.dormant
        .filter((d) => (gidCount.get(d.gid) ?? 0) >= 2) // its level survived the copy
        .map((d) => ({
          gid: gidMap.get(d.gid)!,
          attach: d.attach && idMap.has(d.attach.id) ? { ...d.attach, id: idMap.get(d.attach.id)! } : undefined,
          bindStart: d.bindStart && idMap.has(d.bindStart.id) ? { ...d.bindStart, id: idMap.get(d.bindStart.id)! } : undefined,
          bindEnd: d.bindEnd && idMap.has(d.bindEnd.id) ? { ...d.bindEnd, id: idMap.get(d.bindEnd.id)! } : undefined,
        }))
        .filter((d) => d.attach || d.bindStart || d.bindEnd); // target(s) left the batch → dead entry
      clone.dormant = kept.length ? kept : undefined;
    }
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

/** Import/open normalization (cross-version safety): docs edited by app versions
 *  that don't know `groupPath` can hold duplicated gids across unrelated
 *  assemblies, sheared "rigid" groups, or singleton paths. Normalize by
 *  (1) prefix-context gid dedupe — a gid appearing under DIFFERENT parent
 *  prefixes is two different groups, split with derived fresh gids (connected
 *  components at each nesting level) — and (2) singleton collapse (a gid with
 *  exactly one member strips out). Dormant entries whose gid left the owner's
 *  path drop. Geometry violations aren't undone — the damage is made
 *  well-formed, not repaired (stated limitation). Returns the SAME array when
 *  nothing needed fixing. */
export function normalizeGroups(shapes: Shape[]): Shape[] {
  // Pass 1 — dedupe: instance key = the gid in its full parent-prefix context.
  // The first context keeps the original gid; later contexts derive stable
  // fresh ids (opaque strings — only prefix-consistency matters).
  const contextGid = new Map<string, string>(); // "prefix→gid" → effective gid
  const firstContextOf = new Map<string, string>(); // gid → first seen prefix key
  const effectivePath = (path: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < path.length; i++) {
      const gid = path[i];
      // NUL-joined so a gid can never collide with a prefix boundary. Built
      // via fromCharCode: a literal NUL byte in source makes greps read the
      // whole file as binary.
      const prefixKey = [...out, gid].join(String.fromCharCode(0));
      let eff = contextGid.get(prefixKey);
      if (!eff) {
        const first = firstContextOf.get(gid);
        if (first === undefined) {
          firstContextOf.set(gid, prefixKey);
          eff = gid;
        } else {
          eff = first === prefixKey ? gid : `${gid}:${contextGid.size}`;
        }
        contextGid.set(prefixKey, eff);
      }
      out.push(eff);
    }
    return out;
  };
  const paths = shapes.map((sh) => (sh.groupPath?.length ? effectivePath(sh.groupPath) : undefined));
  // Pass 2 — singleton collapse on the deduped paths.
  const count = new Map<string, number>();
  for (const path of paths) for (const gid of path ?? []) count.set(gid, (count.get(gid) ?? 0) + 1);
  let changed = false;
  const next = shapes.map((sh, i) => {
    const deduped = paths[i];
    const path = deduped?.filter((gid) => (count.get(gid) ?? 0) >= 2);
    const samePath =
      (sh.groupPath === undefined && (path === undefined || path.length === 0)) ||
      (!!sh.groupPath && !!path && path.length === sh.groupPath.length && path.every((g, j) => g === sh.groupPath![j]));
    // Dormant gids follow the owner's own dedupe remap (level i original →
    // effective); entries whose level collapsed or left the path drop.
    const gidRemap = new Map<string, string>();
    sh.groupPath?.forEach((orig, j) => gidRemap.set(orig, deduped![j]));
    const pathSet = new Set(path ?? []);
    const dormant = sh.dormant
      ?.map((d) => {
        const eff = gidRemap.get(d.gid);
        return eff && pathSet.has(eff) ? (eff === d.gid ? d : { ...d, gid: eff }) : undefined;
      })
      .filter((d): d is DormantEdge => !!d);
    const sameDormant =
      (sh.dormant?.length ?? 0) === (dormant?.length ?? 0) && (dormant ?? []).every((d, j) => d === sh.dormant![j]);
    // A size-control stamp is only meaningful on group members and loose images
    // — heal anything else (e.g. a collapse just stripped the path).
    const stripStep = sh.sizeStep !== undefined && !path?.length && sh.type !== "image";
    if (samePath && sameDormant && !stripStep) return sh;
    changed = true;
    return {
      ...sh,
      groupPath: path?.length ? path : undefined,
      dormant: dormant?.length ? dormant : undefined,
      sizeStep: stripStep ? undefined : sh.sizeStep,
    };
  });
  return changed ? next : shapes;
}

const keepExisting = (ids: string[], shapes: Shape[]) => ids.filter((id) => shapes.some((sh) => sh.id === id));

/** The lane sync on selection: pull each selected class's shade into its
 *  column's armed slot (per level) — the lane becomes the palette the
 *  selection operates in. Specials classes (smart / a gray / none) pull into
 *  the specials slot the same way. Durable (survives deselect); within a
 *  column the last class in paint order wins. */
function syncShadesFrom(s: DrawState, selectedIds: string[]): Pick<DrawState, "strokeShades" | "fillShades" | "strokeSpecial" | "fillSpecial"> {
  let { strokeShades, fillShades, strokeSpecial, fillSpecial } = s;
  for (const c of selectionStrokes(s.shapes, selectedIds)) {
    const f = familyOf(c);
    if (f) {
      if (strokeShades[f] !== c.toLowerCase()) strokeShades = { ...strokeShades, [f]: c.toLowerCase() };
    } else if (isContrastInk(c)) strokeSpecial = CONTRAST_INK;
    else if (isNoStroke(c)) {
      // Pull only where the option exists — on a fills-off board a loaded
      // doc's strokeless shapes stay selectable, but never re-arm the pen
      // with an ink the board can't offer.
      if (s.features.fills) strokeSpecial = NO_STROKE;
    } else if (isGray(c)) strokeSpecial = c.toLowerCase();
  }
  for (const c of selectionFills(s.shapes, selectedIds)) {
    if (c === null) {
      fillSpecial = null;
      continue;
    }
    const f = familyOf(c);
    if (f) {
      if (fillShades[f] !== c.toLowerCase()) fillShades = { ...fillShades, [f]: c.toLowerCase() };
    } else if (isGray(c)) fillSpecial = c.toLowerCase();
  }
  return { strokeShades, fillShades, strokeSpecial, fillSpecial };
}

/** The column ⌥` digs into: the selection's SINGLE column at `level` when
 *  unambiguous, else the ambient's. Mixed columns → null (no guessing).
 *  Adaptive / none / the grays anchor the specials column — a fresh board
 *  digs straight into the gray ramp. */
function effectiveColumn(s: DrawState, level: "stroke" | "fill"): LaneColumn | null {
  if (s.selectedIds.length) {
    const classes = level === "stroke" ? selectionStrokes(s.shapes, s.selectedIds) : selectionFills(s.shapes, s.selectedIds);
    const cols = [...new Set(classes.map((c) => (level === "stroke" ? strokeColumnOf(c as string) : fillColumnOf(c))))].filter(
      (c): c is LaneColumn => c !== null
    );
    if (cols.length === 1) return cols[0];
    if (cols.length > 1) return null;
  }
  return level === "stroke" ? strokeColumnOf(s.color) : fillColumnOf(s.fill);
}

export function drawReducer(s: DrawState, a: DrawAction): DrawState {
  switch (a.type) {
    case "setTool":
      // Leaving select drops the selection (its handles shouldn't linger while
      // drawing). Picking a selectable tool remembers it as the snap-back base;
      // picking a cluster variant directly updates that cluster's memory.
      // A shape kind the host opted out of can't be armed (feature re-guard —
      // the UI already hides its button/key).
      if (isShapeTool(a.tool) && !s.features.shapes.includes(a.tool)) return s;
      return {
        ...s,
        tool: a.tool,
        baseTool: isSelectable(a.tool) ? a.tool : s.baseTool,
        selectedIds: a.tool === "select" ? s.selectedIds : [],
        shapeVariant: a.tool === "rect" || a.tool === "ellipse" || a.tool === "diamond" ? a.tool : s.shapeVariant,
        lineVariant: a.tool === "line" || a.tool === "arrow" || a.tool === "darrow" ? a.tool : s.lineVariant,
      };
    case "armCluster": {
      // Cluster membership honors the host's shape list — disabled variants
      // are skipped by the cycle and can't be retyped INTO (retyping AWAY from
      // a disabled variant in a loaded doc stays possible: only creation-like
      // moves are gated). An all-disabled cluster is inert.
      const all: readonly ShapeTool[] = a.cluster === "shape" ? SHAPE_VARIANTS : LINE_VARIANTS;
      const members: readonly Tool[] = all.filter((t) => s.features.shapes.includes(t));
      if (members.length === 0) return s;
      const remembered = a.cluster === "shape" ? s.shapeVariant : s.lineVariant;

      // Selection retype: when the selection is non-empty and lies ENTIRELY within
      // this cluster (all shapes, all connectors, or a single one), the cluster tool
      // retypes the SELECTION instead of arming a draw tool — first unifying every
      // selected shape to the cluster's current variant, then (once they all match)
      // cycling them to the next variant. Selection + tool are kept so repeated taps
      // keep cycling. Undoable (commit).
      const sel = s.shapes.filter((sh) => s.selectedIds.includes(sh.id));
      if (sel.length > 0 && sel.every((sh) => clusterOf(sh) === a.cluster)) {
        // Retype applies to LOOSE shapes only — grouped members are never retyped
        // (a disallowed shape edit while grouped). All-grouped selection → total
        // no-op: no history entry, no variant cycle, no tool arm.
        const loose = sel.filter((sh) => !sh.groupPath);
        if (loose.length === 0) return s;
        const allMatch = loose.every((sh) => variantOf(sh) === remembered);
        const idx = members.indexOf(remembered);
        const target = (allMatch ? members[(idx + 1) % members.length] : remembered) as ShapeVariant | LineVariant;
        const retyped = reflowAll(mapShapes(s.shapes, new Set(loose.map((sh) => sh.id)), (sh) => toClusterVariant(sh, target)), new Set());
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
    case "setFill": {
      // Mirrors setColor: live-refill a draft, else the selection (undoable),
      // else just the pref. Segments/images carry no interior to fill; "none"
      // drops the field (persisted docs stay slim) — see applyFill.
      if (s.draftId) {
        return { ...s, fill: a.fill, shapes: mapShapes(s.shapes, new Set([s.draftId]), (sh) => applyFill(sh, a.fill)) };
      }
      if (s.selectedIds.length) {
        return { ...commit(s, mapShapes(s.shapes, new Set(s.selectedIds), (sh) => applyFill(sh, a.fill))), fill: a.fill };
      }
      return { ...s, fill: a.fill };
    }
    case "recolor": {
      // Drag-a-swatch-onto-another: restroke exactly the `from` class within
      // the selection. Grouped members recolor like any member (color is an
      // allowed group edit); images never match. No-ops return s untouched —
      // no empty history entries.
      if (!s.selectedIds.length || a.from === a.to) return s;
      const sel = new Set(s.selectedIds);
      const hit = (sh: Shape) => sel.has(sh.id) && sh.type !== "image" && sh.stroke.toLowerCase() === a.from.toLowerCase();
      if (!s.shapes.some(hit)) return s;
      return commit(s, s.shapes.map((sh) => (hit(sh) ? { ...sh, stroke: a.to } : sh)));
    }
    case "refill": {
      // Fill-class merge (null = the unfilled class). Same no-op guards.
      const from = a.from?.toLowerCase() ?? null;
      if (!s.selectedIds.length || from === (a.to?.toLowerCase() ?? null)) return s;
      const sel = new Set(s.selectedIds);
      const hit = (sh: Shape) => sel.has(sh.id) && isFillable(sh) && (sh.fill?.toLowerCase() ?? null) === from;
      if (!s.shapes.some(hit)) return s;
      return commit(s, s.shapes.map((sh) => (hit(sh) ? applyFill(sh, a.to) : sh)));
    }
    case "setShade": {
      const isStroke = a.level === "stroke";
      // Guard: the shade must belong to the column at this level (the view only
      // sends valid picks; a stray value must not corrupt the lane). The
      // specials column accepts its grays plus the level specials — smart and
      // no-stroke (fills-boards only) for strokes, none for fills.
      if (a.family === "gray") {
        const ok = isStroke
          ? a.shade !== null && (isGray(a.shade) || isContrastInk(a.shade) || (isNoStroke(a.shade) && s.features.fills))
          : a.shade === null || isGray(a.shade);
        if (!ok) return s;
      } else if (a.shade === null || familyOf(a.shade) !== a.family) return s;
      const shade = a.shade === null ? null : a.shade.toLowerCase();
      const gray = a.family === "gray";
      // Membership: does a value operate in this column at this level? (For the
      // specials column that's smart + no-stroke + grays on strokes, none +
      // grays on fills.)
      const inCol = (v: string | null | undefined): boolean =>
        gray
          ? isStroke
            ? v != null && (isContrastInk(v) || isNoStroke(v) || isGray(v))
            : v == null || isGray(v)
          : v != null && familyOf(v) === a.family;
      const armed = a.family === "gray" ? (isStroke ? s.strokeSpecial : s.fillSpecial) : (isStroke ? s.strokeShades : s.fillShades)[a.family];
      const laneChanged = armed !== shade;
      // Ambient follows when it operates in this column — the pen keeps
      // painting the column you just retuned (other columns stay put).
      const ambient = isStroke ? s.color : s.fill;
      const follows = inCol(ambient) && (ambient === null ? null : ambient.toLowerCase()) !== shade;
      const base: DrawState = {
        ...s,
        ...(gray
          ? isStroke
            ? { strokeSpecial: shade as string }
            : { fillSpecial: shade }
          : isStroke
            ? { strokeShades: { ...s.strokeShades, [a.family]: shade as string } }
            : { fillShades: { ...s.fillShades, [a.family]: shade as string } }),
        ...(follows ? (isStroke ? { color: shade as string } : { fill: shade }) : {}),
      };
      // With a selection the retune reaches the drawing: every selected shape
      // of this column at this level unifies onto the new shade (any rung —
      // "replace the color in the line", not a single-class merge).
      if (s.selectedIds.length) {
        const sel = new Set(s.selectedIds);
        const hit = (sh: Shape) =>
          sel.has(sh.id) &&
          (isStroke
            ? sh.type !== "image" && inCol(sh.stroke) && sh.stroke.toLowerCase() !== shade
            : isFillable(sh) && inCol(sh.fill ?? null) && (sh.fill?.toLowerCase() ?? null) !== shade);
        if (s.shapes.some(hit)) {
          return commit(base, s.shapes.map((sh) => (hit(sh) ? (isStroke ? { ...sh, stroke: shade as string } : applyFill(sh, shade)) : sh)));
        }
      }
      return laneChanged || follows ? base : s;
    }
    case "cyclePaint": {
      if (s.features.paletteSize === 1) return s; // single-color board — no lane to cycle
      if (a.level === "fill" && !s.features.fills) return s; // fills opted out — ⇧` is inert
      const dir = a.dir ?? 1;
      const fams = visibleHueFamilies(s.features.paletteSize);
      const n = fams.length + 1; // the specials column + the VISIBLE families
      if (a.level === "stroke") {
        const col = strokeColumnOf(s.color);
        const fi = col === null || col === "gray" ? -1 : fams.indexOf(col);
        const idx = fi < 0 ? 0 : 1 + fi; // a hidden family's color cycles like any foreign hex
        const next = (idx + dir + n) % n;
        return drawReducer(s, { type: "setColor", color: next === 0 ? s.strokeSpecial : s.strokeShades[fams[next - 1]] });
      }
      const col = fillColumnOf(s.fill);
      const fi = col === null || col === "gray" ? -1 : fams.indexOf(col);
      const idx = fi < 0 ? 0 : 1 + fi;
      const next = (idx + dir + n) % n;
      return drawReducer(s, { type: "setFill", fill: next === 0 ? s.fillSpecial : s.fillShades[fams[next - 1]] });
    }
    case "cycleShade": {
      if (s.features.paletteSize === 1) return s; // no lane → no shade strips either
      if (a.level === "fill" && !s.features.fills) return s;
      const dir = a.dir ?? 1;
      const col = effectiveColumn(s, a.level);
      if (!col) return s;
      if (col === "gray") {
        // The specials strip: the level specials lead, then the gray ramp
        // (no-stroke only where fills exist — see NO_STROKE).
        const palette: readonly (string | null)[] =
          a.level === "stroke" ? [CONTRAST_INK, ...(s.features.fills ? [NO_STROKE] : []), ...GRAYS] : [null, ...GRAYS];
        const armed = a.level === "stroke" ? s.strokeSpecial : s.fillSpecial;
        const cur = palette.indexOf(armed === null ? null : armed.toLowerCase());
        const next = palette[((cur < 0 ? 0 : cur) + dir + palette.length) % palette.length];
        return drawReducer(s, { type: "setShade", level: a.level, family: "gray", shade: next });
      }
      const lane = a.level === "stroke" ? s.strokeShades : s.fillShades;
      const cur = SHADES[col].indexOf(lane[col]);
      const next = SHADES[col][((cur < 0 ? BASE_SHADE : cur) + dir + SHADES[col].length) % SHADES[col].length];
      return drawReducer(s, { type: "setShade", level: a.level, family: col, shade: next });
    }
    case "setStrokeWidth": {
      if (s.draftId) {
        return { ...s, strokeWidth: a.width, shapes: mapShapes(s.shapes, new Set([s.draftId]), (sh) => ({ ...sh, strokeWidth: a.width })) };
      }
      if (s.selectedIds.length) {
        // For text the stroke slots mean font size (small/medium/large) —
        // retypeset so a bound text grows away from its glued edge, then
        // restamp each text's own anchor and reflow followers (same contract
        // as setText: the pinned seam holds, glued chips ride the moved edges).
        const sel = new Set(s.selectedIds);
        let next = mapShapes(s.shapes, sel, (sh) =>
          sh.type === "text" ? retypeset(sh, { fontSize: fontForStroke(a.width) }) : { ...sh, strokeWidth: a.width }
        );
        if (s.shapes.some((sh) => sel.has(sh.id) && sh.type === "text")) {
          for (const sh of s.shapes) if (sel.has(sh.id) && sh.type === "text") next = refreshOwnAnchor(next, sh.id);
          next = reflowAll(next, sel);
        }
        return { ...commit(s, next), strokeWidth: a.width };
      }
      return { ...s, strokeWidth: a.width };
    }
    case "setStrokeStyle": {
      // Mirrors setColor: live-restyle a draft, else the selection (undoable),
      // else just the pref. Text/images carry no stroke outline to style.
      const styled = (sh: Shape): Shape => (sh.type === "text" || sh.type === "image" ? sh : { ...sh, strokeStyle: a.style });
      if (s.draftId) {
        return { ...s, strokeStyle: a.style, shapes: mapShapes(s.shapes, new Set([s.draftId]), styled) };
      }
      if (s.selectedIds.length) {
        return { ...commit(s, mapShapes(s.shapes, new Set(s.selectedIds), styled)), strokeStyle: a.style };
      }
      return { ...s, strokeStyle: a.style };
    }
    case "setPaletteSize": {
      // No-op where the handle can't exist: a fixed-width (paletteResize off)
      // or single-color board keeps the host's exact config. Floor 2, not 1:
      // width 1 unmounts the whole lane — the handle included — a trap the
      // drag must never reach (single-color stays a host-only config).
      if (!s.features.paletteResize || s.features.paletteSize === 1) return s;
      if (typeof a.size !== "number" || !Number.isFinite(a.size)) return s;
      const size = Math.max(2, Math.min(MAX_PALETTE, Math.round(a.size)));
      if (size === s.features.paletteSize) return s;
      return { ...s, features: { ...s.features, paletteSize: size } };
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
    case "select": {
      // Selecting also SYNCS the lane: the columns retune to the shades the
      // selection operates in (see syncShadesFrom).
      const ids = a.deep ? a.ids : expandIdsToUnits(s.shapes, a.ids);
      return { ...s, selectedIds: ids, ...syncShadesFrom(s, ids) };
    }
    case "toggleSelect": {
      // Unit-grained: if ANY member of the clicked unit is selected, remove ALL
      // its member ids, else add all (an id-then-expand toggle could never
      // deselect a unit).
      const sh = s.shapes.find((o) => o.id === a.id);
      if (!sh) return s;
      const memberIds = expandIdsToUnits(s.shapes, [a.id]);
      const members = new Set(memberIds);
      const anySelected = s.selectedIds.some((id) => members.has(id));
      const selectedIds = anySelected
        ? s.selectedIds.filter((id) => !members.has(id))
        : [...s.selectedIds.filter((id) => !members.has(id)), ...memberIds];
      return { ...s, selectedIds, ...syncShadesFrom(s, selectedIds) };
    }
    case "groupSelection": {
      // Guarded like history ops: a mid-drag ⌘G would corrupt the open gesture's
      // history pair and the live move cluster. (The view additionally gates on a
      // live camera-bitmap cache.)
      if (s.gestureBase || s.draftId) return s;
      const memberIds = expandIdsToUnits(s.shapes, s.selectedIds);
      const members = new Set(memberIds);
      const childUnits = new Set(s.shapes.filter((sh) => members.has(sh.id)).map(rootUnitKeyOf));
      if (childUnits.size < 2) return s; // incl. would-be single-member groups
      const next = mapShapes(s.shapes, members, (sh) => {
        // sizeStep resets: a fresh group is at its natural ("medium") size, and
        // any member's own control history dies with its loose life.
        const out: Shape = { ...sh, groupPath: [a.gid, ...(sh.groupPath ?? [])], sizeStep: undefined };
        // Sever OUTWARD edges (attach + connector binds to non-members) — undo
        // restores exactly; a still-touching neighbor re-glues on the next drag.
        // Internal edges CROSSING between the forming group's child units park in
        // the level-keyed dormant stash; same-child-unit edges stay live (inert
        // under rigidity, live again after ungroup). Inbound edges are untouched.
        let stash: DormantEdge | undefined;
        const park = (edge: Partial<Omit<DormantEdge, "gid">>) => {
          stash = { gid: a.gid, ...(stash ?? {}), ...edge };
        };
        const crossesChildUnits = (targetId: string) => {
          const target = s.shapes.find((o) => o.id === targetId);
          return !!target && rootUnitKeyOf(target) !== rootUnitKeyOf(sh);
        };
        if (out.attach) {
          if (!members.has(out.attach.id)) out.attach = undefined;
          else if (crossesChildUnits(out.attach.id)) {
            park({ attach: out.attach });
            out.attach = undefined;
          }
        }
        if (out.type === "line" || out.type === "arrow") {
          if (out.bindStart) {
            if (!members.has(out.bindStart.id)) out.bindStart = undefined;
            else if (crossesChildUnits(out.bindStart.id)) {
              park({ bindStart: out.bindStart });
              out.bindStart = undefined;
            }
          }
          if (out.bindEnd) {
            if (!members.has(out.bindEnd.id)) out.bindEnd = undefined;
            else if (crossesChildUnits(out.bindEnd.id)) {
              park({ bindEnd: out.bindEnd });
              out.bindEnd = undefined;
            }
          }
        }
        if (stash) out.dormant = [...(out.dormant ?? []), stash];
        return out;
      });
      // Post-state: selection = the new unit's members (⌘G⌘G round-trips).
      return { ...commit(s, next), selectedIds: memberIds };
    }
    case "ungroup": {
      if (s.gestureBase || s.draftId) return s;
      if (groupActionFor(s.shapes, s.selectedIds) !== "ungroup") return s;
      const members = new Set(s.selectedIds);
      const gid = s.shapes.find((sh) => members.has(sh.id))!.groupPath![0];
      const ids = new Set(s.shapes.map((sh) => sh.id));
      const next = mapShapes(s.shapes, members, (sh) => {
        const path = sh.groupPath!.slice(1);
        // The dissolved unit's control steps die with it — every freed shape's
        // current size becomes its natural size.
        const out: Shape = { ...sh, groupPath: path.length ? path : undefined, sizeStep: undefined };
        // Restore THIS gid's dormant entries — only into EMPTY slots (a live
        // outward edge stamped during the group's life wins); drop entries whose
        // target no longer exists. The stash dies with its level either way.
        const mine = (out.dormant ?? []).filter((d) => d.gid === gid);
        const rest = (out.dormant ?? []).filter((d) => d.gid !== gid);
        out.dormant = rest.length ? rest : undefined;
        for (const d of mine) {
          if (d.attach && !out.attach && ids.has(d.attach.id)) out.attach = d.attach;
          if ((out.type === "line" || out.type === "arrow") && (d.bindStart || d.bindEnd)) {
            const seg = out as SegmentShape;
            if (d.bindStart && !seg.bindStart && ids.has(d.bindStart.id)) seg.bindStart = d.bindStart;
            if (d.bindEnd && !seg.bindEnd && ids.has(d.bindEnd.id)) seg.bindEnd = d.bindEnd;
          }
        }
        return out;
      });
      // Selection unchanged (now the freed members); settle restored glue.
      return commit(s, reflowAll(next, new Set()));
    }

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
          if (sh.type === "rect" || sh.type === "ellipse" || sh.type === "diamond") {
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
      let draft = s.shapes.find((sh) => sh.id === s.draftId);
      const base = s.gestureBase ?? s.shapes;
      const distScale = a.distScale ?? 1;
      let shapes = s.shapes;
      // Drop a degenerate draft (a click that didn't drag) — EXCEPT the pen:
      // a pencil touching the canvas marks. The tap commits as an epsilon
      // segment the round line cap inflates to a strokeWidth-diameter dot in
      // every renderer (the zero-length-dash trick the dotted style rides on;
      // TRUE zero-length segments are elided by canvas renderers).
      if (draft && isDegenerate(draft, a.minSize ?? 2)) {
        if (draft.type !== "pen") return { ...s, shapes: base, draftId: null, gestureBase: null };
        const [x, y] = draft.points;
        const dot: Shape = { ...draft, points: [x, y, x + PEN_DOT_EPS, y] };
        draft = dot;
        shapes = mapShapes(s.shapes, new Set([dot.id]), () => dot);
      }
      let normalized = shapes;
      if (draft && (draft.type === "rect" || draft.type === "ellipse" || draft.type === "diamond")) {
        normalized = mapShapes(shapes, new Set([draft.id]), (sh) => normalizeBox(sh as BoxShape));
        // A shape drawn edge-to-edge with another attaches to it (like an arrow
        // binds) — so drawing a box on/against a shape links them.
        const drawn = normalized.find((sh) => sh.id === draft.id)!;
        const attach = attachAt(drawn, normalized, distScale);
        if (attach) normalized = mapShapes(normalized, new Set([draft.id]), (sh) => ({ ...sh, attach } as Shape));
      } else if (draft && (draft.type === "line" || draft.type === "arrow")) {
        // Bind each endpoint drawn near an area shape, capturing its polar offset
        // relative to the other endpoint — stays where drawn, rotates on move.
        const [x1, y1, x2, y2] = draft.points;
        const bindStart = bindAt({ x: x1, y: y1 }, { x: x2, y: y2 }, shapes, draft.id, BIND_DISTANCE * distScale);
        const bindEnd = bindAt({ x: x2, y: y2 }, { x: x1, y: y1 }, shapes, draft.id, BIND_DISTANCE * distScale);
        normalized = mapShapes(shapes, new Set([draft.id]), (sh) => ({ ...sh, bindStart, bindEnd } as Shape));
      } else if (draft && draft.type === "pen") {
        // A scribble drawn edge-to-edge with a shape attaches to it (like a box) —
        // so annotating a shape with a stroke glues them (it's massless: it follows
        // but never pulls). (attachAt skips the draft itself.)
        const attach = attachAt(draft, shapes, distScale);
        if (attach) normalized = mapShapes(shapes, new Set([draft.id]), (sh) => ({ ...sh, attach } as Shape));
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
      // Group guard: a partial-unit id set EXPANDS to full units — members are
      // never translated individually (never partial-translate, never drop).
      const ids = new Set(expandIdsToUnits(s.shapes, a.ids));
      // NEW LAW (§2.2): an attached shape follows a move ONLY by being in `ids`
      // (the view passes the full size-gated cluster via moveClusterIds). A shape
      // OUTSIDE `ids` whose `attach` points INTO the moved set was deliberately
      // excluded (too heavy) — FREEZE it so the reflow doesn't drag it toward the
      // moved parent, at UNIT grain: exclusion is atomic per unit, so the whole
      // excluded unit freezes (a rigid unit can't have one frozen member).
      // (Transitive freeze is unnecessary: a frozen unit doesn't move, so its own
      // followers' targets don't move either.) Bound arrows still re-cling via
      // reflowBindings.
      const frozenUnits = new Set<string>();
      for (const sh of s.shapes) if (sh.attach && ids.has(sh.attach.id) && !ids.has(sh.id)) frozenUnits.add(rootUnitKeyOf(sh));
      const frozen = s.shapes.filter((sh) => !ids.has(sh.id) && frozenUnits.has(rootUnitKeyOf(sh))).map((sh) => sh.id);
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
    case "scaleUnitGhost": {
      // LIVE unit-scale frame (model-driven — never imperative node scaling,
      // which would fight the element caches): restamp member geometry from the
      // gestureBase snapshot at the absolute factor, then reflow so inbound
      // followers ride the scaling unit. No history, no dormant/outward bakes.
      if (!s.gestureBase) return s;
      const memberIds = new Set(expandIdsToUnits(s.gestureBase, a.ids));
      const baseById = new Map(s.gestureBase.map((sh) => [sh.id, sh]));
      const next = s.shapes.map((sh) => {
        const b = baseById.get(sh.id);
        return memberIds.has(sh.id) && b ? scaleMemberFrom(b, memberIds, a.factor, a.origin) : sh;
      });
      return { ...s, shapes: reflowAll(next, memberIds) };
    }
    case "scaleUnit": {
      // Commit a uniform unit scale (full bake list — docs/groups-design.md).
      // Computed from the gestureBase snapshot at the absolute factor, so the
      // ghost-frames-then-commit and direct-dispatch paths converge identically.
      const base = s.gestureBase ?? s.shapes;
      const memberIds = new Set(expandIdsToUnits(base, a.ids));
      if (!memberIds.size) return s;
      const distScale = a.distScale ?? 1;
      const baseById = new Map(base.map((sh) => [sh.id, sh]));
      let next = s.shapes.map((sh) => {
        const b = baseById.get(sh.id);
        if (!memberIds.has(sh.id) || !b) return sh;
        const scaled = scaleMemberFrom(b, memberIds, a.factor, a.origin);
        if (scaled.dormant) scaled.dormant = scaled.dormant.map((d) => scaleDormant(d, a.factor));
        return scaled;
      });
      // History-neutral: the surrounding gesture's endGesture owns the push.
      return { ...s, shapes: settleTransformedUnit(next, memberIds, distScale) };
    }
    case "stampSizeStep": {
      // History-neutral like scaleUnit — the surrounding gesture commits both.
      const set = new Set(a.ids);
      return { ...s, shapes: mapShapes(s.shapes, set, (sh) => ({ ...sh, sizeStep: a.step === 0 ? undefined : a.step })) };
    }
    case "stretchUnitGhost": {
      // LIVE stretch frame — mirror of scaleUnitGhost with the stretch bake.
      if (!s.gestureBase) return s;
      const memberIds = new Set(expandIdsToUnits(s.gestureBase, a.ids));
      const baseById = new Map(s.gestureBase.map((sh) => [sh.id, sh]));
      const next = s.shapes.map((sh) => {
        const b = baseById.get(sh.id);
        return memberIds.has(sh.id) && b ? stretchMemberFrom(b, a.fx, a.fy, a.origin) : sh;
      });
      return { ...s, shapes: reflowAll(next, memberIds) };
    }
    case "stretchUnit": {
      // Commit a disproportional unit stretch (side-anchor resize): remap
      // members from the gestureBase (boxes stretch, text keeps %-position),
      // re-derive INTRA-unit anchors from the final geometry (an anisotropic
      // stretch has no single metric factor; underivable edges are kept
      // verbatim and settle at ungroup), stretch dormant offsets, then the
      // shared settle tail — whose reflow re-clings bound member connectors
      // to the stretched targets (bindings win; unbound ones keep the remap).
      const base = s.gestureBase ?? s.shapes;
      const memberIds = new Set(expandIdsToUnits(base, a.ids));
      if (!memberIds.size) return s;
      const distScale = a.distScale ?? 1;
      const baseById = new Map(base.map((sh) => [sh.id, sh]));
      let next = s.shapes.map((sh) => {
        const b = baseById.get(sh.id);
        if (!memberIds.has(sh.id) || !b) return sh;
        const stretched = stretchMemberFrom(b, a.fx, a.fy, a.origin);
        if (stretched.dormant) stretched.dormant = stretched.dormant.map((d) => stretchDormant(d, a.fx, a.fy));
        return stretched;
      });
      next = next.map((sh) => {
        if (!memberIds.has(sh.id) || !sh.attach || !memberIds.has(sh.attach.id)) return sh;
        const target = next.find((o) => o.id === sh.attach!.id);
        const at = target ? attachAt(sh, [target], distScale) : undefined;
        return at ? { ...sh, attach: at } : sh; // keep verbatim when underivable
      });
      return { ...s, shapes: settleTransformedUnit(next, memberIds, distScale) };
    }
    case "reattach": {
      // Unit-aware stamping: moved ids are whole units by construction (expand
      // defensively). Kept INTRA-moved edges are preserved verbatim (the parent
      // rode along rigidly — fixes latent bug #3); outward detection runs per
      // member against non-moved candidates, but at most ONE outward edge per
      // UNIT survives (nearest contact), stamped on the touching non-connector
      // member whose slot isn't held by a kept intra-moved edge. Grouped members
      // are never stamped as lone followers — the edge is owned by the unit.
      const moved = new Set(expandIdsToUnits(s.shapes, a.ids));
      const distScale = a.distScale ?? 1;
      const byId = new Map(s.shapes.map((sh) => [sh.id, sh]));
      const movedUnits = new Map<string, string[]>();
      for (const id of moved) {
        const sh = byId.get(id);
        if (!sh) continue;
        const key = rootUnitKeyOf(sh);
        const arr = movedUnits.get(key);
        if (arr) arr.push(id);
        else movedUnits.set(key, [id]);
      }
      const stamp = new Map<string, Attach>();
      const rejudged = new Set<string>(); // outward-eligible members (stale edges drop unless stamped)
      for (const [, memberIds] of movedUnits) {
        let best: { id: string; at: Attach; gap: number } | undefined;
        for (const id of memberIds) {
          const sh = byId.get(id)!;
          if (isConnector(sh)) continue;
          if (sh.attach && moved.has(sh.attach.id)) continue; // slot held by a kept intra-moved edge
          rejudged.add(id);
          // A moved unit shouldn't attach to itself; avoid a 2-cycle back onto sh.
          const at = attachAt(sh, s.shapes.filter((o) => !moved.has(o.id) && o.attach?.id !== sh.id), distScale);
          if (!at) continue;
          const tb = boundingBox(byId.get(at.id)!);
          const sb = boundingBox(sh);
          const gap = Math.hypot(
            Math.max(tb.x - (sb.x + sb.width), sb.x - (tb.x + tb.width), 0),
            Math.max(tb.y - (sb.y + sb.height), sb.y - (tb.y + tb.height), 0)
          );
          if (!best || gap < best.gap) best = { id, at, gap };
        }
        if (best) stamp.set(best.id, best.at);
      }
      let next = mapShapes(s.shapes, rejudged, (sh) => {
        const at = stamp.get(sh.id);
        if (at) return { ...sh, attach: at };
        return sh.attach ? { ...sh, attach: undefined } : sh;
      });
      // Stayers whose parent departed (their edge crossed the boundary the OTHER
      // way — they were too heavy to be dragged): re-evaluate from their unchanged
      // spot; keep a new adjacency if one exists, else drop the now-stale edge.
      // Candidates exclude the stayer's own unit (an internal edge would be inert).
      const staleIds = new Set(next.filter((sh) => !moved.has(sh.id) && sh.attach && moved.has(sh.attach.id)).map((sh) => sh.id));
      next = mapShapes(next, staleIds, (sh) => {
        const at = attachAt(
          sh,
          next.filter((o) => o.id !== sh.id && o.attach?.id !== sh.id && rootUnitKeyOf(o) !== rootUnitKeyOf(sh)),
          distScale
        );
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
      // Grouped images can't be cropped (a crop is a resize in disguise — a
      // disallowed member edit); the view also gates the overlay.
      if (!s.shapes.some((sh) => sh.id === a.id && sh.type === "image" && !sh.groupPath)) return s;
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
      const next = mapShapes(s.shapes, new Set([a.id]), (sh) =>
        sh.type === "text" ? retypeset(sh, { text: a.text, ...(a.width !== undefined && { width: a.width }) }) : sh
      );
      // The new text is a new box, PLACED so its bond-pinned edge stayed put
      // (retypeset): restamp its OWN anchor from where it now sits (keep-or-drop
      // — a text grown past its parent detaches) so the next parent move/resize
      // doesn't yank it to stale metrics, then reflow its FOLLOWERS — shapes
      // glued to its seams ride the edges that moved, arrows re-cling.
      return commit(s, reflowAll(refreshOwnAnchor(next, a.id, a.distScale ?? 1), new Set([a.id])));
    }
    case "deleteSelected": {
      // Keyboard-only path — ignored while a pointer gesture is in flight (a
      // mid-drag delete would interleave a commit inside the open gesture and
      // corrupt the history pair).
      if (s.gestureBase || s.selectedIds.length === 0) return s;
      // Deep-select exception: a selection that is a PROPER SUBSET of one unit is
      // a deliberate member-editing context — Backspace must not nuke the group
      // (ungroup to prune). Everything else expands to whole units (rule 2).
      const sel = new Set(s.selectedIds);
      const selShapes = s.shapes.filter((sh) => sel.has(sh.id));
      const keys = new Set(selShapes.map(rootUnitKeyOf));
      if (keys.size === 1 && selShapes.length < s.shapes.filter((sh) => keys.has(rootUnitKeyOf(sh))).length) return s;
      const gone = new Set(expandIdsToUnits(s.shapes, s.selectedIds));
      return { ...commit(s, reflowAll(s.shapes.filter((sh) => !gone.has(sh.id)), new Set())), selectedIds: [] };
    }
    case "deleteShapes": {
      // Group guard: deleting/erasing any member deletes the whole group (rule 2).
      const gone = new Set(expandIdsToUnits(s.shapes, a.ids));
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

/** A pen tap has no extent — endDraw commits it as this epsilon-length segment
 *  so the round line cap renders a strokeWidth-diameter dot (the same trick as
 *  the dotted dash pattern; see dashFor). */
const PEN_DOT_EPS = 0.001;

function isDegenerate(sh: Shape, minSize = 2): boolean {
  switch (sh.type) {
    case "rect":
    case "ellipse":
    case "diamond":
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

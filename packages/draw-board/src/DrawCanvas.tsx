import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node.js";
import { Stage, Layer, Rect, Ellipse, Line, Arrow, Text, Image as KonvaImage, Group, Transformer } from "react-konva";
import { CropLayer, type CropControl } from "./CropLayer.tsx";
import { wrapLines } from "./textMetrics.ts";
import { BOARD_FONT_STACK } from "./boardFont.ts";
import { SpatialIndex } from "./spatialIndex.ts";
import { UnitIndex } from "./unitIndex.ts";
import { splitGestureLayers } from "./gestureLayers.ts";
import {
  nearestBindableId,
  nearestEdgeBindableId,
  attachAt,
  sideAnchor,
  boundingBox,
  contentBounds,
  moveClusterIds,
  paintOrder,
  contrastSolidOver,
  fillAt,
  isContrastInk,
  isNoStroke,
  shapesInMarquee,
  BIND_DISTANCE,
  EDGE_TOUCH,
  CANVAS_BG_DARK,
  dashFor,
  diamondPoints,
  isEnclosed,
  paintsFill,
  pointInPolygon,
  textBgBox,
  type Attach,
  type DrawAction,
  type DrawState,
  type Shape,
  type BoxShape,
} from "./drawModel.ts";
import {
  padBox,
  panBy,
  unionBox,
  visibleLogicalRect,
  zoomAt,
  type Box,
  type Size,
  type Viewport,
  type ViewportPolicy,
} from "./viewport.ts";

/** Shapes whose scale can be baked into geometry (the Transformer attaches to a
 *  lone one of these). Lines/pen strokes are move-only in v1. */
const RESIZABLE = new Set(["rect", "ellipse", "diamond", "text", "image"]);
/** Node id of the synthetic proxy rect the Transformer scales a whole GROUP
 *  through (members' own nodes never get handles). Reserved — never a shape id. */
const UNIT_PROXY_ID = "__unit_proxy__";
const SELECT_COLOR = "#8b5cf6";
/** The Transformer's full handle set — every shape but text. Text gets ONLY the
 *  horizontal pair: the side handles resize the WRAP BOX (lines reflow live,
 *  glyphs unscaled, the block grows vertically); type size lives in the size
 *  control, so vertical and corner handles have nothing to do. */
const ALL_ANCHORS = ["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"];
const TEXT_ANCHORS = ["middle-left", "middle-right"];
/** Widest glue distance (bind/attach/edge-touch) — the candidate-query pad. */
const GLUE_PAD = 24; // = EDGE_TOUCH, the largest of the three

/** Bond-specific glue-preview chrome: `edge` lights ONLY the pinned edge(s) of
 *  the target's own box (the seam that will hold), `arc` sweeps the ellipse
 *  border around the bond angle, `body` frames the whole target unit (a line/
 *  arrow endpoint binds to the shape as a whole — every edge is "the" edge).
 *  Centered containment gets NO chrome at all: the child is visibly inside its
 *  container, so a glow would announce the obvious. */
type GlueGlow = { kind: "body" } | { kind: "edge"; ax: number; ay: number; box: Box } | { kind: "arc"; angle: number; box: Box };

/** Distance from a point to a line segment (for stroke hit-testing). */
function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Normalized render box for a rect/ellipse/diamond (may be negative mid-draw). */
function viewBox(b: BoxShape) {
  return {
    x: b.width < 0 ? b.x + b.width : b.x,
    y: b.height < 0 ? b.y + b.height : b.y,
    width: Math.abs(b.width),
    height: Math.abs(b.height),
  };
}

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Content strokes never render thinner than this many SCREEN px — a
 *  legibility floor for deep zoom-out (ink must not thin into invisibility).
 *  Exports ignore it: it's a screen aid, not part of the artwork. */
const MIN_STROKE_PX = 1;

/**
 * The Konva stage: fills its container and renders the shapes through the camera
 * (`view` = pan/zoom; screen = logical·scale + offset), turns pointer gestures
 * into {@link DrawAction}s (draw, marquee-select, multi-move, resize) and camera
 * moves (wheel/pinch zoom, pan), and bakes them back into the model. All
 * persistent state is external (the reducer); only the transient marquee
 * rectangle and gesture refs are local.
 *
 * Every content-space threshold (stroke hit tolerance, degenerate-draft size,
 * bind/attach glue distance) is divided by the camera scale so it stays
 * SCREEN-consistent at any zoom. Selection chrome (outlines, marquee, glow) is
 * likewise drawn at constant screen width. Konva's Transformer already works in
 * absolute coordinates (its anchors don't scale with the stage).
 *
 * Content strokes are the opposite — ZOOM-TRUE, and NATIVELY so: width attrs
 * are MODEL units (Konva's default strokeScaleEnabled), so the stage transform
 * scales them with the geometry on every frame of a zoom gesture. The one
 * camera-coupled piece is the {@link MIN_STROKE_PX} legibility floor,
 * re-derived from the SETTLED scale only (`floorVs`); and a Transformer drag
 * pins the dragged outline in screen space for its duration so live node
 * scale never thickens it (see `common`).
 */
export function DrawCanvas({
  state,
  dispatch,
  bgImage,
  bgColor,
  view,
  stageSize,
  policy,
  onViewChange,
  panning,
  stageRef,
  editing,
  editingId,
  croppingId,
  onTextClick,
  onEditText,
  onCropImage,
  onCropApply,
  onCropCancel,
  cropControlRef,
  renderAll,
  camBusyRef,
  newId,
}: {
  state: DrawState;
  dispatch: (a: DrawAction) => void;
  bgImage: HTMLImageElement | null;
  bgColor: string;
  /** The camera. Input inversion is automatic (`getRelativePointerPosition`). */
  view: Viewport;
  /** Container size in CSS px — the stage always fills it. */
  stageSize: Size;
  /** Camera policy: gates gestures ("fixed" allows none) and where drawing may
   *  start ("infinite" is unbounded; the others gate to the doc box). */
  policy: ViewportPolicy;
  /** Request a camera change. FUNCTIONAL (updater over the latest view) so rapid
   *  wheel/pinch events never compound off a stale prop. The host clamps per its
   *  policy. */
  onViewChange: (up: (v: Viewport) => Viewport) => void;
  /** Space is held — a primary-button drag pans instead of drawing/selecting. */
  panning: boolean;
  stageRef: React.RefObject<Konva.Stage | null>;
  /** A text edit is in progress — canvas pointer input is suppressed so a
   *  click elsewhere just blurs the textarea (committing it) instead of starting
   *  a new action or discarding the text. */
  editing: boolean;
  /** A text shape currently being edited (hidden under the textarea), or null. */
  editingId: string | null;
  /** Place + edit a new standalone text at these logical coords (text tool). */
  onTextClick: (x: number, y: number) => void;
  /** Reopen an existing text shape for editing. */
  onEditText: (id: string) => void;
  /** An image currently in crop mode (rendered by the crop overlay), or null. */
  croppingId: string | null;
  /** Enter crop mode on an image (double-click). */
  onCropImage: (id: string) => void;
  /** Apply a crop (new box + optional source crop region). */
  onCropApply: (id: string, box: { x: number; y: number; width: number; height: number }, crop?: { x: number; y: number; width: number; height: number }) => void;
  /** Leave crop mode without changes. */
  onCropCancel: () => void;
  /** Populated with the live crop apply/cancel while crop mode is open — the
   *  editor's keyboard handler drives it (see {@link CropControl}). */
  cropControlRef?: React.MutableRefObject<CropControl | null>;
  /** Render EVERY shape regardless of the viewport (export needs the whole
   *  plane in the layer; normal frames cull to the visible window). */
  renderAll?: boolean;
  /** Kept in sync with the camera-gesture bitmap-cache state so the editor's ⌘G
   *  handler can no-op while it's live (the N-identity group restamp would force
   *  a full recache hitch mid-pan). */
  camBusyRef?: React.MutableRefObject<boolean>;
  newId: () => string;
}) {
  const trRef = useRef<Konva.Transformer>(null);
  const { tool, shapes, selectedIds, color, fill, strokeWidth, strokeStyle } = state;
  const selected = new Set(selectedIds);
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const moveRef = useRef<{ last: { x: number; y: number }; downAt: { x: number; y: number }; ids: string[] } | null>(null);
  const erasing = useRef(false);
  // Double-click detection is OURS, not Konva's. Konva synthesizes dblclick
  // from ANY two down/up pairs inside its 400ms window — movement-blind
  // ([click; quick drag] "double-clicks" where the drag ended) AND
  // position-blind ([deselect-click; quick click on a shape] "double-clicks"
  // the shape). Worse than the false positives: suppressing a far-apart
  // synthetic pair still lets Konva CONSUME the first down of a genuine
  // double-click into it, so the genuine pair never emits an event at all —
  // click away, then double-click a text, and the first double-click is
  // swallowed. So the stage's down/up handlers feed our own detector: a
  // double-click is two still clicks in ONE place within DBL_MS, judged on
  // the pair that actually happened.
  //
  // Drags (move/marquee/transform/crop) arm this deadline; an up inside it is
  // not a "click" and breaks any pending pair.
  const suppressDblUntil = useRef(0);
  const suppressDbl = () => {
    suppressDblUntil.current = performance.now() + 500;
  };
  const DBL_MS = 500; // down-to-down; ~OS default double-click speed
  type PairDown = { x: number; y: number; lx: number; ly: number; t: number; touch: boolean; onXfmr: boolean };
  const pairRef = useRef<{ down: PairDown | null; lastClick: { x: number; y: number; t: number } | null }>({
    down: null,
    lastClick: null,
  });
  const recordPairDown = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    if ("button" in e.evt && e.evt.button !== 0) return; // primary clicks only
    const screen = e.target.getStage()?.getPointerPosition();
    if (!screen) return;
    // Everything the double-click action will need is captured HERE, at down
    // time — the up's pointer state is not trusted (it can be stale or belong
    // to another gesture by then; the click happened where the down landed).
    const { x: lx, y: ly } = logicalPointer(e);
    const parent = e.target.getParent() as Konva.Node | null;
    pairRef.current.down = {
      x: screen.x,
      y: screen.y,
      lx,
      ly,
      t: performance.now(),
      touch: !("button" in e.evt),
      // Same law as onStageDown: input originating on a Transformer handle
      // belongs to the Transformer.
      onXfmr: parent?.getClassName?.() === "Transformer",
    };
  };
  /** A camera gesture (pan/pinch) is not a click and voids any pending pair. */
  const breakClickPair = () => {
    pairRef.current.down = null;
    pairRef.current.lastClick = null;
  };
  /** Judge the finished click against the previous one; fire on a genuine pair. */
  const settleClickPair = () => {
    const pair = pairRef.current;
    const down = pair.down;
    pair.down = null;
    if (!down) return; // no primary down recorded (non-primary button, pan, …)
    if (performance.now() < suppressDblUntil.current) {
      pair.lastClick = null; // that gesture was a drag — it breaks any pair
      return;
    }
    const prev = pair.lastClick;
    const slop = down.touch ? 24 : 8; // finger jitter > mouse jitter
    if (prev && down.t - prev.t <= DBL_MS && Math.hypot(down.x - prev.x, down.y - prev.y) <= slop) {
      pair.lastClick = null; // a triple-click starts a fresh pair
      openDblTarget(down);
    } else {
      pair.lastClick = { x: down.x, y: down.y, t: down.t };
    }
  };

  // Spatial index over shape bboxes — every "what's here" query (culling, hit
  // tests, glue candidates) goes through it instead of scanning all N shapes.
  // Identity-diffed per render: O(changed) real work per edit frame.
  const indexRef = useRef<SpatialIndex | null>(null);
  if (!indexRef.current) indexRef.current = new SpatialIndex();
  indexRef.current.update(state.shapes);
  const index = indexRef.current;

  // Root-unit index (group membership + union bounds) — identity-diffed like the
  // spatial index, consumed by outlines/proxy/glue-highlight render paths.
  const unitsRef = useRef<UnitIndex | null>(null);
  if (!unitsRef.current) unitsRef.current = new UnitIndex();
  unitsRef.current.update(state.shapes);
  const units = unitsRef.current;

  // The camera scale, and the screen→logical factor for every UX threshold.
  const vs = view.scale;
  const sPx = (px: number) => px / vs;
  // Handlers embedded in MEMOIZED shape elements read the live scale here — the
  // elements outlive zooms, so a captured `vs` would go stale.
  const vsRef = useRef(vs);
  vsRef.current = vs;

  // ── Camera gestures (pan drag / wheel / pinch) ──────────────────────────────
  // Pan drag: INCREMENTAL screen deltas fed through the functional updater — no
  // anchor captured from the (possibly stale) `view` prop, so a pan starting
  // amid trackpad-inertia wheel updates never snaps the camera back a frame.
  // Active on middle-button, or any button while space is held.
  const panRef = useRef<{ lx: number; ly: number } | null>(null);
  const [panActive, setPanActive] = useState(false);
  // Pinch: previous frame's touch distance + center.
  const pinchRef = useRef<{ d: number; c: { x: number; y: number } } | null>(null);

  // ── Gesture bitmap cache ─────────────────────────────────────────────────────
  // While ONLY the camera moves (wheel / pan-drag / pinch), content pixels don't
  // change — so the layer is cached to one bitmap that the stage transform slides
  // around, making camera frames O(1) in shape count (Konva's own layer.cache).
  // Pan/pinch have explicit start/end; wheel is debounced (a quiet 180ms ends the
  // gesture). The cache clears on settle for a crisp redraw, and zooming while
  // cached shows the bitmap scaled until then (a 180ms softness, deliberate).
  const layerRef = useRef<Konva.Layer>(null);
  const [camGesture, setCamGesture] = useState(false);
  if (camBusyRef) camBusyRef.current = camGesture; // mirror for the editor's ⌘G gate
  const wheelIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markWheelGesture = () => {
    setCamGesture(true);
    if (wheelIdleTimer.current) clearTimeout(wheelIdleTimer.current);
    wheelIdleTimer.current = setTimeout(() => {
      if (!panRef.current && !pinchRef.current) setCamGesture(false);
    }, 180);
  };
  useEffect(() => () => {
    if (wheelIdleTimer.current) clearTimeout(wheelIdleTimer.current);
  }, []);

  // ── Zoom-true strokes, natively ─────────────────────────────────────────────
  // Content stroke width attrs are MODEL units (Konva's default
  // strokeScaleEnabled): the stage transform scales them like any geometry, so
  // they track zoom gestures frame-by-frame with zero element rebuilds. The
  // only camera-coupled piece is the MIN_STROKE_PX legibility floor — a floored
  // width is MIN/scale model units, re-derived from the SETTLED scale only (a
  // floored stroke rides the native transform mid-gesture and crisps to exactly
  // the floor on settle). Above the floor `floorVs` pins to Infinity: widths
  // are then plain model values and ordinary zooms rebuild nothing at all.
  const contentGesture = state.gestureBase !== null || state.draftId !== null;
  const strokeVsRef = useRef(vs);
  if (!camGesture && !contentGesture) strokeVsRef.current = vs;
  const minModelStroke = useMemo(() => {
    let m = Infinity;
    for (const sh of shapes) if (sh.type !== "text" && sh.type !== "image" && sh.strokeWidth < m) m = sh.strokeWidth;
    return m;
  }, [shapes]);
  const floorVs = minModelStroke * strokeVsRef.current < MIN_STROKE_PX ? strokeVsRef.current : Infinity;
  /** A shape's rendered stroke width in MODEL units — the floor applied. */
  const modelSw = (sh: { strokeWidth: number }) => Math.max(sh.strokeWidth, MIN_STROKE_PX / floorVs);

  const containerPoint = (e: KonvaEventObject<unknown>, clientX: number, clientY: number) => {
    const rect = e.target.getStage()?.container().getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: 0, y: 0 };
  };

  const startPan = (e: KonvaEventObject<MouseEvent>) => {
    settleGesture(); // a live draft/move/marquee must not keep running under the pan
    breakClickPair();
    panRef.current = { lx: e.evt.clientX, ly: e.evt.clientY };
    setPanActive(true);
    setCamGesture(true);
  };
  const endPan = () => {
    panRef.current = null;
    setPanActive(false);
    setCamGesture(false);
  };

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    if (policy === "fixed") return;
    e.evt.preventDefault();
    // Bitmap-cache the layer for the scroll — but never while a CONTENT gesture
    // is live (a mid-stroke wheel would freeze the stroke's growth on screen).
    if (!state.draftId && !moveRef.current && !erasing.current && !marqueeStart.current) markWheelGesture();
    const pt = containerPoint(e, e.evt.clientX, e.evt.clientY);
    if (e.evt.ctrlKey || e.evt.metaKey) {
      // Trackpad pinches arrive as ctrl+wheel with small deltas; mouse notches are
      // ~100 — clamp so one notch is a pleasant step (~1.48×), not a huge jump.
      const factor = Math.exp(-clampN(e.evt.deltaY, -50, 50) * 0.0078);
      onViewChange((v) => zoomAt(v, pt, factor));
    } else {
      const dx = e.evt.shiftKey && !e.evt.deltaX ? e.evt.deltaY : e.evt.deltaX;
      const dy = e.evt.shiftKey && !e.evt.deltaX ? 0 : e.evt.deltaY;
      onViewChange((v) => panBy(v, -dx, -dy));
    }
  };

  /** Enter pinch mode: the in-flight draw/move/marquee gesture is aborted — a
   *  second finger means the user wants the camera, not more ink. */
  const beginPinch = (t1: Touch, t2: Touch, e: KonvaEventObject<TouchEvent>) => {
    breakClickPair();
    if (state.draftId) dispatch({ type: "cancelDraw" });
    if (moveRef.current) {
      dispatch({ type: "endGesture" });
      moveRef.current = null;
    }
    marqueeStart.current = null;
    setMarquee(null);
    if (erasing.current) {
      erasing.current = false;
      dispatch({ type: "endGesture" }); // the erase swipe rode a gesture — close it
    }
    const c = containerPoint(e, (t1.clientX + t2.clientX) / 2, (t1.clientY + t2.clientY) / 2);
    pinchRef.current = { d: Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY), c };
    setCamGesture(true);
  };

  const movePinch = (t1: Touch, t2: Touch, e: KonvaEventObject<TouchEvent>) => {
    const prev = pinchRef.current;
    if (!prev) return;
    e.evt.preventDefault();
    const d = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    const c = containerPoint(e, (t1.clientX + t2.clientX) / 2, (t1.clientY + t2.clientY) / 2);
    const factor = prev.d > 0 ? d / prev.d : 1;
    onViewChange((v) => panBy(zoomAt(v, c, factor), c.x - prev.c.x, c.y - prev.c.y));
    pinchRef.current = { d, c };
  };

  // Decoded element cache for placed image shapes (keyed by shape id).
  const [imgEls, setImgEls] = useState<Record<string, HTMLImageElement>>({});
  useEffect(() => {
    let live = true;
    for (const sh of shapes) {
      if (sh.type !== "image" || imgEls[sh.id]) continue;
      const el = new Image();
      el.onload = () => live && setImgEls((m) => ({ ...m, [sh.id]: el }));
      el.src = `data:${sh.mediaType};base64,${sh.dataBase64}`;
    }
    return () => {
      live = false;
    };
  }, [shapes, imgEls]);

  // Downscaled luminance map of the RASTER backdrop the ink contrasts against —
  // the annotated background image plus any dropped image shapes; never the
  // strokes. FILLS are not baked in: they resolve exactly in vector space
  // (fillAt) inside inkFor — which is what lets a shape's OWN backfill be
  // excluded from its ink; a shared raster can't un-bake one shape's fill.
  // Sampled over the union RECT of the images (an infinite board has no canvas
  // box to cover; everything outside the rect is the dark board). Rebuilt only
  // when the images change, not on every pen point.
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const bgLumRef = useRef<{ data: Uint8ClampedArray; w: number; h: number; rect: Box } | null>(null);
  const [lumEpoch, setLumEpoch] = useState(0);
  const imgSig = shapes
    .filter((s) => s.type === "image")
    .map((s) => `${s.id}:${Math.round((s as { x: number }).x)}:${Math.round((s as { y: number }).y)}:${(s as { width: number }).width | 0}:${(s as { height: number }).height | 0}`)
    .join("|");
  // Fills are backdrop too (resolved in vector space by inkFor, never baked
  // into the raster) — this sig sits in the effect deps only to bump lumEpoch
  // so cached inks resample on a fill change/move. Open pen doodles are
  // excluded (paintsFill), so live pen drawing never resamples per point; the
  // sig flips only when the loop closes.
  const fillSig = shapes
    .filter(paintsFill)
    .map((s) => {
      const b = boundingBox(s);
      return `${s.id}:${(s as { fill?: string }).fill}:${Math.round(b.x)}:${Math.round(b.y)}:${b.width | 0}:${b.height | 0}`;
    })
    .join("|");
  useEffect(() => {
    let rect: Box | null = bgImage ? { x: 0, y: 0, width: state.width, height: state.height } : null;
    for (const sh of shapesRef.current) {
      if (sh.type !== "image") continue;
      const b = boundingBox(sh);
      if (b.width <= 0 || b.height <= 0) continue;
      rect = rect ? unionBox(rect, b) : b;
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      bgLumRef.current = null;
      setLumEpoch((e) => e + 1);
      return;
    }
    const w = Math.min(240, Math.max(1, Math.round(rect.width)));
    const h = clampN(Math.round((w / rect.width) * rect.height), 1, 480);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) {
      bgLumRef.current = null;
      return;
    }
    // Base: the dark board; then the annotated background image at the doc box;
    // then every placed image shape at its rect — mapped into the union rect.
    // Strokes are never painted here, and fills live in vector space (inkFor).
    const mx = (x: number) => ((x - rect.x) / rect.width) * w;
    const my = (y: number) => ((y - rect.y) / rect.height) * h;
    ctx.fillStyle = CANVAS_BG_DARK;
    ctx.fillRect(0, 0, w, h);
    if (bgImage) ctx.drawImage(bgImage, mx(0), my(0), (state.width / rect.width) * w, (state.height / rect.height) * h);
    // paintOrder, not model order — the board stacks images by size (larger
    // below), and the sampled backdrop must match what's actually visible.
    for (const sh of paintOrder(shapesRef.current)) {
      if (sh.type !== "image") continue;
      const el = imgEls[sh.id];
      if (!el) continue;
      ctx.drawImage(el, mx(sh.x), my(sh.y), (sh.width / rect.width) * w, (sh.height / rect.height) * h);
    }
    try {
      bgLumRef.current = { data: ctx.getImageData(0, 0, w, h).data, w, h, rect };
    } catch {
      bgLumRef.current = null;
    }
    setLumEpoch((e) => e + 1); // adaptive ink resamples → cached elements stale
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgImage, imgEls, imgSig, fillSig, state.width, state.height]);

  // fillAt reads "below" in PAINT order (filled units z-sort by footprint) —
  // feed it the sorted view, not the insertion array.
  const inkOrder = useMemo(() => paintOrder(shapes), [shapes]);

  /** Solid render color for a shape: its own color, or — for the adaptive ink —
   *  white/near-black chosen to contrast the background sampled under it. Outside
   *  the sampled raster rect there's only the dark board → bright ink. No-stroke
   *  paints transparent — Konva still strokes the HIT canvas (its colorKey, not
   *  this color), so the geometry stays clickable. */
  const inkFor = (sh: Shape): string => {
    if (isNoStroke(sh.stroke)) return "transparent";
    if (!isContrastInk(sh.stroke)) return sh.stroke;
    const b = boundingBox(sh);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    // Fills first, exactly, in vector space — only fills BELOW the shape
    // count: its own backfill and fills covering it from above are foreground,
    // not the ground the stroke is read against. Text keeps its own fill —
    // the chip sits BEHIND the glyphs.
    const under = sh.type === "text" && sh.fill ? sh.fill : fillAt(inkOrder, cx, cy, sh.id);
    if (under) return contrastSolidOver(under);
    // No fill beneath → the image raster decides; beyond it, the dark board.
    const s = bgLumRef.current;
    if (!s) return "#f5f5f5"; // dark blank canvas → bright ink
    if (cx < s.rect.x || cx > s.rect.x + s.rect.width || cy < s.rect.y || cy > s.rect.y + s.rect.height) return "#f5f5f5";
    const px = clampN(Math.round(((cx - s.rect.x) / s.rect.width) * s.w), 0, s.w - 1);
    const py = clampN(Math.round(((cy - s.rect.y) / s.rect.height) * s.h), 0, s.h - 1);
    const i = (py * s.w + px) * 4;
    const lum = (0.2126 * s.data[i] + 0.7152 * s.data[i + 1] + 0.0722 * s.data[i + 2]) / 255;
    return lum > 0.55 ? "#111111" : "#f5f5f5";
  };

  // A lone UNGROUPED resizable shape — a deep-selected member never gets
  // handles (members can't be individually resized; the group scales whole).
  const soleSel = selectedIds.length === 1 ? shapes.find((s) => s.id === selectedIds[0]) : undefined;
  const soleResizable = !!soleSel && RESIZABLE.has(soleSel.type) && !soleSel.groupPath;

  // The selection is EXACTLY one multi-member group unit → the Transformer
  // attaches to a synthetic proxy rect over the unit bounds (keepRatio forced,
  // corner anchors only — uniform scale is the only group resize).
  const soleUnitKey = (() => {
    if (selectedIds.length < 2) return null;
    const key = units.rootOf(selectedIds[0]);
    if (!key) return null;
    for (const id of selectedIds) if (units.rootOf(id) !== key) return null;
    return units.membersOf(key).size === selectedIds.length ? key : null;
  })();
  // While a unit-scale gesture is live, the proxy renders at its GESTURE-START
  // bounds — the Transformer owns the node; live member restamps must not fight
  // it (same law as reflowChildrenTo for a plain resize).
  const unitScaleRef = useRef<{ ids: string[]; origin: { x: number; y: number }; base: Box; side: boolean } | null>(null);
  const proxyBounds = soleUnitKey ? (unitScaleRef.current?.base ?? units.boundsOf(soleUnitKey)) : null;

  // Bind the Transformer to a lone resizable selection or a whole group's proxy
  // (else it stays detached; other selections show dashed outlines instead).
  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    if (tool === "select" && soleResizable && selectedIds[0] !== editingId && !croppingId) {
      // (Anchor SET is the render prop's job — enabledAnchors set here would be
      // silently reverted by react-konva on the next unrelated re-render.)
      const node = stage.findOne<Konva.Node>(`#${selectedIds[0]}`);
      tr.nodes(node ? [node] : []);
    } else if (tool === "select" && soleUnitKey && !editing && !croppingId) {
      const node = stage.findOne<Konva.Node>(`#${UNIT_PROXY_ID}`);
      tr.nodes(node ? [node] : []);
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [selectedIds, tool, soleResizable, soleUnitKey, editing, editingId, croppingId, shapes, stageRef]);

  const logicalPointer = (e: KonvaEventObject<unknown>) => {
    const p = e.target.getStage()?.getRelativePointerPosition();
    return p ?? { x: 0, y: 0 };
  };

  /** Whether a logical point lies inside the doc box — drawing may only START
   *  there under the bounded/fixed policies (content outside the box would be
   *  cropped away at export). The infinite board has no box. */
  const insideDoc = (p: { x: number; y: number }) =>
    policy === "infinite" || (p.x >= 0 && p.y >= 0 && p.x <= state.width && p.y <= state.height);

  // Pick the shape under a point. Two tiers, so a click is precise:
  //  • line/pen/arrow — a "scribble" is only hit when clicked ON the stroke
  //    (within tolerance), NOT anywhere in its bounding box. These get PRIORITY
  //    (a stroke you click directly wins over an area shape it sits inside).
  //  • rect/ellipse/text/image — area shapes: their INTERIOR (bbox) is the hit.
  // Within a tier the smallest-area shape wins (nested shapes stay reachable).
  const area = (sh: Shape) => {
    const b = boundingBox(sh);
    return b.width * b.height;
  };
  const inBox = (sh: Shape, pt: { x: number; y: number }) => {
    const b = boundingBox(sh);
    return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
  };
  const onStroke = (sh: Shape, pt: { x: number; y: number }) => {
    // ≥6 SCREEN px of slack at any zoom (a hairline stroke at 0.1× is still clickable).
    const tol = Math.max(sPx(6), sh.strokeWidth) + sh.strokeWidth / 2;
    if (sh.type === "line" || sh.type === "arrow") {
      return distToSegment(pt.x, pt.y, sh.points[0], sh.points[1], sh.points[2], sh.points[3]) <= tol;
    }
    if (sh.type === "pen") {
      const p = sh.points;
      for (let i = 0; i + 3 < p.length; i += 2) {
        if (distToSegment(pt.x, pt.y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= tol) return true;
      }
    }
    return false;
  };
  const smallestAt = (pt: { x: number; y: number }): Shape | null => {
    let bestStroke: Shape | null = null;
    let bestArea: Shape | null = null;
    // Local candidates only: pad covers the widest stroke tolerance.
    const pad = Math.max(sPx(6), 10) + 6;
    for (const sh of index.queryPoint(pt, pad)) {
      if (sh.type === "line" || sh.type === "arrow" || sh.type === "pen") {
        if (onStroke(sh, pt) && (!bestStroke || area(sh) < area(bestStroke))) bestStroke = sh;
        // A FILLED enclosed doodle is an area shape too: its painted interior
        // is clickable like a rect's, not just its outline.
        else if (sh.type === "pen" && paintsFill(sh) && pointInPolygon(pt.x, pt.y, sh.points) && (!bestArea || area(sh) < area(bestArea))) bestArea = sh;
      } else if (inBox(sh, pt) && (!bestArea || area(sh) < area(bestArea))) {
        bestArea = sh;
      }
    }
    return bestStroke ?? bestArea;
  };

  /** Gap-click fallback for the SELECT tool: a group presents as its whole
   *  AABB, so a click that hits no shape but lands inside a group's box still
   *  grabs the group. Returns the member NEAREST the point — every downstream
   *  path (select-normalize, toggleSelect, moveClusterIds) is unit-grained from
   *  any member, so the representative only has to belong to the unit. Direct
   *  shape hits always win over this (callers try {@link smallestAt} first),
   *  and the eraser/dblclick paths stay item-grained on purpose. */
  const nearestGroupMemberAt = (pt: { x: number; y: number }): Shape | null => {
    const key = units.smallestGroupAt(pt);
    if (!key) return null;
    let best: Shape | null = null;
    let bestD = Infinity;
    for (const sh of shapes) {
      if (units.rootOf(sh.id) !== key) continue;
      const b = boundingBox(sh);
      const dx = Math.max(b.x - pt.x, 0, pt.x - (b.x + b.width));
      const dy = Math.max(b.y - pt.y, 0, pt.y - (b.y + b.height));
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = sh;
      }
    }
    return best;
  };

  // ── Stage-level pointer (pan / draw / select+move / marquee / erase) ────────
  /** Settle whatever content gesture is live — the ONE teardown path, used by
   *  mouseup, by an outside-release detected on re-entry (buttons gone), and by
   *  a pan/pinch takeover. Safe to call with nothing active. */
  const settleGesture = () => {
    if (erasing.current) {
      erasing.current = false;
      dispatch({ type: "endGesture" }); // the swipe rode a gesture → one history entry
      return;
    }
    if (moveRef.current) {
      const m = moveRef.current;
      if (m.last.x !== m.downAt.x || m.last.y !== m.downAt.y) {
        suppressDbl(); // a real drag, not a click
        // Re-detect attachments for what was dragged (attach if dropped
        // edge-to-edge with a shape, detach if dragged away). The glue distance
        // is zoom-scaled: "touching" is judged on SCREEN. ONLY on a real drag —
        // a zero-distance click must not re-judge glue: nothing moved, and the
        // stayer-rejudge would DROP a distant follower's bond on a mere click.
        dispatch({ type: "reattach", ids: m.ids, distScale: sPx(1) });
      }
      dispatch({ type: "endGesture" });
      moveRef.current = null;
      return;
    }
    if (marqueeStart.current && marquee) {
      const box = { ...marquee };
      marqueeStart.current = null;
      setMarquee(null);
      if (Math.abs(box.width) >= sPx(3) || Math.abs(box.height) >= sPx(3)) {
        suppressDbl();
        const m = {
          x: box.width < 0 ? box.x + box.width : box.x,
          y: box.height < 0 ? box.y + box.height : box.y,
          width: Math.abs(box.width),
          height: Math.abs(box.height),
        };
        dispatch({ type: "select", ids: shapesInMarquee(index.query(m), box) });
      }
      return;
    }
    marqueeStart.current = null;
    // Degenerate threshold: 2 SCREEN px (a click-no-drag at any zoom); glue
    // distances likewise screen-scaled.
    if (state.draftId) dispatch({ type: "endDraw", minSize: sPx(2), distScale: sPx(1) });
  };

  const onStageDown = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    // Before any early-return: even a click that only blurs an editor or lands
    // during crop is half of a potential click pair.
    recordPairDown(e);
    if (croppingId) return; // the crop overlay owns all input while active
    if (editing) return; // let the click blur+commit the open text, nothing else
    if (pinchRef.current) return; // two fingers own the camera
    if ("button" in e.evt && e.evt.button !== 0) {
      // Non-primary buttons never start content gestures: middle pans (gesture
      // policies only), right/back/forward are ignored (the context menu is
      // suppressed at the Stage so a right-click can't strand a draft).
      if (e.evt.button === 1 && policy !== "fixed") {
        e.evt.preventDefault();
        startPan(e as KonvaEventObject<MouseEvent>);
      }
      return;
    }
    // Space-held: the primary button pans instead of drawing/selecting.
    if (policy !== "fixed" && panning && "button" in e.evt) {
      e.evt.preventDefault();
      startPan(e as KonvaEventObject<MouseEvent>);
      return;
    }
    if (tool === "eraser") {
      erasing.current = true;
      // The whole swipe rides ONE gesture → one undo entry however many shapes die.
      dispatch({ type: "beginGesture" });
      const hit = smallestAt(logicalPointer(e));
      if (hit) dispatch({ type: "deleteShapes", ids: [hit.id] });
      return;
    }
    if (tool === "select") {
      // A press on a Transformer handle resizes — leave it to the Transformer.
      const parent = e.target.getParent() as Konva.Node | null;
      if (parent && parent.getClassName?.() === "Transformer") return;
      const p = logicalPointer(e);
      const direct = smallestAt(p);
      // Direct shape hits win; a miss inside a group's AABB still grabs the
      // group (gap-click — the group acts as its whole box, not a bag of items).
      const hit = direct ?? nearestGroupMemberAt(p);
      if (!hit) {
        marqueeStart.current = p;
        setMarquee({ x: p.x, y: p.y, width: 0, height: 0 });
        dispatch({ type: "select", ids: [] });
        return;
      }
      const shiftKey = "shiftKey" in e.evt && e.evt.shiftKey;
      if (shiftKey) {
        dispatch({ type: "toggleSelect", id: hit.id }); // unit-grained in the reducer
        return;
      }
      // ⌘/Ctrl-click a grouped member → DEEP-SELECT it (restricted edits only;
      // no move gesture — members never move individually). On a loose shape the
      // modifier means nothing — fall through to a plain select. DIRECT hits
      // only: a gap-click has no member under the cursor to deep-select.
      const metaKey = "metaKey" in e.evt && (e.evt.metaKey || e.evt.ctrlKey);
      if (metaKey && direct && units.isGroupedMember(direct.id)) {
        dispatch({ type: "select", ids: [direct.id], deep: true });
        return;
      }
      // Clicking inside an existing multi-selection keeps it (drag the group);
      // otherwise select just the hit shape (the reducer expands it to its full
      // unit — so does moveClusterIds for the drag). A click on a deep-selected
      // member re-selects non-deep: dragging is a unit-context action.
      const ids = selected.has(hit.id) && selectedIds.length > 1 ? selectedIds : [hit.id];
      if (!selected.has(hit.id)) dispatch({ type: "select", ids: [hit.id] });
      else if (selectedIds.length === 1 && units.isGroupedMember(hit.id)) dispatch({ type: "select", ids: [hit.id] });
      dispatch({ type: "beginGesture" });
      // Followers ride by INCLUSION: the size-gated attach cluster ("largest drags
      // smallest") plus every dragged container's contents (moveClusterIds folds in
      // containment). The reducer freezes anything left out of this set.
      moveRef.current = { last: p, downAt: p, ids: moveClusterIds(shapes, ids) };
      return;
    }
    const { x, y } = logicalPointer(e);
    if (!insideDoc({ x, y })) return; // bounded/fixed: ink starts inside the box
    if (tool === "text") {
      onTextClick(x, y);
      return;
    }
    const id = newId();
    // Solid is the absent default — only a non-solid style is stamped. Same for
    // fill: the ambient fill stamps onto fillable draws (pen fills render only
    // once the doodle closes into a loop).
    const style = strokeStyle !== "solid" ? { strokeStyle } : null;
    const inkFill = fill ? { fill } : null;
    if (tool === "pen") {
      dispatch({ type: "beginDraw", shape: { id, type: "pen", stroke: color, strokeWidth, ...style, ...inkFill, points: [x, y] } });
    } else if (tool === "rect" || tool === "ellipse" || tool === "diamond") {
      dispatch({ type: "beginDraw", shape: { id, type: tool, stroke: color, strokeWidth, ...style, ...inkFill, x, y, width: 0, height: 0 } });
    } else if (tool === "line" || tool === "arrow" || tool === "darrow") {
      // A double-arrow is a normal arrow shape flagged `doubleHead` (identical
      // geometry, a head at both ends in the view).
      const type = tool === "line" ? "line" : "arrow";
      dispatch({
        type: "beginDraw",
        shape: { id, type, stroke: color, strokeWidth, ...style, points: [x, y, x, y], ...(tool === "darrow" && { doubleHead: true }) },
      });
    }
  };

  const onStageMove = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (croppingId) return;
    // A mouseup outside the stage never reaches us: for MOUSE events, moving
    // with no buttons down means whatever gesture was live already ended —
    // settle it instead of letting it run under bare hover (an armed eraser
    // would otherwise delete everything it touches).
    if ("buttons" in e.evt && e.evt.buttons === 0) {
      if (panRef.current) {
        endPan();
        return;
      }
      if (erasing.current || moveRef.current || marqueeStart.current || state.draftId) {
        settleGesture();
        return;
      }
    }
    if (panRef.current && "clientX" in e.evt) {
      const p = panRef.current;
      const dx = e.evt.clientX - p.lx;
      const dy = e.evt.clientY - p.ly;
      p.lx = e.evt.clientX;
      p.ly = e.evt.clientY;
      if (dx || dy) onViewChange((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      return;
    }
    if (pinchRef.current) return; // handled by onTouchMove's pinch branch
    if (erasing.current) {
      const hit = smallestAt(logicalPointer(e));
      if (hit) dispatch({ type: "deleteShapes", ids: [hit.id] });
      return;
    }
    if (moveRef.current) {
      const p = logicalPointer(e);
      const dx = p.x - moveRef.current.last.x;
      const dy = p.y - moveRef.current.last.y;
      if (dx || dy) {
        dispatch({ type: "translateShapes", ids: moveRef.current.ids, dx, dy });
        moveRef.current.last = p;
      }
      return;
    }
    if (marqueeStart.current) {
      const p = logicalPointer(e);
      const s = marqueeStart.current;
      setMarquee({ x: s.x, y: s.y, width: p.x - s.x, height: p.y - s.y });
      return;
    }
    // Hover feedback while holding a bindable tool (before drawing): track the
    // pointer so we can highlight the shape a drawn endpoint/box would attach to.
    if (!state.draftId) {
      if (tool === "line" || tool === "arrow" || tool === "darrow" || tool === "rect" || tool === "ellipse" || tool === "diamond") setHover(logicalPointer(e));
      return;
    }
    // Extend by the DRAFT's type, not the current tool — a hotkey mid-stroke
    // must not reroute (or freeze) the in-flight geometry.
    const draftShape = shapes.find((s) => s.id === state.draftId);
    const { x, y } = logicalPointer(e);
    if (draftShape?.type === "pen") dispatch({ type: "extendFreehand", point: { x, y } });
    else dispatch({ type: "updateDraw", point: { x, y } });
  };

  const onStageUp = () => {
    if (panRef.current) {
      endPan(); // startPan already broke the click pair
      return;
    }
    settleGesture(); // may arm suppressDbl (drag) — must precede the pair judgement
    settleClickPair();
  };

  // ── Touch routing: a second finger switches the gesture to the camera ───────
  const onTouchStart = (e: KonvaEventObject<TouchEvent>) => {
    if (policy !== "fixed" && e.evt.touches.length >= 2) {
      e.evt.preventDefault();
      beginPinch(e.evt.touches[0], e.evt.touches[1], e);
      return;
    }
    onStageDown(e);
  };
  const onTouchMove = (e: KonvaEventObject<TouchEvent>) => {
    if (pinchRef.current) {
      if (e.evt.touches.length >= 2) movePinch(e.evt.touches[0], e.evt.touches[1], e);
      return;
    }
    if (policy !== "fixed" && e.evt.touches.length >= 2) {
      e.evt.preventDefault();
      beginPinch(e.evt.touches[0], e.evt.touches[1], e);
      return;
    }
    onStageMove(e);
  };
  const onTouchEnd = (e: KonvaEventObject<TouchEvent>) => {
    if (pinchRef.current) {
      // Pinch over once fewer than two fingers remain; the leftover finger is
      // inert until lifted (no accidental stroke from a settling hand).
      if (e.evt.touches.length < 2) {
        pinchRef.current = null;
        setCamGesture(false);
      }
      return;
    }
    onStageUp();
  };

  /** The double-click ACTION — invoked only by settleClickPair, which already
   *  vouched the pair is genuine (two still clicks in one place). Operates on
   *  the recorded DOWN (position + origin), never the up-time pointer. */
  const openDblTarget = (down: { lx: number; ly: number; onXfmr: boolean }) => {
    if (croppingId || tool !== "select") return;
    if (down.onXfmr) return;
    const p = { x: down.lx, y: down.ly };
    const hit = smallestAt(p);
    if (!hit) return;
    // Double-click: text → edit text; image → crop (a GROUPED image never opens
    // the crop overlay — crop is a resize in disguise, disallowed on members).
    // A container (rect/ellipse) engages its CAPTION: the nearest text bonded
    // to it (or a bond-less text sitting inside it), else a fresh text spawned
    // at the click point. Captions are always FREE text shapes glued by
    // containment/edge bonds — never text baked into the shape — so they
    // relocate, restyle, and rebind like anything else.
    if (hit.type === "text") onEditText(hit.id);
    else if (hit.type === "image" && !hit.groupPath) onCropImage(hit.id);
    else if (hit.type === "rect" || hit.type === "ellipse" || hit.type === "diamond") {
      const b = boundingBox(hit);
      const inside = (tb: Box) => tb.x >= b.x && tb.y >= b.y && tb.x + tb.width <= b.x + b.width && tb.y + tb.height <= b.y + b.height;
      const captions = shapes.filter((s) => s.type === "text" && (s.attach ? s.attach.id === hit.id : inside(boundingBox(s))));
      if (captions.length) {
        // Nearest caption to the click — a box with several texts engages the
        // one the user aimed at.
        const d2 = (s: Shape) => {
          const sb = boundingBox(s);
          return (sb.x + sb.width / 2 - p.x) ** 2 + (sb.y + sb.height / 2 - p.y) ** 2;
        };
        const caption = captions.reduce((best, s) => (d2(s) < d2(best) ? s : best));
        dispatch({ type: "select", ids: [caption.id] });
        onEditText(caption.id);
      } else if (!hit.groupPath && state.features.shapes.includes("text")) {
        // Spawning a fresh caption IS text creation — gated with the text tool.
        // (Editing an existing caption above stays: loaded docs are portable.)
        // A GROUPED container never spawns one either: dblclick on a group
        // aims at the unit — engage a caption it HAS (the branch above), but
        // minting a surprise text on a member is never what was meant. No
        // caption found → just ignore (mirrors the grouped-image crop guard).
        // The pair's first click selected the container — clear it so no
        // Transformer frames a shape under the typing overlay.
        dispatch({ type: "select", ids: [] });
        onTextClick(p.x, p.y);
      }
    }
  };

  // The parent's LIVE box mid-transform, WITHOUT disturbing its node (the
  // Transformer owns scale/position during the drag). rect/ellipse/diamond/image
  // only — reading the group/shape's stored size × the live scale.
  const liveBox = (e: KonvaEventObject<Event>, sh: Shape) => {
    if (sh.type !== "rect" && sh.type !== "ellipse" && sh.type !== "diamond" && sh.type !== "image") return null;
    const node = e.target;
    return { x: node.x(), y: node.y(), width: Math.max(4, sh.width * node.scaleX()), height: Math.max(4, sh.height * node.scaleY()) };
  };

  // Live wrap width while a text side-handle drag is in flight — onTransform
  // accumulates it (and reflows the node at it each frame); bakeTransform
  // commits exactly this number, so the release changes nothing on screen.
  const textResizeRef = useRef<{ id: string; width: number } | null>(null);

  // Bake the Transformer's scale into concrete geometry (on release).
  const bakeTransform = (e: KonvaEventObject<Event>, sh: Shape) => {
    const node = e.target;
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    if (sh.type === "text") {
      // Only the side handles exist for text — the drag resized the WRAP WIDTH
      // live (see onTransform); commit the accumulated width. Fallback for an
      // armed-but-motionless drag: no live entry, box unchanged.
      const live = textResizeRef.current;
      textResizeRef.current = null;
      dispatch({
        type: "commitResize",
        id: sh.id,
        patch: { x: node.x(), y: node.y(), width: live?.id === sh.id ? live.width : Math.max(24, boundingBox(sh).width * sx) },
        distScale: 1 / vsRef.current,
      });
    } else if (sh.type === "rect" || sh.type === "ellipse" || sh.type === "diamond" || sh.type === "image") {
      dispatch({
        type: "commitResize",
        id: sh.id,
        patch: { x: node.x(), y: node.y(), width: Math.max(4, sh.width * sx), height: Math.max(4, sh.height * sy) },
        distScale: 1 / vsRef.current, // anchor keep-or-drop judged at the SCREEN's glue range
      });
    }
  };

  // The node carrying a shape's stroke (an ellipse's / diamond's sits inside
  // its Group — the diamond's is a closed Line).
  const strokedNodeOf = (node: Konva.Node): Konva.Shape | null =>
    node.getClassName?.() === "Group"
      ? ((node as Konva.Group).findOne<Konva.Shape>("Ellipse") ?? (node as Konva.Group).findOne<Konva.Shape>("Line") ?? null)
      : (node as Konva.Shape);

  // Per-shape props: identity (for the Transformer + resize baking). Selection,
  // move, and double-click are all handled at the stage level (size-based), so
  // shapes are not individually draggable.
  const common = (sh: Shape) => ({
    id: sh.id,
    // Content nodes take NO Konva pointer events — hit-testing is manual and
    // semantic (smallestAt: stroke-over-area priority, smallest-wins, zoom-true
    // tolerances). listening:false skips Konva's hit-graph render, halving the
    // per-frame draw work. The Transformer still finds nodes by id (findOne
    // ignores listening) and its own handles stay listening.
    listening: false,
    // Strokes are natively zoom-true (model width attrs scaled by the stage) —
    // but the TRANSFORMER drives node scale live, which would thicken the
    // dragged outline with it (anisotropically under a free resize). So for the
    // drag's duration the node is pinned at its current SCREEN width
    // (strokeScaleEnabled off) and restored on release. The restore must be
    // imperative and exact: react-konva writes prop CHANGES only, and a resize
    // never changes the width prop, so nothing else would undo the pin.
    onTransformStart: (e: KonvaEventObject<Event>) => {
      dispatch({ type: "beginGesture" });
      if (sh.type !== "text" && sh.type !== "image") {
        const n = strokedNodeOf(e.target);
        if (n) {
          n.strokeWidth(n.strokeWidth() * vsRef.current);
          // strokeScaleEnabled(false) renders the WHOLE stroke unscaled — the
          // dash pattern too, so pin it in screen units alongside the width.
          if (n.dash()?.length) n.dash(n.dash().map((d) => d * vsRef.current));
          n.strokeScaleEnabled(false);
        }
      }
    },
    // Live: reflow attached/bound shapes against the ghost box so they follow
    // DURING the drag — but leave the parent's own node untouched (touching it
    // mid-transform makes the Transformer resize from both sides).
    onTransform: (e: KonvaEventObject<Event>) => {
      if (sh.type === "text") {
        // Fold the frame's scale into the WRAP WIDTH and re-run the model's
        // wrap at it: the box tracks the pointer, the lines reflow LIVE, and
        // the glyphs never scale. (The node's width prop is the model box, so
        // the scale always has a real base — see the text element note.)
        const node = e.target;
        const w = Math.max(24, node.width() * node.scaleX());
        node.scaleX(1);
        node.scaleY(1);
        node.setAttrs({ width: w, text: wrapLines(sh.text, sh.fontSize, w).join("\n") });
        textResizeRef.current = { id: sh.id, width: w };
        return;
      }
      const box = liveBox(e, sh);
      if (box) dispatch({ type: "reflowChildrenTo", parentId: sh.id, box, distScale: 1 / vsRef.current });
    },
    onTransformEnd: (e: KonvaEventObject<Event>) => {
      suppressDbl(); // an anchor drag is not a "click" (see suppressDblUntil)
      if (sh.type !== "text" && sh.type !== "image") {
        const n = strokedNodeOf(e.target);
        if (n) {
          n.strokeScaleEnabled(true);
          n.strokeWidth(modelSw(sh)); // exactly the element's prop (see pin note)
          n.dash(dashFor(sh.strokeStyle, modelSw(sh)) ?? []);
        }
      }
      bakeTransform(e, sh);
      dispatch({ type: "endGesture" });
    },
  });

  // Highlight what a to-be-drawn/moved thing would bind or attach to — while
  // drawing (line endpoints, or a box's own attach), and while just hovering with
  // any binding tool in hand. All glue distances are zoom-scaled (screen-true).
  // Each target carries its BOND KIND ({@link GlueGlow}) so the chrome can light
  // exactly what will glue: the pinned edge(s), an ellipse arc, or — for a body
  // bind — the whole frame. Centered containment adds no entry at all.
  const bindHighlights = new Map<string, GlueGlow>();
  const draft = state.draftId ? shapes.find((s) => s.id === state.draftId) : null;
  // Glue-range candidate pool around a box: the widest glue distance, zoom-scaled.
  const glueNear = (b: Box) => index.query({ x: b.x - GLUE_PAD * sPx(1), y: b.y - GLUE_PAD * sPx(1), width: b.width + 2 * GLUE_PAD * sPx(1), height: b.height + 2 * GLUE_PAD * sPx(1) });
  // Classify a would-be attach into its preview chrome. Null = centered
  // containment (a bond, but a visually obvious one — stays silent).
  const glowOf = (at: Attach): GlueGlow | null => {
    const target = shapes.find((s) => s.id === at.id);
    if (!target) return null;
    if (at.kind === "radial") return { kind: "arc", angle: at.angle, box: boundingBox(target) };
    if (at.ax === 0.5 && at.ay === 0.5) return null;
    return { kind: "edge", ax: at.ax, ay: at.ay, box: boundingBox(target) };
  };
  if (draft && (draft.type === "line" || draft.type === "arrow")) {
    for (const end of [
      { x: draft.points[0], y: draft.points[1] },
      { x: draft.points[2], y: draft.points[3] },
    ]) {
      const near = index.queryPoint(end, BIND_DISTANCE * sPx(1)).filter((s) => s.id !== draft.id);
      const id = nearestBindableId(end, near, draft.id, BIND_DISTANCE * sPx(1));
      if (id) bindHighlights.set(id, { kind: "body" });
    }
  } else if (draft && (draft.type === "rect" || draft.type === "ellipse" || draft.type === "diamond")) {
    const at = attachAt(draft, glueNear(boundingBox(draft)), sPx(1));
    const g = at && glowOf(at);
    if (g) bindHighlights.set(at!.id, g);
  } else if (draft && draft.type === "pen") {
    // A scribble drawn along a shape's edge attaches on release — preview it too.
    const at = attachAt(draft, glueNear(boundingBox(draft)).filter((s) => s.id !== draft.id), sPx(1));
    const g = at && glowOf(at);
    if (g) bindHighlights.set(at!.id, g);
  } else if (!state.draftId && hover) {
    // Pre-draw hover preview. A line/arrow endpoint binds anywhere inside a shape
    // (a BODY bind — the whole frame glows). A box tool binds only edge-to-edge,
    // so it previews the edge the hovered spot hugs (or the ellipse arc at its
    // angle) — the deep interior is mere containment and stays silent.
    const hoverNear = index.queryPoint(hover, GLUE_PAD * sPx(1));
    if (tool === "line" || tool === "arrow" || tool === "darrow") {
      const id = nearestBindableId(hover, hoverNear, "", BIND_DISTANCE * sPx(1));
      if (id) bindHighlights.set(id, { kind: "body" });
    } else if (tool === "rect" || tool === "ellipse" || tool === "diamond") {
      const id = nearestEdgeBindableId(hover, hoverNear, "", EDGE_TOUCH * sPx(1));
      const target = id ? shapes.find((s) => s.id === id) : undefined;
      if (target) {
        const b = boundingBox(target);
        if (target.type === "ellipse" || target.type === "diamond") {
          // Radial-anchor targets glow an arc at the bond angle (attachAt gives
          // both angled-border kinds radial anchors).
          const angle = Math.atan2(hover.y - (b.y + b.height / 2), hover.x - (b.x + b.width / 2));
          bindHighlights.set(target.id, { kind: "arc", angle, box: b });
        } else {
          const { ax, ay } = sideAnchor({ x: hover.x, y: hover.y, width: 0, height: 0 }, b, EDGE_TOUCH * sPx(1));
          if (ax !== 0.5 || ay !== 0.5) bindHighlights.set(target.id, { kind: "edge", ax, ay, box: b });
        }
      }
    }
  }
  // While dragging shape(s), highlight what they'd attach to on drop — nearest
  // VISIBLE bond only, mirroring reattach's ≤1-outward-edge-per-unit rule. Skip
  // a member whose `attach` points INTRA-cluster — reattach keeps that edge
  // verbatim (the parent rode along), so there's nothing new to glue. A
  // centered-containment bond doesn't compete: it draws nothing, and letting it
  // win the race would hide a real edge bond another member is about to make.
  if (moveRef.current) {
    const moving = new Set(moveRef.current.ids);
    let best: { id: string; glow: GlueGlow; gap: number } | null = null;
    for (const id of moveRef.current.ids) {
      const sh = shapes.find((s) => s.id === id);
      if (!sh || (sh.attach && moving.has(sh.attach.id))) continue;
      const at = attachAt(sh, glueNear(boundingBox(sh)).filter((o) => !moving.has(o.id)), sPx(1));
      if (!at) continue;
      const glow = glowOf(at);
      if (!glow) continue;
      const target = shapes.find((s) => s.id === at.id);
      if (!target) continue;
      const sb = boundingBox(sh);
      const tb = boundingBox(target);
      const gap = Math.hypot(
        Math.max(tb.x - (sb.x + sb.width), sb.x - (tb.x + tb.width), 0),
        Math.max(tb.y - (sb.y + sb.height), sb.y - (tb.y + tb.height), 0)
      );
      if (!best || gap < best.gap) best = { id: at.id, glow, gap };
    }
    if (best) bindHighlights.set(best.id, best.glow);
  }

  const cursor = panActive
    ? "grabbing"
    : panning && policy !== "fixed"
      ? "grab"
      : tool === "select"
        ? "default"
        : tool === "text"
          ? "text"
          : tool === "eraser"
            ? "cell"
            : "crosshair";

  // The opaque board surface. Bounded/fixed: the doc box (the annotated image, or
  // the sketch canvas). Infinite: no box — cover what's VISIBLE plus the content
  // extent (the latter padded past the export trim so a flattened PNG never
  // catches a transparent corner).
  const visible = visibleLogicalRect(view, stageSize);
  // Content extent cached on the shapes array identity — recomputing O(n) per
  // camera frame made panning the slowest gesture at high shape counts.
  const content = useMemo(() => contentBounds(shapes), [shapes]);

  // ── Viewport culling ─────────────────────────────────────────────────────────
  // Konva rasterizes every layer node per frame, visible or not — the scaling
  // wall once a board outgrows the screen. Cull to a window around the visible
  // rect, QUANTIZED on a power-of-2 "zoom bucket" grid: the memo key survives
  // pans within half a bucket AND zoom drift within an octave, so almost every
  // camera frame reuses the culled array (a per-frame key was the thrash that
  // made zoom slower than no culling at all). Hit-testing, bounds, and the
  // minimap always use the FULL list — culling is render-only.
  const bucketRef = useRef<{ bw: number; bh: number } | null>(null);
  const cullWindow = (() => {
    // Power-of-2 buckets with HYSTERESIS: a zoom oscillating right at a bucket
    // boundary must not flip the cull key (and refilter N shapes) every frame —
    // the previous bucket is kept while the viewport stays within ±10% of it.
    const rawW = 2 ** Math.ceil(Math.log2(Math.max(1e-6, visible.width)));
    const rawH = 2 ** Math.ceil(Math.log2(Math.max(1e-6, visible.height)));
    const prev = bucketRef.current;
    const bw = prev && visible.width > prev.bw * 0.45 && visible.width <= prev.bw * 1.1 ? prev.bw : rawW;
    const bh = prev && visible.height > prev.bh * 0.45 && visible.height <= prev.bh * 1.1 ? prev.bh : rawH;
    bucketRef.current = { bw, bh };
    const gx = bw / 2;
    const gy = bh / 2;
    const x0 = Math.floor((visible.x - bw / 2) / gx) * gx;
    const y0 = Math.floor((visible.y - bh / 2) / gy) * gy;
    return {
      x: x0,
      y: y0,
      width: Math.ceil((visible.x + visible.width + bw / 2) / gx) * gx - x0,
      height: Math.ceil((visible.y + visible.height + bh / 2) / gy) * gy - y0,
    };
  })();
  const cullKey = renderAll ? "all" : `${cullWindow.x}:${cullWindow.y}:${cullWindow.width}:${cullWindow.height}`;
  const renderShapes = useMemo(() => {
    if (renderAll) return shapes;
    // Grid query finds the members; the identity-Set filter keeps the shapes
    // array's INSERTION order (paintOrder's z-rules depend on it).
    const inWindow = new Set(index.query(cullWindow));
    if (inWindow.size === shapes.length) return shapes;
    // Units cull WHOLE: paintOrder weighs a group by its filled members' union
    // footprint, so a half-culled group would change z as you pan. Any visible
    // member pulls in the rest (offscreen members are cheap — Konva clips them).
    let keys: Set<string> | null = null;
    for (const sh of shapes) if (sh.groupPath && inWindow.has(sh)) (keys ??= new Set()).add(sh.groupPath[0]);
    if (keys) {
      const want = keys;
      for (const sh of shapes) if (sh.groupPath && !inWindow.has(sh) && want.has(sh.groupPath[0])) inWindow.add(sh);
    }
    return shapes.filter((sh) => inWindow.has(sh));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, cullKey]);

  // ── Gesture layer split ──────────────────────────────────────────────────────
  // During a CONTENT gesture (drag/draw/erase/resize — the reducer holds a
  // gestureBase), shapes fall into two layers: STATIC (identity preserved since
  // gesture start — cacheable as one bitmap) and DYNAMIC (new identities from
  // this gesture's edits, plus the selection: a Transformer target moves at the
  // Konva level without a model identity change). The rest of the board then
  // costs one bitmap per frame while only the moving handful re-rasterizes.
  const baseSet = useMemo(() => new Set<Shape>(state.gestureBase ?? []), [state.gestureBase]);
  const splitRef = useRef<{ stat: Shape[]; dyn: Shape[] }>({ stat: [], dyn: [] });
  const { stat: staticShapes, dyn: dynamicShapes } = useMemo(() => {
    // Split the GLOBAL paint order into a static prefix + dynamic tail (see
    // splitGestureLayers): the dynamic layer paints above the static one, so
    // only a contiguous tail keeps cross-layer stacking equal to paint order —
    // selection/gestures never change what covers what. Selected shapes always
    // ride the dynamic tail so the Transformer's target never jumps layers
    // when a resize gesture begins.
    const { stat, dyn } = splitGestureLayers(paintOrder(renderShapes), { contentGesture, baseSet, selected });
    // STABLE identities: renderShapes is a fresh array every edit frame, but the
    // static membership rarely changes mid-gesture — returning the previous
    // arrays keeps the static layer's children (and its bitmap cache) untouched.
    const prev = splitRef.current;
    const same = (a: Shape[], b: Shape[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const out = {
      stat: same(stat, prev.stat) ? prev.stat : stat,
      dyn: same(dyn, prev.dyn) ? prev.dyn : dyn,
    };
    splitRef.current = out;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderShapes, contentGesture, baseSet, selectedIds]);

  // Bitmap-cache management, imperative and conservative: caching costs a full
  // draw + a multi-MB canvas alloc, so it only happens when it PAYS (a big
  // culled set) and only re-fires when the view actually leaves the cached
  // region or needs meaningfully sharper pixels — never per frame.
  const CACHE_MIN_NODES = 600;
  const CACHE_MIN_INTERVAL_MS = 150;
  const cacheState = useRef<{ region: Box; scale: number; at: number; content: Shape[] } | null>(null);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    // Cache the STATIC layer during camera gestures AND content gestures — in
    // both, its pixels are camera-transformed but otherwise frozen.
    const active = (camGesture || contentGesture) && !renderAll && !croppingId && staticShapes.length >= CACHE_MIN_NODES;
    if (!active) {
      if (cacheState.current) {
        cacheState.current = null;
        layer.clearCache();
        layer.batchDraw();
      }
      return;
    }
    const c = cacheState.current;
    // A membership change (an erase removed a static shape) invalidates the
    // bitmap NOW — a throttle here would show ghosts of deleted content.
    const contentSame = c && c.content === staticShapes;
    const inRegion =
      c &&
      visible.x >= c.region.x &&
      visible.y >= c.region.y &&
      visible.x + visible.width <= c.region.x + c.region.width &&
      visible.y + visible.height <= c.region.y + c.region.height;
    // Tolerate soft pixels while zooming in up to 1.5× past the cached scale and
    // any amount of zoom-out (the bitmap only gains oversampling that way).
    const scaleOk = c && vs <= c.scale * 1.5;
    if (contentSame && inRegion && scaleOk) return;
    // SHARPNESS refreshes are throttled (the scaled bitmap carries the gesture a
    // beat longer); a region EXIT or content change recaches immediately.
    if (c && contentSame && inRegion && performance.now() - c.at < CACHE_MIN_INTERVAL_MS) return;
    const region = padBox(visible, Math.max(visible.width, visible.height)); // ≈3× viewport
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    layer.cache({ x: region.x, y: region.y, width: region.width, height: region.height, pixelRatio: vs * dpr });
    cacheState.current = { region, scale: vs, at: performance.now(), content: staticShapes };
    layer.batchDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camGesture, contentGesture, view.x, view.y, vs, renderAll, croppingId, staticShapes]);
  // Unmount: leave no dangling bitmap.
  useEffect(() => {
    return () => {
      layerRef.current?.clearCache();
    };
  }, []);

  // ── Live stroke floor ───────────────────────────────────────────────────────
  // The 1px floor must HOLD through a zoom gesture — "small stays small", never
  // drift-below-and-crisp-up (or overshoot-and-snap-back) at settle. Element
  // props can't do that without an O(N) rebuild per wheel frame, so this pass
  // writes the attrs imperatively after every render: any stroke below the
  // floor at the LIVE scale gets MIN/vs model units (exactly 1 screen px), and
  // one crossing back above it is restored to its model width — the handoff is
  // continuous (at the threshold MIN/vs == the model width). Settle rebuilds
  // then write the very same values through props. Layout effect so the attrs
  // land in the same commit's batchDraw as the camera. Zero work above the
  // floor (quick reject); nodes pinned by a Transformer drag
  // (strokeScaleEnabled off) are the pin's — skipped.
  const liveFlooredIds = useRef(new Set<string>());
  useLayoutEffect(() => {
    const stage = layerRef.current?.getStage();
    if (!stage) return;
    if (minModelStroke * vs >= MIN_STROKE_PX && liveFlooredIds.current.size === 0) return;
    const byId = new Map<string, Konva.Node>();
    for (const layer of stage.getLayers()) for (const child of layer.getChildren()) if (child.id()) byId.set(child.id(), child);
    const next = new Set<string>();
    let dirty = false;
    for (const sh of shapes) {
      if (sh.type === "text" || sh.type === "image") continue;
      const floored = sh.strokeWidth * vs < MIN_STROKE_PX;
      if (!floored && !liveFlooredIds.current.has(sh.id)) continue;
      const raw = byId.get(sh.id);
      const n = raw ? strokedNodeOf(raw) : null;
      if (!n || n.strokeScaleEnabled() === false) continue;
      if (floored) next.add(sh.id);
      const want = floored ? MIN_STROKE_PX / vs : sh.strokeWidth;
      if (n.strokeWidth() !== want) {
        n.strokeWidth(want);
        // The dash pattern is width-derived — ride the floored width so
        // dashes/dots stay legible at the floor too.
        const dash = dashFor(sh.strokeStyle, want);
        if (dash) n.dash(dash);
        dirty = true;
      }
    }
    liveFlooredIds.current = next;
    if (dirty) stage.batchDraw();
  });

  const infiniteBg = policy === "infinite"
    ? (() => {
        const vis = padBox(visible, sPx(8));
        return content ? unionBox(vis, padBox(content, 40)) : vis;
      })()
    : null;

  // Shape elements, cached PER SHAPE OBJECT (the reducer preserves the
  // identity of untouched shapes): a pen point or a one-shape drag rebuilds ONE
  // element, not N. The cache epoch resets when anything cross-cutting shifts —
  // the raster backdrop (adaptive ink resamples), image decodes, edit/crop
  // hides, a stroke-floor re-derive on zoom settle (`floorVs`; only ever fires
  // zoomed out below the floor) — trading one full rebuild for correctness.
  // Mid-gesture camera pans/zooms don't touch elements at all (live values
  // read through refs; widths are model units the stage scales natively).
  const shapeElCache = useRef(new WeakMap<Shape, React.ReactElement | null>());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useMemo(() => {
    shapeElCache.current = new WeakMap();
  }, [imgEls, imgSig, bgImage, editingId, croppingId, lumEpoch, floorVs]);
  const buildShapeEl = (sh: Shape): React.ReactElement | null => {
          if (sh.id === editingId && sh.type === "text") return null; // hidden under the textarea
          // Adaptive ink resolves to a solid color contrasting the background
          // under the shape; other scribbles never affect it.
          const stroke = inkFor(sh);
          // MODEL-unit width, floored for legibility (class doc) — the stage
          // transform applies the camera natively, no factor here.
          const sw = modelSw(sh);
          // Dash pattern in the same model units (it scales with the geometry);
          // derived from the RENDERED width so a floored stroke keeps a legible
          // pattern too. Dotted needs round caps to paint dots — boxes opt in
          // per style, open strokes are round-capped anyway.
          const dash = dashFor(sh.strokeStyle, sw);
          const dotCap = sh.strokeStyle === "dotted" ? ("round" as const) : undefined;
          switch (sh.type) {
            case "rect": {
              const b = viewBox(sh);
              return <Rect key={sh.id} {...common(sh)} {...b} fill={sh.fill} stroke={stroke} strokeWidth={sw} dash={dash} lineCap={dotCap} />;
            }
            case "ellipse": {
              const b = viewBox(sh);
              return (
                <Group key={sh.id} {...common(sh)} x={b.x} y={b.y}>
                  <Ellipse x={b.width / 2} y={b.height / 2} radiusX={b.width / 2} radiusY={b.height / 2} fill={sh.fill} stroke={stroke} strokeWidth={sw} dash={dash} lineCap={dotCap} />
                </Group>
              );
            }
            case "diamond": {
              // Same Group-wrapper pattern as the ellipse (the Transformer reads
              // the group's box; strokedNodeOf finds the Line inside).
              const b = viewBox(sh);
              return (
                <Group key={sh.id} {...common(sh)} x={b.x} y={b.y}>
                  <Line points={diamondPoints({ x: 0, y: 0, width: b.width, height: b.height })} closed fill={sh.fill} stroke={stroke} strokeWidth={sw} dash={dash} lineCap={dotCap} lineJoin="round" />
                </Group>
              );
            }
            case "line":
              return <Line key={sh.id} {...common(sh)} points={sh.points} stroke={stroke} strokeWidth={sw} dash={dash} lineCap="round" />;
            case "arrow":
              return (
                <Arrow
                  key={sh.id}
                  {...common(sh)}
                  points={sh.points}
                  stroke={stroke}
                  fill={stroke}
                  strokeWidth={sw}
                  // Pointer geometry is LOGICAL, like the width now is — above
                  // the floor that's 8 + sh.strokeWidth; below it the head
                  // floors along with the tail.
                  pointerLength={8 + sw}
                  pointerWidth={8 + sw}
                  pointerAtBeginning={sh.doubleHead}
                  dash={dash}
                  lineCap={dotCap}
                />
              );
            case "pen":
              return (
                <Fragment key={sh.id}>
                  {/* An ENCLOSED doodle's fill: a closed, strokeless twin UNDER
                      the real stroke (same tension spline) — the visible stroke
                      keeps its true open path, no synthetic closing segment.
                      Keyless/id-less: every id-lookup (transformer, export
                      stroke overrides, the floor walk) must find the STROKE. */}
                  {sh.fill && isEnclosed(sh.points) && (
                    <Line points={sh.points} closed fill={sh.fill} listening={false} tension={0.4} />
                  )}
                  <Line
                    {...common(sh)}
                    points={sh.points}
                    stroke={stroke}
                    strokeWidth={sw}
                    dash={dash}
                    lineCap="round"
                    lineJoin="round"
                    tension={0.4}
                  />
                </Fragment>
              );
            case "text":
              // The MODEL wraps (textMetrics) and the node renders its lines —
              // never Konva's own wrap (wrap "none") — so bbox/hit/exports agree
              // exactly. The node also carries the MODEL box width: the
              // Transformer then clings to the same box everything else uses —
              // and never measures 0 where canvas font metrics don't exist
              // (headless box without font files).
              return (
                <Fragment key={sh.id}>
                  {/* Background highlight: the padded block behind the glyphs
                      (visual only — layout/hit metrics stay the bare block). */}
                  {sh.fill && (() => {
                    const bg = textBgBox(sh);
                    return <Rect x={bg.x} y={bg.y} width={bg.width} height={bg.height} cornerRadius={bg.pad} fill={sh.fill} listening={false} />;
                  })()}
                  <Text
                    {...common(sh)}
                    x={sh.x}
                    y={sh.y}
                    width={boundingBox(sh).width}
                    wrap="none"
                    text={wrapLines(sh.text, sh.fontSize, sh.width).join("\n")}
                    fontSize={sh.fontSize}
                    fontFamily={BOARD_FONT_STACK}
                    fill={stroke}
                  />
                </Fragment>
              );
            case "image": {
              const img = imgEls[sh.id];
              if (!img || sh.id === croppingId) return null; // decoding, or the crop overlay renders it
              return <KonvaImage key={sh.id} {...common(sh)} image={img} x={sh.x} y={sh.y} width={sh.width} height={sh.height} crop={sh.crop} />;
            }
          }
  };
  const nodesFor = (list: Shape[]) => {
    // The lists arrive ALREADY paint-ordered (the layer split runs on the
    // global paint order) — re-sorting a sublist here could disagree with it.
    const cache = shapeElCache.current;
    return list.map((sh) => {
      if (cache.has(sh)) return cache.get(sh)!;
      const el = buildShapeEl(sh);
      cache.set(sh, el);
      return el;
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const staticShapeNodes = useMemo(() => nodesFor(staticShapes), [staticShapes, imgEls, editingId, croppingId, floorVs]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dynamicShapeNodes = useMemo(() => nodesFor(dynamicShapes), [dynamicShapes, imgEls, editingId, croppingId, floorVs]);
  return (
    <Stage
      ref={stageRef}
      width={stageSize.w}
      height={stageSize.h}
      x={view.x}
      y={view.y}
      scaleX={vs}
      scaleY={vs}
      onMouseDown={onStageDown}
      onMouseMove={onStageMove}
      onMouseUp={onStageUp}
      onMouseLeave={() => setHover(null)}
      onContextMenu={(e) => e.evt.preventDefault()}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ cursor, touchAction: "none" }}
    >
      <Layer ref={layerRef}>
        {/* Opaque background so the exported PNG is legible: the annotated image,
            or the board surface. Non-listening so clicks on it count as "empty
            canvas". */}
        {infiniteBg ? (
          <Rect x={infiniteBg.x} y={infiniteBg.y} width={infiniteBg.width} height={infiniteBg.height} fill={bgColor} listening={false} />
        ) : bgImage ? (
          <KonvaImage image={bgImage} width={state.width} height={state.height} listening={false} />
        ) : (
          <Rect x={0} y={0} width={state.width} height={state.height} fill={bgColor} listening={false} />
        )}

        {/* Images are a background layer; every vector shape paints above them (a
            small rect glued behind a big image shows). Non-images keep draw order.
            Konva/hit-testing use ids, not child order, so this is purely visual.
            The whole element array is MEMOIZED (below): a camera pan re-renders
            the Stage transform only — rebuilding N shape elements per wheel frame
            was the board's scaling wall. */}
        {staticShapeNodes}
      </Layer>

      {/* DYNAMIC layer: the live gesture's shapes + all chrome. Stays tiny per
          frame while the static layer above rides its bitmap cache. */}
      <Layer>
        {dynamicShapeNodes}

        {/* Glue preview — bond-specific chrome for what a drawn/moved thing
            would glue to ({@link GlueGlow}). An EDGE bond lights only the
            pinned edge(s) of the target's OWN box — the seam that will hold;
            an ellipse bond ARCs the border around the bond angle; a BODY bind
            (line/arrow endpoint) frames the whole unit — a grouped target as
            its unit bounds (the glue system sees the group as one element).
            ≤1 glow per target unit; chrome at constant SCREEN size (÷ zoom). */}
        {(() => {
          const seen = new Set<string>();
          const els: React.ReactElement[] = [];
          const glow = {
            stroke: SELECT_COLOR,
            strokeWidth: sPx(2),
            shadowColor: SELECT_COLOR,
            shadowBlur: sPx(10),
            shadowOpacity: 0.7,
            listening: false,
          };
          for (const [id, g] of bindHighlights) {
            const key = units.rootOf(id);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            if (g.kind === "body") {
              const b = units.boundsOf(key);
              if (!b) continue;
              els.push(
                <Rect
                  key={`bind-${key}`}
                  name="glue-body"
                  x={b.x - sPx(4)}
                  y={b.y - sPx(4)}
                  width={b.width + sPx(8)}
                  height={b.height + sPx(8)}
                  cornerRadius={sPx(4)}
                  {...glow}
                />
              );
            } else if (g.kind === "edge") {
              // The pinned edge(s) of the padded target box — a corner bond
              // draws both edges as one polyline through the shared corner.
              const b = padBox(g.box, sPx(4));
              const ex = g.ax === 0 ? b.x : b.x + b.width; // the pinned vertical edge
              const ey = g.ay === 0 ? b.y : b.y + b.height; // the pinned horizontal edge
              const pts =
                g.ax !== 0.5 && g.ay !== 0.5
                  ? [ex, g.ay === 0 ? b.y + b.height : b.y, ex, ey, g.ax === 0 ? b.x + b.width : b.x, ey]
                  : g.ax !== 0.5
                    ? [ex, b.y, ex, b.y + b.height]
                    : [b.x, ey, b.x + b.width, ey];
              els.push(<Line key={`bind-${key}`} name="glue-edge" points={pts} lineCap="round" lineJoin="round" {...glow} />);
            } else {
              // Sample the padded ellipse border ±45° around the bond angle.
              const cx = g.box.x + g.box.width / 2;
              const cy = g.box.y + g.box.height / 2;
              const rx = g.box.width / 2 + sPx(4);
              const ry = g.box.height / 2 + sPx(4);
              const pts: number[] = [];
              for (let i = 0; i <= 24; i++) {
                const a = g.angle + (i / 24 - 0.5) * (Math.PI / 2);
                pts.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
              }
              els.push(<Line key={`bind-${key}`} name="glue-arc" points={pts} lineCap="round" {...glow} />);
            }
          }
          return els;
        })()}

        {/* Selection outlines for anything the Transformer isn't already framing
            (a lone resizable shape or a whole group's proxy). Partitioned into
            root units: a fully-covered multi-member unit gets ONE group-AABB
            outline; loose shapes get per-shape outlines; a deep-selected proper
            subset gets its own outline plus a SUBDUED unit outline for context. */}
        {!soleResizable &&
          !soleUnitKey &&
          (() => {
            const byUnit = new Map<string, string[]>();
            for (const id of selectedIds) {
              const key = units.rootOf(id);
              if (!key) continue;
              const arr = byUnit.get(key);
              if (arr) arr.push(id);
              else byUnit.set(key, [id]);
            }
            const els: React.ReactElement[] = [];
            const outline = (key: string, b: Box, subdued = false) =>
              els.push(
                <Rect
                  key={`sel-${key}`}
                  x={b.x - sPx(3)}
                  y={b.y - sPx(3)}
                  width={b.width + sPx(6)}
                  height={b.height + sPx(6)}
                  stroke={SELECT_COLOR}
                  strokeWidth={sPx(1)}
                  dash={[sPx(4), sPx(4)]}
                  opacity={subdued ? 0.35 : 1}
                  listening={false}
                />
              );
            for (const [key, ids] of byUnit) {
              const memberCount = units.membersOf(key).size;
              if (memberCount > 1 && ids.length === memberCount) {
                const b = units.boundsOf(key);
                if (b) outline(key, b);
              } else {
                for (const id of ids) {
                  const sh = shapes.find((s) => s.id === id);
                  if (sh) outline(id, boundingBox(sh));
                }
                // Deep-select: the member's own outline + the unit box, subdued.
                if (memberCount > 1) {
                  const b = units.boundsOf(key);
                  if (b) outline(`unit-${key}`, b, true);
                }
              }
            }
            return els;
          })()}

        {marquee && (
          <Rect
            x={marquee.x}
            y={marquee.y}
            width={marquee.width}
            height={marquee.height}
            stroke={SELECT_COLOR}
            strokeWidth={sPx(1)}
            dash={[sPx(4), sPx(4)]}
            fill={`${SELECT_COLOR}18`}
            listening={false}
          />
        )}

        {/* Synthetic proxy rect for whole-group scaling: the Transformer attaches
            HERE (members' own nodes never get handles). Invisible + non-listening
            (transform events are fired by the Transformer directly, not the hit
            graph). Its props stay at the gesture-start bounds during a scale so
            React never fights the Transformer's node mutations; the model-driven
            scaleUnitGhost restamps the members themselves each frame. */}
        {proxyBounds && !editing && !croppingId && (
          <Rect
            id={UNIT_PROXY_ID}
            x={proxyBounds.x}
            y={proxyBounds.y}
            width={proxyBounds.width}
            height={proxyBounds.height}
            listening={false}
            onTransformStart={(e) => {
              dispatch({ type: "beginGesture" });
              const anchor = trRef.current?.getActiveAnchor() ?? "bottom-right";
              const b = proxyBounds;
              // SIDE anchors stretch one axis (members follow the scaling —
              // boxes stretch, text keeps %-position, bound arrows re-cling);
              // corner anchors scale uniformly (keepRatio). The fixed point is
              // the corner/edge OPPOSITE the active anchor (the unused axis'
              // origin is inert — its factor stays 1).
              const side = anchor === "middle-left" || anchor === "middle-right" || anchor === "top-center" || anchor === "bottom-center";
              const origin = {
                x: anchor.includes("left") ? b.x + b.width : b.x,
                y: anchor.includes("top") ? b.y + b.height : b.y,
              };
              unitScaleRef.current = { ids: [...selectedIds], origin, base: b, side };
            }}
            onTransform={(e) => {
              const g = unitScaleRef.current;
              if (!g) return;
              if (g.side) dispatch({ type: "stretchUnitGhost", ids: g.ids, fx: e.target.scaleX(), fy: e.target.scaleY(), origin: g.origin });
              // keepRatio + corner anchors → uniform; read one axis.
              else dispatch({ type: "scaleUnitGhost", ids: g.ids, factor: e.target.scaleX(), origin: g.origin });
            }}
            onTransformEnd={(e) => {
              suppressDbl(); // an anchor drag is not a "click" (see suppressDblUntil)
              const g = unitScaleRef.current;
              unitScaleRef.current = null;
              const node = e.target;
              const fx = node.scaleX();
              const fy = node.scaleY();
              node.scaleX(1);
              node.scaleY(1);
              node.position({ x: g?.base.x ?? node.x(), y: g?.base.y ?? node.y() });
              if (g?.side) dispatch({ type: "stretchUnit", ids: g.ids, fx, fy, origin: g.origin, distScale: 1 / vsRef.current });
              else if (g) dispatch({ type: "scaleUnit", ids: g.ids, factor: fx, origin: g.origin, distScale: 1 / vsRef.current });
              dispatch({ type: "endGesture" });
            }}
          />
        )}

        <Transformer
          ref={trRef}
          rotateEnabled={false}
          borderStroke={SELECT_COLOR}
          anchorStroke={SELECT_COLOR}
          anchorSize={8}
          ignoreStroke
          // Group proxy mode: corners scale uniformly (keepRatio stays at
          // Konva's default TRUE — corner drags keep proportion, exactly the
          // uniform constraint the proxy needs), SIDE anchors stretch one axis
          // (single-axis regardless of keepRatio — members follow the scaling,
          // text undistorted), and no flip. Same 8 anchors as any other shape.
          flipEnabled={!soleUnitKey}
          // Set per-selection HERE (react-konva re-applies props each render —
          // an imperatively set anchor list would revert on the next render).
          enabledAnchors={soleResizable && soleSel?.type === "text" ? TEXT_ANCHORS : ALL_ANCHORS}
          boundBoxFunc={(oldBox, newBox) => (newBox.width < 6 || newBox.height < 6 ? oldBox : newBox)}
        />

        {croppingId &&
          (() => {
            const sh = shapes.find((s) => s.id === croppingId);
            const img = imgEls[croppingId];
            if (!sh || sh.type !== "image" || !img) return null;
            return (
              <CropLayer
                img={img}
                shape={sh}
                cover={padBox(visible, sPx(4))}
                controlRef={cropControlRef}
                onApply={(box, crop) => onCropApply(croppingId, box, crop)}
                onCancel={onCropCancel}
              />
            );
          })()}
      </Layer>
    </Stage>
  );
}

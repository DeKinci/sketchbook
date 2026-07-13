import { useEffect, useRef, useState } from "react";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node.js";
import { Stage, Layer, Rect, Ellipse, Line, Arrow, Text, Image as KonvaImage, Group, Label, Tag, Transformer } from "react-konva";
import { CropLayer, type CropControl } from "./CropLayer.tsx";
import {
  nearestBindableId,
  nearestEdgeBindableId,
  attachAt,
  boundingBox,
  contentBounds,
  moveClusterIds,
  paintOrder,
  isContrastInk,
  labelFont,
  shapesInMarquee,
  BIND_DISTANCE,
  EDGE_TOUCH,
  CANVAS_BG_DARK,
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
const RESIZABLE = new Set(["rect", "ellipse", "text", "image"]);
const SELECT_COLOR = "#8b5cf6";

/** Distance from a point to a line segment (for stroke hit-testing). */
function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Normalized render box for a rect/ellipse (may be negative mid-draw). */
function viewBox(b: BoxShape) {
  return {
    x: b.width < 0 ? b.x + b.width : b.x,
    y: b.height < 0 ? b.y + b.height : b.y,
    width: Math.abs(b.width),
    height: Math.abs(b.height),
  };
}

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
  editingLabelId,
  croppingId,
  onTextClick,
  onEditText,
  onEditLabel,
  onCropImage,
  onCropApply,
  onCropCancel,
  cropControlRef,
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
  /** A text/label edit is in progress — canvas pointer input is suppressed so a
   *  click elsewhere just blurs the textarea (committing it) instead of starting
   *  a new action or discarding the text. */
  editing: boolean;
  /** A text shape currently being edited (hidden under the textarea), or null. */
  editingId: string | null;
  /** A shape whose bound label is being edited (label hidden), or null. */
  editingLabelId: string | null;
  /** Place + edit a new standalone text at these logical coords (text tool). */
  onTextClick: (x: number, y: number) => void;
  /** Reopen an existing text shape for editing. */
  onEditText: (id: string) => void;
  /** Edit the bound label of a (non-text) shape. */
  onEditLabel: (id: string) => void;
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
  newId: () => string;
}) {
  const trRef = useRef<Konva.Transformer>(null);
  const { tool, shapes, selectedIds, color, strokeWidth } = state;
  const selected = new Set(selectedIds);
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const moveRef = useRef<{ last: { x: number; y: number }; ids: string[] } | null>(null);
  const erasing = useRef(false);

  // The camera scale, and the screen→logical factor for every UX threshold.
  const vs = view.scale;
  const sPx = (px: number) => px / vs;

  // ── Camera gestures (pan drag / wheel / pinch) ──────────────────────────────
  // Pan drag: INCREMENTAL screen deltas fed through the functional updater — no
  // anchor captured from the (possibly stale) `view` prop, so a pan starting
  // amid trackpad-inertia wheel updates never snaps the camera back a frame.
  // Active on middle-button, or any button while space is held.
  const panRef = useRef<{ lx: number; ly: number } | null>(null);
  const [panActive, setPanActive] = useState(false);
  // Pinch: previous frame's touch distance + center.
  const pinchRef = useRef<{ d: number; c: { x: number; y: number } } | null>(null);

  const containerPoint = (e: KonvaEventObject<unknown>, clientX: number, clientY: number) => {
    const rect = e.target.getStage()?.container().getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: 0, y: 0 };
  };

  const startPan = (e: KonvaEventObject<MouseEvent>) => {
    settleGesture(); // a live draft/move/marquee must not keep running under the pan
    panRef.current = { lx: e.evt.clientX, ly: e.evt.clientY };
    setPanActive(true);
  };
  const endPan = () => {
    panRef.current = null;
    setPanActive(false);
  };

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    if (policy === "fixed") return;
    e.evt.preventDefault();
    const pt = containerPoint(e, e.evt.clientX, e.evt.clientY);
    if (e.evt.ctrlKey || e.evt.metaKey) {
      // Trackpad pinches arrive as ctrl+wheel with small deltas; mouse notches are
      // ~100 — clamp so one notch is a pleasant step, not a 2.7× jump.
      const factor = Math.exp(-clampN(e.evt.deltaY, -50, 50) * 0.006);
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

  // Downscaled luminance map of the "backdrop" the ink contrasts against — the
  // annotated background image AND any dropped image shapes, but NEVER the
  // scribbles. Sampled over the union RECT of those rasters (an infinite board
  // has no canvas box to cover; everything outside the rect is the dark board).
  // Rebuilt only when that backdrop changes (a signature of the image shapes),
  // not on every pen point.
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const bgLumRef = useRef<{ data: Uint8ClampedArray; w: number; h: number; rect: Box } | null>(null);
  const imgSig = shapes
    .filter((s) => s.type === "image")
    .map((s) => `${s.id}:${Math.round((s as { x: number }).x)}:${Math.round((s as { y: number }).y)}:${(s as { width: number }).width | 0}:${(s as { height: number }).height | 0}`)
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
    // then every placed image shape at its rect — all mapped into the union rect.
    const mx = (x: number) => ((x - rect.x) / rect.width) * w;
    const my = (y: number) => ((y - rect.y) / rect.height) * h;
    ctx.fillStyle = CANVAS_BG_DARK;
    ctx.fillRect(0, 0, w, h);
    if (bgImage) ctx.drawImage(bgImage, mx(0), my(0), (state.width / rect.width) * w, (state.height / rect.height) * h);
    for (const sh of shapesRef.current) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgImage, imgEls, imgSig, state.width, state.height]);

  /** Solid render color for a shape: its own color, or — for the adaptive ink —
   *  white/near-black chosen to contrast the background sampled under it. Outside
   *  the sampled raster rect there's only the dark board → bright ink. */
  const inkFor = (sh: Shape): string => {
    if (!isContrastInk(sh.stroke)) return sh.stroke;
    const s = bgLumRef.current;
    if (!s) return "#f5f5f5"; // dark blank canvas → bright ink
    const b = boundingBox(sh);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    if (cx < s.rect.x || cx > s.rect.x + s.rect.width || cy < s.rect.y || cy > s.rect.y + s.rect.height) return "#f5f5f5";
    const px = clampN(Math.round(((cx - s.rect.x) / s.rect.width) * s.w), 0, s.w - 1);
    const py = clampN(Math.round(((cy - s.rect.y) / s.rect.height) * s.h), 0, s.h - 1);
    const i = (py * s.w + px) * 4;
    const lum = (0.2126 * s.data[i] + 0.7152 * s.data[i + 1] + 0.0722 * s.data[i + 2]) / 255;
    return lum > 0.55 ? "#111111" : "#f5f5f5";
  };

  const soleResizable =
    selectedIds.length === 1 && RESIZABLE.has(shapes.find((s) => s.id === selectedIds[0])?.type ?? "");

  // Bind the Transformer to a lone resizable selection (else it stays detached;
  // multi/segment selections show dashed outlines instead).
  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    if (tool === "select" && soleResizable && selectedIds[0] !== editingId && !croppingId) {
      const node = stage.findOne<Konva.Node>(`#${selectedIds[0]}`);
      tr.nodes(node ? [node] : []);
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [selectedIds, tool, soleResizable, editingId, croppingId, shapes, stageRef]);

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
    for (const sh of shapes) {
      if (sh.type === "line" || sh.type === "arrow" || sh.type === "pen") {
        if (onStroke(sh, pt) && (!bestStroke || area(sh) < area(bestStroke))) bestStroke = sh;
      } else if (inBox(sh, pt) && (!bestArea || area(sh) < area(bestArea))) {
        bestArea = sh;
      }
    }
    return bestStroke ?? bestArea;
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
      // Re-detect attachments for what was dragged (attach if dropped edge-to-edge
      // with a shape, detach if dragged away), then commit the whole gesture. The
      // glue distance is zoom-scaled: "touching" is judged on SCREEN.
      dispatch({ type: "reattach", ids: moveRef.current.ids, distScale: sPx(1) });
      dispatch({ type: "endGesture" });
      moveRef.current = null;
      return;
    }
    if (marqueeStart.current && marquee) {
      const box = { ...marquee };
      marqueeStart.current = null;
      setMarquee(null);
      if (Math.abs(box.width) >= sPx(3) || Math.abs(box.height) >= sPx(3)) {
        dispatch({ type: "select", ids: shapesInMarquee(shapes, box) });
      }
      return;
    }
    marqueeStart.current = null;
    // Degenerate threshold: 2 SCREEN px (a click-no-drag at any zoom); glue
    // distances likewise screen-scaled.
    if (state.draftId) dispatch({ type: "endDraw", minSize: sPx(2), distScale: sPx(1) });
  };

  const onStageDown = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
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
      const hit = smallestAt(logicalPointer(e));
      if (!hit) {
        const p = logicalPointer(e);
        marqueeStart.current = p;
        setMarquee({ x: p.x, y: p.y, width: 0, height: 0 });
        dispatch({ type: "select", ids: [] });
        return;
      }
      const shiftKey = "shiftKey" in e.evt && e.evt.shiftKey;
      if (shiftKey) {
        dispatch({ type: "toggleSelect", id: hit.id });
        return;
      }
      // Clicking inside an existing multi-selection keeps it (drag the group);
      // otherwise select just the hit shape. Then begin a manual move gesture —
      // dragging a shape also drags everything fully contained within it.
      const ids = selected.has(hit.id) && selectedIds.length > 1 ? selectedIds : [hit.id];
      if (!selected.has(hit.id)) dispatch({ type: "select", ids: [hit.id] });
      dispatch({ type: "beginGesture" });
      // Followers ride by INCLUSION: the size-gated attach cluster ("largest drags
      // smallest") plus every dragged container's contents (moveClusterIds folds in
      // containment). The reducer freezes anything left out of this set.
      moveRef.current = { last: logicalPointer(e), ids: moveClusterIds(shapes, ids) };
      return;
    }
    const { x, y } = logicalPointer(e);
    if (!insideDoc({ x, y })) return; // bounded/fixed: ink starts inside the box
    if (tool === "text") {
      onTextClick(x, y);
      return;
    }
    const id = newId();
    if (tool === "pen") {
      dispatch({ type: "beginDraw", shape: { id, type: "pen", stroke: color, strokeWidth, points: [x, y] } });
    } else if (tool === "rect" || tool === "ellipse") {
      dispatch({ type: "beginDraw", shape: { id, type: tool, stroke: color, strokeWidth, x, y, width: 0, height: 0 } });
    } else if (tool === "line" || tool === "arrow" || tool === "darrow") {
      // A double-arrow is a normal arrow shape flagged `doubleHead` (identical
      // geometry, a head at both ends in the view).
      const type = tool === "line" ? "line" : "arrow";
      dispatch({
        type: "beginDraw",
        shape: { id, type, stroke: color, strokeWidth, points: [x, y, x, y], ...(tool === "darrow" && { doubleHead: true }) },
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
      if (tool === "line" || tool === "arrow" || tool === "darrow" || tool === "rect" || tool === "ellipse") setHover(logicalPointer(e));
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
      endPan();
      return;
    }
    settleGesture();
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
      if (e.evt.touches.length < 2) pinchRef.current = null;
      return;
    }
    onStageUp();
  };

  const onStageDblClick = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (croppingId || tool !== "select") return;
    const hit = smallestAt(logicalPointer(e));
    if (!hit) return;
    // Double-click: text → edit text; image → crop; any other shape → bound label.
    if (hit.type === "text") onEditText(hit.id);
    else if (hit.type === "image") onCropImage(hit.id);
    else onEditLabel(hit.id);
  };

  // The parent's LIVE box mid-transform, WITHOUT disturbing its node (the
  // Transformer owns scale/position during the drag). rect/ellipse/image only —
  // reading the group/shape's stored size × the live scale.
  const liveBox = (e: KonvaEventObject<Event>, sh: Shape) => {
    if (sh.type !== "rect" && sh.type !== "ellipse" && sh.type !== "image") return null;
    const node = e.target;
    return { x: node.x(), y: node.y(), width: Math.max(4, sh.width * node.scaleX()), height: Math.max(4, sh.height * node.scaleY()) };
  };

  // Bake the Transformer's scale into concrete geometry (on release).
  const bakeTransform = (e: KonvaEventObject<Event>, sh: Shape) => {
    const node = e.target;
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    if (sh.type === "text") {
      dispatch({ type: "commitResize", id: sh.id, patch: { x: node.x(), y: node.y(), fontSize: Math.max(8, sh.fontSize * sy) }, distScale: sPx(1) });
    } else if (sh.type === "rect" || sh.type === "ellipse" || sh.type === "image") {
      dispatch({
        type: "commitResize",
        id: sh.id,
        patch: { x: node.x(), y: node.y(), width: Math.max(4, sh.width * sx), height: Math.max(4, sh.height * sy) },
        distScale: sPx(1), // anchor keep-or-drop judged at the SCREEN's glue range
      });
    }
  };

  // Per-shape props: identity (for the Transformer + hit mapping) and resize
  // baking. Selection, move, and double-click are all handled at the stage level
  // (size-based), so shapes are not individually draggable.
  const common = (sh: Shape) => ({
    id: sh.id,
    // Keep the stroke a constant width when the Transformer scales a shape —
    // otherwise resizing thickens the outline (Konva scales strokes by default).
    strokeScaleEnabled: false,
    onTransformStart: () => dispatch({ type: "beginGesture" }),
    // Live: reflow attached/bound shapes against the ghost box so they follow
    // DURING the drag — but leave the parent's own node untouched (touching it
    // mid-transform makes the Transformer resize from both sides).
    onTransform: (e: KonvaEventObject<Event>) => {
      const box = liveBox(e, sh);
      if (box) dispatch({ type: "reflowChildrenTo", parentId: sh.id, box, distScale: sPx(1) });
    },
    onTransformEnd: (e: KonvaEventObject<Event>) => {
      bakeTransform(e, sh);
      dispatch({ type: "endGesture" });
    },
  });

  // Highlight the shape a to-be-drawn/moved thing would bind or attach to — while
  // drawing (line endpoints, or a box's own attach), and while just hovering with
  // any binding tool in hand. All glue distances are zoom-scaled (screen-true).
  const bindHighlights = new Set<string>();
  const draft = state.draftId ? shapes.find((s) => s.id === state.draftId) : null;
  if (draft && (draft.type === "line" || draft.type === "arrow")) {
    const rest = shapes.filter((s) => s.id !== draft.id);
    for (const end of [
      { x: draft.points[0], y: draft.points[1] },
      { x: draft.points[2], y: draft.points[3] },
    ]) {
      const id = nearestBindableId(end, rest, draft.id, BIND_DISTANCE * sPx(1));
      if (id) bindHighlights.add(id);
    }
  } else if (draft && (draft.type === "rect" || draft.type === "ellipse")) {
    const at = attachAt(draft, shapes, sPx(1));
    if (at) bindHighlights.add(at.id);
  } else if (draft && draft.type === "pen") {
    // A scribble drawn along a shape's edge attaches on release — preview it too.
    const at = attachAt(draft, shapes.filter((s) => s.id !== draft.id), sPx(1));
    if (at) bindHighlights.add(at.id);
  } else if (!state.draftId && hover) {
    // Pre-draw hover preview. A box tool (rect/ellipse) binds only edge-to-edge, so
    // it glows a shape ONLY near its border — hovering the deep interior is mere
    // containment, no bind. A line/arrow endpoint DOES bind anywhere inside a shape,
    // so it keeps the bbox-interior test.
    const id =
      tool === "rect" || tool === "ellipse"
        ? nearestEdgeBindableId(hover, shapes, "", EDGE_TOUCH * sPx(1))
        : tool === "line" || tool === "arrow" || tool === "darrow"
          ? nearestBindableId(hover, shapes, "", BIND_DISTANCE * sPx(1))
          : undefined;
    if (id) bindHighlights.add(id);
  }
  // While dragging shape(s), highlight the shape they'd attach to on drop. Skip a
  // cluster member whose `attach` points INTRA-cluster — reattach keeps that edge
  // verbatim (the parent rode along), so there's nothing new to attach to.
  if (moveRef.current) {
    const moving = new Set(moveRef.current.ids);
    for (const id of moveRef.current.ids) {
      const sh = shapes.find((s) => s.id === id);
      if (!sh || (sh.attach && moving.has(sh.attach.id))) continue;
      const at = attachAt(sh, shapes.filter((o) => !moving.has(o.id)), sPx(1));
      if (at) bindHighlights.add(at.id);
    }
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
  const infiniteBg = policy === "infinite" ? (() => {
    const vis = padBox(visible, sPx(8));
    const content = contentBounds(shapes);
    return content ? unionBox(vis, padBox(content, 40)) : vis;
  })() : null;

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
      onDblClick={onStageDblClick}
      onContextMenu={(e) => e.evt.preventDefault()}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onDblTap={onStageDblClick}
      style={{ cursor, touchAction: "none" }}
    >
      <Layer>
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
            Konva/hit-testing use ids, not child order, so this is purely visual. */}
        {paintOrder(shapes).map((sh) => {
          if (sh.id === editingId && sh.type === "text") return null; // hidden under the textarea
          // Adaptive ink resolves to a solid color contrasting the background
          // under the shape; other scribbles never affect it.
          const stroke = inkFor(sh);
          const sw = sh.strokeWidth;
          switch (sh.type) {
            case "rect": {
              const b = viewBox(sh);
              return <Rect key={sh.id} {...common(sh)} {...b} stroke={stroke} strokeWidth={sw} />;
            }
            case "ellipse": {
              const b = viewBox(sh);
              return (
                <Group key={sh.id} {...common(sh)} x={b.x} y={b.y}>
                  <Ellipse x={b.width / 2} y={b.height / 2} radiusX={b.width / 2} radiusY={b.height / 2} stroke={stroke} strokeWidth={sw} strokeScaleEnabled={false} />
                </Group>
              );
            }
            case "line":
              return <Line key={sh.id} {...common(sh)} points={sh.points} stroke={stroke} strokeWidth={sw} lineCap="round" hitStrokeWidth={Math.max(sPx(12), sw)} />;
            case "arrow":
              return (
                <Arrow
                  key={sh.id}
                  {...common(sh)}
                  points={sh.points}
                  stroke={stroke}
                  fill={stroke}
                  strokeWidth={sw}
                  pointerLength={8 + sw}
                  pointerWidth={8 + sw}
                  pointerAtBeginning={sh.doubleHead}
                  hitStrokeWidth={Math.max(sPx(12), sw)}
                />
              );
            case "pen":
              return (
                <Line
                  key={sh.id}
                  {...common(sh)}
                  points={sh.points}
                  stroke={stroke}
                  strokeWidth={sw}
                  lineCap="round"
                  lineJoin="round"
                  tension={0.4}
                  hitStrokeWidth={Math.max(sPx(12), sw)}
                />
              );
            case "text":
              return <Text key={sh.id} {...common(sh)} x={sh.x} y={sh.y} text={sh.text} fontSize={sh.fontSize} fill={stroke} />;
            case "image": {
              const img = imgEls[sh.id];
              if (!img || sh.id === croppingId) return null; // decoding, or the crop overlay renders it
              return <KonvaImage key={sh.id} {...common(sh)} image={img} x={sh.x} y={sh.y} width={sh.width} height={sh.height} crop={sh.crop} />;
            }
          }
        })}

        {/* Bound labels. On a STROKE shape (line/arrow/pen) the label used to be tiny
            same-colored text sitting on the stroke — unreadable. So stroke labels get a
            readable chip: an opaque rounded tag at the stroke midpoint with the text in
            its OWN hue (bright for adaptive ink), independent of the background it floats
            over. Area shapes keep the plain centered label (legible on the unfilled
            interior). */}
        {shapes.map((sh) => {
          if (!sh.label || sh.id === editingLabelId) return null;
          const b = boundingBox(sh);
          if (sh.type === "line" || sh.type === "arrow" || sh.type === "pen") {
            const mid =
              sh.type === "pen"
                ? { x: b.x + b.width / 2, y: b.y + b.height / 2 }
                : { x: (sh.points[0] + sh.points[2]) / 2, y: (sh.points[1] + sh.points[3]) / 2 };
            const fs = 15;
            const pad = 5;
            const ink = isContrastInk(sh.stroke) ? "#f5f5f5" : sh.stroke;
            // Approx chip size to center it on the midpoint (Konva Label anchors top-left).
            const w = Math.max(8, sh.label.length * fs * 0.58) + pad * 2;
            const h = fs * 1.16 + pad * 2;
            return (
              <Label key={`label-${sh.id}`} x={mid.x} y={mid.y} offsetX={w / 2} offsetY={h / 2} listening={false}>
                <Tag
                  fill="rgba(20,20,24,0.85)"
                  cornerRadius={5}
                  stroke="rgba(245,245,245,0.16)"
                  strokeWidth={1}
                  shadowColor="#000000"
                  shadowBlur={5}
                  shadowOpacity={0.45}
                />
                <Text text={sh.label} fontSize={fs} fontStyle="500" fill={ink} padding={pad} align="center" />
              </Label>
            );
          }
          const fs = labelFont(b);
          return (
            <Text
              key={`label-${sh.id}`}
              x={b.x}
              y={b.y + b.height / 2 - fs * 0.6}
              width={b.width}
              text={sh.label}
              fontSize={fs}
              fill={inkFor(sh)}
              align="center"
              listening={false}
            />
          );
        })}

        {/* Bind highlight — glows a shape while a line/arrow endpoint hovers it.
            Chrome is drawn at constant SCREEN size (offsets/strokes ÷ zoom). */}
        {shapes
          .filter((sh) => bindHighlights.has(sh.id))
          .map((sh) => {
            const b = boundingBox(sh);
            return (
              <Rect
                key={`bind-${sh.id}`}
                x={b.x - sPx(4)}
                y={b.y - sPx(4)}
                width={b.width + sPx(8)}
                height={b.height + sPx(8)}
                stroke="#8b5cf6"
                strokeWidth={sPx(2)}
                cornerRadius={sPx(4)}
                shadowColor="#8b5cf6"
                shadowBlur={sPx(10)}
                shadowOpacity={0.7}
                listening={false}
              />
            );
          })}

        {/* Selection outlines for anything the Transformer isn't already framing. */}
        {!soleResizable &&
          shapes
            .filter((sh) => selected.has(sh.id))
            .map((sh) => {
              const b = boundingBox(sh);
              return (
                <Rect
                  key={`sel-${sh.id}`}
                  x={b.x - sPx(3)}
                  y={b.y - sPx(3)}
                  width={b.width + sPx(6)}
                  height={b.height + sPx(6)}
                  stroke={SELECT_COLOR}
                  strokeWidth={sPx(1)}
                  dash={[sPx(4), sPx(4)]}
                  listening={false}
                />
              );
            })}

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

        <Transformer
          ref={trRef}
          rotateEnabled={false}
          borderStroke={SELECT_COLOR}
          anchorStroke={SELECT_COLOR}
          anchorSize={8}
          ignoreStroke
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

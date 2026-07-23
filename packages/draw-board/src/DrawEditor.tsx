import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ClipboardEvent as ReactClipboardEvent } from "react";
import { flushSync } from "react-dom";
import { Frame, Maximize2, Minimize2, Minus, Plus } from "lucide-react";
import type Konva from "konva";
import { DrawToolbar } from "./DrawToolbar.tsx";
import { DrawCanvas } from "./DrawCanvas.tsx";
import { Minimap } from "./Minimap.tsx";
import type { CropControl } from "./CropLayer.tsx";
import { useDrawing, newShapeId } from "./useDrawing.ts";
import {
  boundingBox,
  canRedo,
  canUndo,
  cloneShape,
  clonePastedShapes,
  contentBounds,
  fontForStroke,
  groupActionFor,
  growthOrigin,
  isSelectable,
  migrateLabels,
  normalizeGroups,
  scaleStepTarget,
  selectionFills,
  selectionStrokes,
  slotTargetStep,
  stepStroke,
  strokeForFont,
  resolveFeatures,
  toDoc,
  toSession,
  unitBoundsOf,
  unitSizeStep,
  rootUnitKeyOf,
  STROKE_WIDTHS,
  STROKE_STYLES,
  CANVAS_BG_DARK,
  CONTRAST_INK,
  isNoStroke,
  contrastSolidOver,
  fillAt,
  paintOrder,
  type DrawDoc,
  type DrawFeatures,
  type DrawSession,
  type ImageShape,
  type Shape,
  type TextShape,
} from "./drawModel.ts";
import { textBlockSize, wrapLines } from "./textMetrics.ts";
import { BOARD_FONT_STACK, useBoardFont } from "./boardFont.ts";
import { exportStagePng, sketchFileName } from "./exportPng.ts";
import { exportBoardPng, exportBoardSvg, parseBoardFile, parseBoardPayload } from "./boardFile.ts";
import {
  clampBounded,
  clampScale,
  fitView,
  padBox,
  screenToLogical,
  visibleLogicalRect,
  zoomAt,
  type Size,
  type Viewport,
  type ViewportPolicy,
} from "./viewport.ts";

/** The bounded/fixed policies never blow a small doc up past this as their FIT
 *  (the legacy display cap) — deliberate zooming can still go to MAX_SCALE. */
const FIT_CAP = 6;

/** Marker key of the system-clipboard shapes envelope (see `copy`). */
const SHAPES_ENVELOPE = "application/x-draw-board-shapes";

/** Raster bytes for an image placed on the board (paste/drop/pick). */
export interface BoardImageData {
  dataBase64: string;
  mediaType: string;
}

/** Default file→raster reader: plain FileReader, no size policy. A host with
 *  attachment rules (size caps, mime allowlists) injects its own reader via
 *  `imageToData` and REJECTS to surface the refusal through `onNotify`. */
/** The width the size dots display and step FROM: the selection's own width
 *  when it has one (an element remembers its size — selecting a secret-size
 *  element surfaces the extended controls), else the drawing default. */
function strokeBase(s: { shapes: Shape[]; selectedIds: string[]; strokeWidth: number }): number {
  if (!s.selectedIds.length) return s.strokeWidth;
  const sel = new Set(s.selectedIds);
  const widths = new Set<number>();
  for (const sh of s.shapes) if (sel.has(sh.id)) widths.add(sh.type === "text" ? strokeForFont(sh.fontSize) : sh.strokeWidth);
  return widths.size === 1 ? [...widths][0] : s.strokeWidth;
}

/** The stroke pill's declaration: the selection's own colors when it has any
 *  (multi while mixed — the editable color declaration), else the ambient pen
 *  ink. Image-only selections have no painted stroke → ambient too. */
function colorsBase(s: { shapes: Shape[]; selectedIds: string[]; color: string }): readonly string[] {
  const strokes = selectionStrokes(s.shapes, s.selectedIds);
  return strokes.length ? strokes : [s.color];
}

/** Fill counterpart of {@link colorsBase} (null = none); selections with no
 *  fillable member fall back to the ambient pref. */
function fillsBase(s: { shapes: Shape[]; selectedIds: string[]; fill: string | null }): readonly (string | null)[] {
  const fills = selectionFills(s.shapes, s.selectedIds);
  return fills.length ? fills : [s.fill];
}

function defaultImageToData(file: File): Promise<BoardImageData> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.onload = () => {
      const url = String(r.result ?? "");
      const comma = url.indexOf(",");
      if (comma < 0) return reject(new Error(`could not read ${file.name}`));
      resolve({ dataBase64: url.slice(comma + 1), mediaType: file.type || "image/png" });
    };
    r.readAsDataURL(file);
  });
}

/** Imperative surface for host-level export UI (the standalone app's toolbar
 *  buttons). Everything here is OPT-IN — hosts that never take the ref (the
 *  Operator dock) get the unchanged attachment flow. */
export interface BoardHandle {
  /** Flatten to PNG; `rich` (default true) embeds the doc for re-import. */
  exportPng(opts?: { rich?: boolean }): Promise<File | null>;
  /** Serialize to SVG; `rich` (default true) embeds the doc. */
  exportSvg(opts?: { rich?: boolean }): File;
  /** The live doc snapshot. */
  getDoc(): DrawDoc;
}

/** Area shapes a text edit wraps INSIDE (its "page"). Deliberately narrower
 *  than the model's attach targets: another text is never a wrap boundary. */
const WRAP_CONTAINERS = new Set(["rect", "ellipse", "image"]);
/** Breathing room between wrapped text and its container's right edge. */
const TEXT_BOX_INSET = 6;
/** Below this cap the sliver is no useful column — let the text overflow
 *  instead of wrapping into a 2-char ribbon ("try its best", not "at any cost"). */
const MIN_TEXT_WRAP = 30;

/** An in-progress text edit. `kind` selects the target: a NEW standalone text
 *  (nothing exists in the model until commit — so a stray mouse-up can't tear it
 *  down) or an EXISTING text shape. Geometry lives here so the textarea never
 *  depends on a model shape existing. */
interface EditSession {
  kind: "new-text" | "edit-text";
  id: string | null;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  /** Wrap cap (model units): the text's own box width, else the room left to
   *  its containing shape's right edge — the field wraps there instead of
   *  growing out of the parent, and a commit that actually wrapped stamps the
   *  cap as the shape's box width. Absent = uncapped (free text). */
  maxWidth?: number;
  /** Bond-pinned growth (see {@link growthOrigin}): the fraction of the field's
   *  box that stays put as it grows, and the pinned point (model coords) it
   *  grows away from — so editing a text glued above a shape extends the field
   *  UPWARD live, exactly like the commit will. 0/0 + the top-left = the free
   *  default. */
  gx: number;
  gy: number;
  anchorX: number;
  anchorY: number;
  /** Background highlight (the shape's `fill`, or the ambient fill for a new
   *  text) — the field paints it live so the edit is WYSIWYG, and the adaptive
   *  ink resolves its glyph color against it. Null = none. */
  fill: string | null;
}

/**
 * The drawing editor body: toolbar + pan/zoom Konva canvas + inline text
 * overlay + a Cancel / "Add to message" footer. Owns theme-aware defaults, the
 * CAMERA (pan/zoom per its viewport policy), text editing, clipboard +
 * image/text paste + drop, and PNG export; every geometry/history concern is
 * delegated to the pure reducer.
 */
export function DrawEditor({
  doc,
  bgImage,
  name,
  onCancel,
  onSave,
  onChange,
  // Aliased: `session` is the text-EDIT session inside this component.
  session: initialSession,
  onSessionChange,
  features: featuresProp,
  defaultColor = CONTRAST_INK,
  expanded,
  onToggleExpand,
  viewport,
  autoFocus = true,
  minimap = false,
  onNotify,
  imageToData,
  boardRef,
  toolbarExtra,
  onImportBoard,
}: {
  doc: DrawDoc;
  bgImage: HTMLImageElement | null;
  name: string;
  /** Discard the drawing (close the editor). Omit to hide the button — a host
   *  that persists continuously has nothing to discard. */
  onCancel?: () => void;
  /** Flatten + export a PNG (the attachment flow). Omit to hide the button —
   *  `onChange` alone serves document-style hosts. */
  onSave?: (png: File, doc: DrawDoc) => void;
  /** Live doc changes (debounced) — the host persists them so a sketch survives
   *  closing the board and page reloads. Also flushed once on unmount. */
  onChange?: (doc: DrawDoc) => void;
  /** Persisted toolbar + selection state (see {@link DrawSession}), applied
   *  ONCE at mount over the defaults — later prop changes are ignored. Pair
   *  with `onSessionChange` so the whole toolbar survives reloads. */
  session?: DrawSession | null;
  /** Live session changes (debounced + unmount flush) — the toolbar/selection
   *  counterpart of `onChange`; the host stores it NEXT TO the doc, never
   *  inside it (exports must not carry UI state). */
  onSessionChange?: (s: DrawSession) => void;
  /** Board capability config (see {@link DrawFeatures}): palette width 1..12
   *  (1 = single-color, no color UI at all) and opt-outs for fills, stroke
   *  styling, grouping. Frozen at mount like `session` — key the editor to
   *  change it. Omit for the full default board. */
  features?: Partial<DrawFeatures> | null;
  /** The initial/armed ink (and, at `paletteSize` 1, THE single drawing
   *  color). Defaults to the adaptive contrast ink. */
  defaultColor?: string;
  /** True when hosted as the full-screen modal (vs the inline dock). Drives the
   *  expand/collapse toggle glyph; absent `onToggleExpand` hides the toggle. */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** Camera policy override for component users. Default: a blank sketch is an
   *  INFINITE board (unbounded pan/zoom); an image annotation is BOUNDED (zoom
   *  into the image, pan clamped to it). "fixed" restores the legacy
   *  fit-to-container behavior with no camera gestures at all. */
  viewport?: ViewportPolicy;
  /** Claim keyboard focus on mount (default true — the board is usually opened
   *  to be drawn on immediately). Pass false when the host directs the first
   *  keystrokes elsewhere (e.g. naming a freshly created page); the board still
   *  claims focus on any pointer-down inside it. */
  autoFocus?: boolean;
  /** Show the schematic overview map (bottom-right; click/drag moves the
   *  camera). Off by default; ignored under the "fixed" policy (no camera to
   *  navigate). */
  minimap?: boolean;
  /** User-facing error channel (failed export, rejected image). Defaults to
   *  console.warn — inject the host's toast for real surfacing. */
  onNotify?: (message: string) => void;
  /** File→raster reader for placed images; the injection point for a host's
   *  attachment policy (size caps, mime allowlists). Defaults to a plain
   *  FileReader with no policy. */
  imageToData?: (file: File) => Promise<BoardImageData>;
  /** Imperative export surface (see {@link BoardHandle}). */
  boardRef?: React.Ref<BoardHandle>;
  /** Host controls rendered at the far right of the toolbar's action cluster. */
  toolbarExtra?: React.ReactNode;
  /** When set, pasted/dropped image files are probed for an embedded board doc
   *  (rich PNG/SVG) FIRST — a board file always imports as a board, never as a
   *  placed image, wherever it lands. Absent (Operator): no probing at all. */
  onImportBoard?: (doc: DrawDoc) => void;
}) {
  // Operator is dark-only. The primary ink is adaptive (CONTRAST_INK) — the
  // canvas resolves it to a bright/dark solid contrasting the BACKGROUND
  // sampled under each shape (paper, images, and fills — never strokes).
  const bgColor = bgImage ? "transparent" : CANVAS_BG_DARK;

  // Resolved ONCE at mount (like the session): a mixed live/frozen read of the
  // config would let render gating and reducer gating disagree mid-flight.
  const [features] = useState(() => resolveFeatures(featuresProp));
  const { state, dispatch } = useDrawing(doc, defaultColor, initialSession, features);
  // The stage may not mount before the board face is registered: a Konva
  // context that measures text pre-registration keeps a stale font binding,
  // and committed text would forever disagree with the edit textarea.
  const fontReady = useBoardFont();
  const stageRef = useRef<Konva.Stage>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const clipboard = useRef<Shape[]>([]);
  // Mirrors the canvas's camera-gesture bitmap-cache state — gates ⌘G (see the
  // keydown handler). NOTE: this blocks ⌘G during ANY live camera gesture, a
  // deliberately conservative superset of "cache is live" (momentary, invisible).
  const camBusyRef = useRef(false);

  // Host injection points, read through refs so callbacks stay stable.
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;
  const notify = useCallback((message: string) => {
    (notifyRef.current ?? ((m: string) => console.warn(`draw-board: ${m}`)))(message);
  }, []);
  const imageToDataRef = useRef(imageToData);
  imageToDataRef.current = imageToData;
  const onImportBoardRef = useRef(onImportBoard);
  onImportBoardRef.current = onImportBoard;

  // ── Focus ownership ─────────────────────────────────────────────────────────
  // The board is a focusable surface: key/paste handlers live on `rootRef` (not
  // window), so they only fire while it holds focus. Any pointer-down inside claims
  // focus (the Konva canvas isn't focusable on its own); opening the editor claims it
  // too, so the first paste/keystroke lands on the board the user just opened.
  const rootRef = useRef<HTMLDivElement>(null);
  const claimFocus = useCallback(() => {
    const el = rootRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (autoFocus) rootRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist the live doc (debounced + unmount flush) ────────────────────────
  // The host stores this per stream so a sketch survives closing the board + page
  // reloads. Debounced (a draw gesture fires many state changes), PLUS one flush
  // on unmount — a pencil-close inside the debounce window must not drop the last
  // stroke. A discard flows through this flush too; the host drops it (its
  // discarded/stream guards), which is why the flush is safe here.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!onChange) return;
    const id = setTimeout(() => onChange(toDoc(stateRef.current)), 400);
    return () => clearTimeout(id);
  }, [state.shapes, state.background, state.width, state.height, onChange]);

  // ── Persist the live SESSION the same way (toolbar + selection) ─────────────
  // Everything the toolbar holds — tool/variants, paints, retuned shades +
  // specials, width/style — plus the selection; stored next to the doc so a
  // reload restores the board exactly as it was left (see DrawSession).
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;
  useEffect(() => {
    if (!onSessionChange) return;
    const id = setTimeout(() => onSessionChange(toSession(stateRef.current)), 400);
    return () => clearTimeout(id);
  }, [
    state.tool,
    state.baseTool,
    state.shapeVariant,
    state.lineVariant,
    state.color,
    state.fill,
    state.strokeShades,
    state.fillShades,
    state.strokeSpecial,
    state.fillSpecial,
    state.strokeWidth,
    state.strokeStyle,
    state.selectedIds,
    onSessionChange,
  ]);

  // One unmount flush for both — a close inside the debounce window must not
  // drop the last stroke, nor the last toolbar/selection change.
  useEffect(() => {
    return () => {
      onChangeRef.current?.(toDoc(stateRef.current));
      onSessionChangeRef.current?.(toSession(stateRef.current));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Paste target: the cursor's spot on the plane ────────────────────────────
  // The area div tracks the pointer (ref only — no re-renders); a paste centers
  // its content there, falling back to the view center when the pointer is
  // elsewhere (menu paste, keyboard paste right after switching windows).
  const pointerPosRef = useRef<{ clientX: number; clientY: number } | null>(null);

  // ── Camera (pan/zoom viewport over the logical plane) ───────────────────────
  const policy: ViewportPolicy = viewport ?? (bgImage ? "bounded" : "infinite");
  const areaRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<Size | null>(null);
  const availRef = useRef(avail);
  availRef.current = avail;
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setAvail({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // FIXED policy only: the blank board tracks its container (fills, resizes from
  // the center) exactly as before the camera existed. The gesture policies keep
  // the doc box as-is — the camera moves instead.
  useEffect(() => {
    if (policy !== "fixed" || bgImage || !avail) return;
    dispatch({ type: "resizeCanvasCentered", width: Math.round(avail.w), height: Math.round(avail.h) });
  }, [avail, bgImage, dispatch, policy]);

  // The camera. Gesture policies hold it as state (initialized once the container
  // is measured); the fixed policy derives it fresh every render (always the fit).
  const [camera, setCamera] = useState<Viewport | null>(null);
  const docBox = { x: 0, y: 0, width: state.width, height: state.height };
  const clampCamera = useCallback(
    (v: Viewport): Viewport => {
      const a = availRef.current;
      const d = stateRef.current;
      if (policy === "bounded" && a) return clampBounded(v, { x: 0, y: 0, width: d.width, height: d.height }, a, FIT_CAP);
      const s = clampScale(v.scale);
      return s === v.scale ? v : { ...v, scale: s };
    },
    [policy]
  );
  useEffect(() => {
    if (!avail || camera || policy === "fixed") return;
    if (policy === "bounded") {
      setCamera(fitView(docBox, avail, { maxScale: FIT_CAP }));
      return;
    }
    // Infinite board: open on the existing content (a reopened sketch), else at
    // 1:1 with the logical origin at the top-left — the blank-board look.
    const content = contentBounds(state.shapes);
    setCamera(content ? fitView(padBox(content, 60), avail, { maxScale: 1 }) : { x: 0, y: 0, scale: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avail, camera, policy]);
  // A container resize re-clamps a bounded camera (the fit floor moved).
  useEffect(() => {
    if (policy !== "bounded" || !avail) return;
    setCamera((c) => (c ? clampBounded(c, { x: 0, y: 0, width: state.width, height: state.height }, avail, FIT_CAP) : c));
  }, [avail, policy, state.width, state.height]);

  const view: Viewport | null = policy === "fixed" ? (avail ? fitView(docBox, avail, { maxScale: FIT_CAP }) : null) : camera;
  const viewRef = useRef(view);
  viewRef.current = view;

  /** Functional camera update (rapid wheel/pinch events never compound off a
   *  stale value), clamped per the policy. */
  const onViewChange = useCallback(
    (up: (v: Viewport) => Viewport) => {
      if (policy === "fixed") return;
      setCamera((c) => (c ? clampCamera(up(c)) : c));
    },
    [policy, clampCamera]
  );

  // ── Space-held panning ───────────────────────────────────────────────────────
  const [spaceHeld, setSpaceHeld] = useState(false);
  const onSpaceKey = useCallback(
    (e: ReactKeyboardEvent, down: boolean) => {
      if (policy === "fixed" || e.key !== " ") return false;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return false;
      e.preventDefault();
      setSpaceHeld(down);
      return true;
    },
    [policy]
  );

  // ── Zoom controls ────────────────────────────────────────────────────────────
  const viewCenterScreen = (): { x: number; y: number } => {
    const a = availRef.current;
    return a ? { x: a.w / 2, y: a.h / 2 } : { x: 0, y: 0 };
  };
  const zoomStep = useCallback(
    (dir: 1 | -1) => onViewChange((v) => zoomAt(v, viewCenterScreen(), dir > 0 ? 1.25 : 0.8)),
    [onViewChange]
  );
  const resetZoom = useCallback(() => onViewChange((v) => zoomAt(v, viewCenterScreen(), 1 / v.scale)), [onViewChange]);
  const fitContent = useCallback(() => {
    const a = availRef.current;
    if (!a || policy === "fixed") return;
    const d = stateRef.current;
    if (policy === "bounded") {
      setCamera(fitView({ x: 0, y: 0, width: d.width, height: d.height }, a, { maxScale: FIT_CAP }));
      return;
    }
    const content = contentBounds(d.shapes);
    setCamera(content ? fitView(padBox(content, 60), a, { maxScale: 1 }) : { x: 0, y: 0, scale: 1 });
  }, [policy]);

  // ── Text editing (model-independent, focus-race safe) ──────────────────────
  const [session, setSession] = useState<EditSession | null>(null);
  const [value, setValue] = useState("");
  // Refs mirror the latest session/value so `commitEdit` can be a PURE callback
  // (no dispatch inside a setState updater — that double-fires under StrictMode
  // and duplicated the text) and can guard against a same-tick double-commit
  // (Enter + the unmount blur both call it).
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const valueRef = useRef(value);
  valueRef.current = value;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const ready = useRef(false);
  const [wantSave, setWantSave] = useState(false);
  // Image crop mode (Google-Slides style) — which image is being cropped, or null.
  const [croppingId, setCroppingId] = useState<string | null>(null);
  // Live apply/cancel of the open crop (populated by CropLayer). Keys drive it
  // from the board's FOCUSED root below — never from window or an app-level
  // hotkey manager, so the board stays a standalone component and crop keys go
  // inert the moment focus leaves it (composer Enter stays the composer's).
  const cropControlRef = useRef<CropControl | null>(null);

  /** Wrap cap for a text anchored at (x, y): the room to the INNERMOST
   *  containing shape's right edge (minus a small inset). Undefined when
   *  nothing contains the point or the sliver left is too narrow to be a
   *  useful column ("try its best" — overflow beats a 2-char ribbon). */
  const containKap = useCallback((x: number, y: number): number | undefined => {
    let cap: number | undefined;
    let area = Infinity;
    for (const sh of stateRef.current.shapes) {
      if (!WRAP_CONTAINERS.has(sh.type)) continue;
      const b = boundingBox(sh);
      if (x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height) continue;
      if (b.width * b.height >= area) continue;
      area = b.width * b.height;
      cap = b.x + b.width - x - TEXT_BOX_INSET;
    }
    return cap !== undefined && cap >= MIN_TEXT_WRAP ? cap : undefined;
  }, []);

  const startText = useCallback(
    (x: number, y: number) => {
      const s = stateRef.current;
      setValue("");
      setSession({ kind: "new-text", id: null, x, y, fontSize: fontForStroke(s.strokeWidth), color: s.color, fill: s.fill, maxWidth: containKap(x, y), gx: 0, gy: 0, anchorX: x, anchorY: y });
    },
    [containKap]
  );
  const startEditText = useCallback(
    (id: string) => {
      const sh = stateRef.current.shapes.find((s) => s.id === id) as TextShape | undefined;
      if (!sh || sh.type !== "text") return;
      setValue(sh.text);
      // Bond-pinned growth: the field extends away from the shape's glued edge
      // (a text bound above its parent grows UP), mirroring what the commit's
      // retypeset will do to the model.
      const { gx, gy } = growthOrigin(sh.attach);
      const b = textBlockSize(sh.text, sh.fontSize, sh.width);
      // The shape's own box wins; an unboxed text inside a container caps at it.
      setSession({
        kind: "edit-text",
        id,
        x: sh.x,
        y: sh.y,
        fontSize: sh.fontSize,
        color: sh.stroke,
        fill: sh.fill ?? null,
        maxWidth: sh.width ?? containKap(sh.x, sh.y),
        gx,
        gy,
        anchorX: sh.x + gx * b.width,
        anchorY: sh.y + gy * b.height,
      });
    },
    [containKap]
  );
  const commitEdit = useCallback(() => {
    const cur = sessionRef.current;
    if (!cur) return;
    sessionRef.current = null; // claim it synchronously → a same-tick second call no-ops
    const text = valueRef.current.trim();
    // Stamp the wrap cap as the shape's BOX only when the text actually wrapped
    // at it — a short line inside a parent stays a slim, unboxed text.
    const wrapped = cur.maxWidth !== undefined && wrapLines(text, cur.fontSize, cur.maxWidth).length > text.split("\n").length;
    const width = wrapped ? cur.maxWidth : undefined;
    if (cur.kind === "new-text") {
      if (text) {
        dispatch({
          type: "addShapes",
          detectAttach: true, // a placed text glues to a shape it's dropped against
          distScale: distScale(), // screen-true glue range, same as every other placement
          shapes: [{ id: newShapeId(), type: "text", stroke: cur.color, strokeWidth: stateRef.current.strokeWidth, x: cur.x, y: cur.y, text, fontSize: cur.fontSize, ...(width !== undefined && { width }), ...(cur.fill && { fill: cur.fill }) }],
        });
        // Text is one-use → snap back to the last selectable tool.
        dispatch({ type: "setTool", tool: stateRef.current.baseTool });
      }
    } else if (cur.kind === "edit-text" && cur.id) {
      if (text) dispatch({ type: "setText", id: cur.id, text, width, distScale: distScale() });
      else if (stateRef.current.shapes.find((sh) => sh.id === cur.id)?.groupPath) {
        // A GROUPED text cleared empty must NOT route through deleteShapes — that
        // expands to the whole unit and would nuke the group from a deliberate
        // member-edit context. Keep the (empty) member; ungroup to prune.
        dispatch({ type: "setText", id: cur.id, text: "" });
      } else dispatch({ type: "deleteShapes", ids: [cur.id] });
    }
    setSession(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);
  const cancelEdit = useCallback(() => {
    sessionRef.current = null;
    setSession(null);
  }, []);

  // ── Image crop (Google-Slides style) ────────────────────────────────────────
  const onCropImage = useCallback(
    (id: string) => {
      dispatch({ type: "select", ids: [] });
      setCroppingId(id);
    },
    [dispatch]
  );
  const onCropApply = useCallback(
    (id: string, box: { x: number; y: number; width: number; height: number }, crop?: { x: number; y: number; width: number; height: number }) => {
      // Crop is a resize in disguise — its anchor keep-or-drop must use the same
      // screen-true glue range (a zoom-glued image must survive being cropped).
      dispatch({ type: "cropImage", id, box, crop, distScale: 1 / (viewRef.current?.scale ?? 1) });
      setCroppingId(null);
    },
    [dispatch]
  );
  const onCropCancel = useCallback(() => setCroppingId(null), []);

  // Focus the textarea synchronously as it mounts (before paint) so keystrokes
  // land immediately, then ignore the mount-time blur that Radix's focus scope
  // fires (refocus instead of committing) until `ready`. Keyed on the session
  // identity so it doesn't re-fire per keystroke.
  useLayoutEffect(() => {
    if (!session) {
      ready.current = false;
      return;
    }
    ready.current = false;
    taRef.current?.focus();
    taRef.current?.select();
    const raf = requestAnimationFrame(() => {
      taRef.current?.focus(); // reclaim focus if Radix's scope grabbed it on mount
      ready.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [session]);

  // WYSIWYG sizing: the field's box always equals its content's — a capped
  // field keeps the wrap width, a free field tracks its longest line; neither
  // ever scrolls or clips (the canvas text is hidden while editing, so the
  // field IS the shape). Browser-measured (scroll extents after a collapse) so
  // the box stays layout-true per keystroke, even where the browser's wrap
  // differs from the model's by a hair. GROWTH DIRECTION follows the bond
  // (session.gx/gy): the box is re-placed off its pinned anchor after every
  // measure, so a text glued above a shape grows UPWARD live — the free
  // default (anchor = top-left) reduces to plain left/top placement.
  useLayoutEffect(() => {
    const ta = taRef.current;
    const cur = sessionRef.current;
    if (!ta || !cur || !view) return;
    let w = (cur.maxWidth ?? 0) * view.scale;
    if (cur.maxWidth === undefined) {
      ta.style.width = "0px";
      w = ta.scrollWidth + 2; // + caret room at the line end
      ta.style.width = `${w}px`;
    }
    ta.style.height = "0px";
    const h = ta.scrollHeight;
    ta.style.height = `${h}px`;
    ta.style.left = `${cur.anchorX * view.scale + view.x - cur.gx * w}px`;
    ta.style.top = `${cur.anchorY * view.scale + view.y - cur.gy * h}px`;
  }, [value, session, view]);

  // ── Add an image / text (drop or paste from the system) ─────────────────────
  // Placement is CAMERA-relative: "the middle of the board" means the middle of
  // what the user is looking at, and sizing fits the visible window, not the
  // (possibly irrelevant) doc box.
  const visibleRect = useCallback(() => {
    const v = viewRef.current;
    const a = availRef.current;
    if (v && a) return visibleLogicalRect(v, a);
    const d = stateRef.current;
    return { x: 0, y: 0, width: d.width, height: d.height };
  }, []);
  const viewCenterLogical = useCallback(() => {
    const r = visibleRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, [visibleRect]);
  /** Zoom-honest attach detection scale for placed content (see the reducer). */
  const distScale = useCallback(() => 1 / (viewRef.current?.scale ?? 1), []);
  /** Where a paste lands: the cursor's LOGICAL spot while it's over the board,
   *  else the center of the current view. */
  const pastePoint = useCallback(() => {
    const ptr = pointerPosRef.current;
    const v = viewRef.current;
    const el = areaRef.current;
    if (ptr && v && el) {
      const r = el.getBoundingClientRect();
      if (ptr.clientX >= r.left && ptr.clientX <= r.right && ptr.clientY >= r.top && ptr.clientY <= r.bottom) {
        return screenToLogical(v, { x: ptr.clientX - r.left, y: ptr.clientY - r.top });
      }
    }
    return viewCenterLogical();
  }, [viewCenterLogical]);

  // ── Clipboard (internal drawn shapes) ───────────────────────────────────────
  const pasteShapes = useCallback(
    (shapesToPaste: Shape[]) => {
      // The batch lands CENTERED at the paste point — its whole bounding box (a
      // multi-selection pastes as one assembly around the cursor), not offset
      // from wherever the source shapes happened to live (which, on an infinite
      // board, can be far off-screen). Intra-batch attach/binds are remapped to
      // the new ids and kept; edges to shapes outside the batch drop; no attach
      // re-detection (it would weld every copy to whatever it lands on).
      const b = contentBounds(shapesToPaste);
      const pt = pastePoint();
      const dx = b ? pt.x - (b.x + b.width / 2) : 0;
      const dy = b ? pt.y - (b.y + b.height / 2) : 0;
      dispatch({ type: "addShapes", shapes: clonePastedShapes(shapesToPaste, dx, dy, newShapeId) });
      dispatch({ type: "setTool", tool: "select" });
    },
    [dispatch, pastePoint]
  );
  // When the last board copy happened — the paste handler's tie-breaker for the
  // async-clipboard race (see onPaste).
  const lastCopyAt = useRef(-Infinity);
  const copy = useCallback(() => {
    const sel = new Set(stateRef.current.selectedIds);
    const picked = stateRef.current.shapes.filter((s) => sel.has(s.id)).map(cloneShape);
    if (!picked.length) return;
    clipboard.current = picked;
    lastCopyAt.current = performance.now();
    // ALSO write an envelope to the SYSTEM clipboard. Without this, stale OS
    // clipboard content (any text/image copied earlier) intercepts the next ⌘V
    // ahead of the internal fallback — "copy-paste selection doesn't work".
    // The envelope also makes shape paste work across boards/tabs. Best-effort:
    // the internal ref still covers a denied clipboard permission.
    try {
      void navigator.clipboard?.writeText(JSON.stringify({ [SHAPES_ENVELOPE]: 1, shapes: picked })).catch(() => {});
    } catch {
      // Non-secure context / no clipboard API — the internal ref suffices.
    }
  }, []);
  const pasteInternal = useCallback(() => {
    if (!clipboard.current.length) return false;
    pasteShapes(clipboard.current);
    return true;
  }, [pasteShapes]);
  /** Parse a system-clipboard text as a shapes envelope; null if it's not one.
   *  Group data is normalized here (cross-board/cross-version paste is an import
   *  path) — the INTERNAL clipboard skips this safely because it's only ever
   *  seeded from live state, which is normalized at open. */
  const parseEnvelope = useCallback((text: string): Shape[] | null => {
    if (!text.includes(SHAPES_ENVELOPE)) return null;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const shapes = parsed?.[SHAPES_ENVELOPE] ? (parsed.shapes as Shape[] | undefined) : undefined;
      return Array.isArray(shapes) && shapes.length ? migrateLabels(normalizeGroups(shapes)) : null;
    } catch {
      return null;
    }
  }, []);


  const addImageFile = useCallback(
    async (file: File, cx: number, cy: number, detectAttach = false) => {
      if (!file.type.startsWith("image/")) return;
      const att = await (imageToDataRef.current ?? defaultImageToData)(file);
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("decode"));
        img.src = `data:${att.mediaType};base64,${att.dataBase64}`;
      });
      const r = visibleRect();
      const max = Math.min(r.width, r.height) * 0.7;
      const f = Math.min(1, max / img.naturalWidth, max / img.naturalHeight);
      const w = img.naturalWidth * f;
      const h = img.naturalHeight * f;
      // The bounded/fixed policies keep content inside the doc box's top-left
      // quadrant rule as before; the infinite plane has no edges to respect.
      const x = policy === "infinite" ? cx - w / 2 : Math.max(0, cx - w / 2);
      const y = policy === "infinite" ? cy - h / 2 : Math.max(0, cy - h / 2);
      const shape: ImageShape = {
        id: newShapeId(),
        type: "image",
        stroke: "#000000",
        strokeWidth: 1,
        x,
        y,
        width: w,
        height: h,
        dataBase64: att.dataBase64,
        mediaType: att.mediaType,
      };
      dispatch({ type: "addShapes", shapes: [shape], detectAttach, distScale: distScale() });
      dispatch({ type: "setTool", tool: "select" });
    },
    [dispatch, policy, visibleRect, distScale]
  );
  /** All paste/drop/pick call sites funnel here — a rejected file (over the size
   *  cap, undecodable) must surface, not vanish as an unhandled rejection. */
  const addImageSafe = useCallback(
    (file: File, cx: number, cy: number, detectAttach = false) =>
      addImageFile(file, cx, cy, detectAttach).catch((e) =>
        notify(`Couldn't add image: ${e instanceof Error ? e.message : e}`)
      ),
    [addImageFile, notify]
  );
  const addTextValue = useCallback(
    (text: string, x: number, y: number) => {
      const s = stateRef.current;
      // A placed text is a single piece of new content → auto-attach if edge-adjacent.
      dispatch({
        type: "addShapes",
        detectAttach: true,
        distScale: distScale(),
        shapes: [{ id: newShapeId(), type: "text", stroke: s.color, strokeWidth: s.strokeWidth, x, y, text, fontSize: fontForStroke(s.strokeWidth), ...(s.fill && { fill: s.fill }) }],
      });
      dispatch({ type: "setTool", tool: "select" });
    },
    [dispatch, distScale]
  );

  // System paste: image → image shape, text → text shape, else the internal
  // drawn-shape clipboard. Bound to the board ROOT (not window) so it fires only
  // when the board holds focus — a Cmd+V while the composer is focused goes to the
  // composer, not the canvas. (Skipped while a textarea edit owns the paste.)
  const onPaste = useCallback(
    (e: ReactClipboardEvent) => {
      if (session) return;
      // ⌘C's system-clipboard write is ASYNC — a fast ⌘C⌘V reads the clipboard
      // BEFORE the envelope lands, and would process the PREVIOUS content (a
      // stale image/board/text copied earlier) instead of the just-copied
      // shapes. Within a short grace window after our own copy, clipboard
      // content that isn't our envelope IS that race: the internal clipboard is
      // the truth. (A genuine external copy inside the window would need an
      // app-switch + copy + switch back in under 1.5s.)
      if (
        clipboard.current.length &&
        performance.now() - lastCopyAt.current < 1500 &&
        !(e.clipboardData?.getData("text") ?? "").includes(SHAPES_ENVELOPE)
      ) {
        e.preventDefault();
        pasteInternal();
        return;
      }
      const items = e.clipboardData?.items ? Array.from(e.clipboardData.items) : [];
      // A whole-BOARD payload rides text/plain NEXT TO the image (Chromium strips
      // PNG chunks on the clipboard, so a rich copy pairs representations) — it
      // must win before the image branch would place the sanitized pixels.
      if (onImportBoardRef.current) {
        const clipText = e.clipboardData?.getData("text");
        const boardDoc = clipText ? parseBoardPayload(clipText) : null;
        if (boardDoc) {
          e.preventDefault();
          onImportBoardRef.current(boardDoc);
          return;
        }
      }
      const imageItem = items.find((it) => it.type.startsWith("image/"));
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (file) {
          e.preventDefault();
          const c = pastePoint();
          void (async () => {
            // A board FILE always imports as a board (host opt-in), wherever it
            // lands; a plain image places as an auto-attaching shape.
            if (onImportBoardRef.current) {
              const boardDoc = await parseBoardFile(file);
              if (boardDoc) {
                onImportBoardRef.current(boardDoc);
                return;
              }
            }
            await addImageSafe(file, c.x, c.y, true);
          })();
          return;
        }
      }
      const text = e.clipboardData?.getData("text");
      if (text && text.trim()) {
        // A shapes envelope (this board's own ⌘C, possibly from another board or
        // tab) pastes as SHAPES — before the plain-text branch could turn the
        // JSON into a text shape.
        const shapes = parseEnvelope(text);
        if (shapes) {
          e.preventDefault();
          pasteShapes(shapes);
          return;
        }
        e.preventDefault();
        // Center the (approximate) text box on the paste point.
        const trimmed = text.replace(/\s+$/, "");
        const fs = fontForStroke(stateRef.current.strokeWidth);
        const firstLine = trimmed.split("\n")[0] ?? "";
        const pt = pastePoint();
        addTextValue(trimmed, pt.x - Math.max(8, firstLine.length * fs * 0.6) / 2, pt.y - fs * 0.6);
        return;
      }
      if (pasteInternal()) e.preventDefault();
    },
    [session, addImageSafe, addTextValue, pasteInternal, pasteShapes, parseEnvelope, pastePoint]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      const stage = stageRef.current;
      const rect = stage?.container().getBoundingClientRect();
      const v = viewRef.current;
      const drop =
        rect && v
          ? screenToLogical(v, { x: e.clientX - rect.left, y: e.clientY - rect.top })
          : viewCenterLogical();
      // Only a lone dropped image auto-attaches; a multi-file cascade (fixed +12
      // offsets, within ATTACH_DIST) must NOT chain-glue into a stack. A board
      // FILE among them always imports as a board instead (host opt-in).
      files.forEach(
        (f, i) =>
          void (async () => {
            if (onImportBoardRef.current) {
              const boardDoc = await parseBoardFile(f);
              if (boardDoc) {
                onImportBoardRef.current(boardDoc);
                return;
              }
            }
            await addImageSafe(f, drop.x + i * 12, drop.y + i * 12, files.length === 1);
          })()
      );
    },
    [addImageSafe, viewCenterLogical]
  );

  // ── Upload images via a file picker (the + button) ──────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickImages = useCallback(() => fileInputRef.current?.click(), []);
  const onFilesPicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
      const c = viewCenterLogical();
      // Only a single picked image auto-attaches; a cascade must not chain-glue.
      files.forEach((f, i) => void addImageSafe(f, c.x + i * 16, c.y + i * 16, files.length === 1));
      e.target.value = ""; // allow re-selecting the same file
    },
    [addImageSafe, viewCenterLogical]
  );

  // ── Eraser: delete the selection, or arm the erase tool ─────────────────────
  const onEraser = useCallback(() => {
    if (stateRef.current.selectedIds.length) dispatch({ type: "deleteSelected" });
    else dispatch({ type: "setTool", tool: "eraser" });
  }, [dispatch]);

  // ── `/~ : toggle cursor↔pen when on a selectable tool; return to the last
  //         selectable when on a one-use tool or the eraser. ───────────────────
  const onTilde = useCallback(() => {
    const cur = stateRef.current.tool;
    if (isSelectable(cur)) dispatch({ type: "setTool", tool: cur === "select" ? "pen" : "select" });
    else dispatch({ type: "setTool", tool: stateRef.current.baseTool });
  }, [dispatch]);

  // -/= step size, Tab cycles color — same as the toolbar controls (apply to the
  // selection if any, else change the active value via the reducer).
  // Two meanings, one control: with a whole GROUP (or a lone image) selected the
  // controls track the unit's size-STEP (×1.2 per step from its natural size,
  // remembered on the shapes); otherwise they walk the stroke ladder. Both share
  // the slotTargetStep model: absolute dots in the normal zone, relative
  // stepping in the extended zone, mid always resets.
  const SCALE_STEP = 1.2;
  /** Move the scale target (whole group / lone image) to an ABSOLUTE control
   *  step: factor from its current step, about the unit center, stamped in the
   *  same gesture — one undo entry per press. */
  const applySizeStep = useCallback(
    (target: string[], toStep: number) => {
      const s = stateRef.current;
      const cur = unitSizeStep(s.shapes, target);
      if (toStep === cur) return;
      const b = unitBoundsOf(s.shapes, rootUnitKeyOf(s.shapes.find((sh) => sh.id === target[0])!));
      if (!b) return;
      const factor = Math.pow(SCALE_STEP, toStep - cur);
      if (factor < 1 && Math.min(b.width, b.height) * factor < 8) return; // shrink floor
      dispatch({ type: "beginGesture" });
      dispatch({
        type: "scaleUnit",
        ids: target,
        factor,
        origin: { x: b.x + b.width / 2, y: b.y + b.height / 2 }, // about its center
        distScale: distScale(),
      });
      dispatch({ type: "stampSizeStep", ids: target, step: toStep });
      dispatch({ type: "endGesture" });
    },
    [dispatch, distScale]
  );
  const stepSize = useCallback(
    (dir: number) => {
      const s = stateRef.current;
      const target = scaleStepTarget(s.shapes, s.selectedIds);
      if (target) {
        applySizeStep(target, unitSizeStep(s.shapes, target) + dir);
        return;
      }
      // Width styling opted out → only the scale half above remains (a group/
      // image still resizes; that's object manipulation, not stroke styling).
      if (!features.strokeStyling) return;
      dispatch({ type: "setStrokeWidth", width: stepStroke(strokeBase(s), dir) });
    },
    [applySizeStep, dispatch, features]
  );
  /** A visible size dot was clicked. Scale mode (group/image selected): the
   *  slotTargetStep model on the unit's remembered step. Stroke mode: the same
   *  model expressed on the ladder — mid resets, an extreme SELECTS its slot
   *  from the normal zone but keeps stepping further out from at-or-beyond it,
   *  and from the OPPOSITE secret zone walks back one rung at a time. */
  const onSizeSlot = useCallback(
    (slot: 0 | 1 | 2) => {
      const s = stateRef.current;
      const target = scaleStepTarget(s.shapes, s.selectedIds);
      if (target) {
        applySizeStep(target, slotTargetStep(unitSizeStep(s.shapes, target), slot));
        return;
      }
      if (!features.strokeStyling) return; // dots only render for scale targets then
      const w = strokeBase(s);
      const width =
        slot === 1
          ? STROKE_WIDTHS[1]
          : slot === 2
            ? w >= STROKE_WIDTHS[2] || w < STROKE_WIDTHS[0]
              ? stepStroke(w, 1)
              : STROKE_WIDTHS[2]
            : w <= STROKE_WIDTHS[0] || w > STROKE_WIDTHS[2]
              ? stepStroke(w, -1)
              : STROKE_WIDTHS[0];
      dispatch({ type: "setStrokeWidth", width });
    },
    [applySizeStep, dispatch, features]
  );

  // ── Export ──────────────────────────────────────────────────────────────────
  const exporting = useRef(false);
  // True while an export renders: disables viewport culling so the whole plane
  // is in the layer for the snapshot.
  const [renderAll, setRenderAll] = useState(false);
  /** Run a stage-snapshot export with the full ceremony: single-flight guard,
   *  culling disabled (flushSync mounts every shape), caches cleared, chrome
   *  hidden, everything restored after. Null when an export is already running. */
  const withExportStage = useCallback(
    async <T,>(fn: (stage: Konva.Stage, snapshot: DrawDoc) => Promise<T>): Promise<T | null> => {
      const stage = stageRef.current;
      if (!stage || exporting.current) return null;
      exporting.current = true;
      flushSync(() => setRenderAll(true));
      stage.getLayers().forEach((l) => l.clearCache());
      const transformers = stage.find("Transformer");
      transformers.forEach((n) => n.hide());
      stage.draw();
      try {
        return await fn(stage, toDoc(stateRef.current));
      } catch (e) {
        notify(`Export failed: ${e instanceof Error ? e.message : e}`);
        return null;
      } finally {
        exporting.current = false;
        setRenderAll(false);
        transformers.forEach((n) => n.show());
        stage.draw();
      }
    },
    [notify]
  );

  const exportNow = useCallback(() => {
    if (!onSave) return;
    void withExportStage(async (stage, snapshot) => {
      const file = await exportStagePng(stage, snapshot, sketchFileName(name), { clampCrop: policy !== "infinite" });
      onSave(file, snapshot);
    });
  }, [name, onSave, policy, withExportStage]);

  // Imperative export surface for host toolbars (standalone app). Opt-in.
  useImperativeHandle(
    boardRef,
    (): BoardHandle => ({
      exportPng: (opts) =>
        withExportStage((stage, snapshot) =>
          exportBoardPng(stage, snapshot, sketchFileName(name), { rich: opts?.rich, clampCrop: policy !== "infinite" })
        ),
      exportSvg: (opts) => exportBoardSvg(toDoc(stateRef.current), name || "board", { rich: opts?.rich }),
      getDoc: () => toDoc(stateRef.current),
    }),
    [name, policy, withExportStage, boardRef]
  );

  const save = useCallback(() => {
    if (session) {
      commitEdit();
      setWantSave(true);
    } else {
      exportNow();
    }
  }, [session, commitEdit, exportNow]);
  useEffect(() => {
    if (wantSave && !session) {
      setWantSave(false);
      exportNow();
    }
  }, [wantSave, session, exportNow]);

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  // Bound to the board ROOT (not window): tool/edit hotkeys fire only while the board
  // holds focus, so keys typed into the composer never reach it (and vice versa). Esc
  // still steps back tool→selection and, at the base, bubbles to the host (collapse).
  // Adding/changing a key here? Mirror it in keymap.ts (the published reference
  // hosts render in their shortcut lists).
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (session) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      // Crop mode owns the board's keys: Enter applies, Escape cancels, all
      // other shortcuts are inert until the crop settles.
      if (croppingId) {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          cropControlRef.current?.apply();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cropControlRef.current?.cancel();
        }
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (meta) {
        if (k === "z") {
          e.preventDefault();
          dispatch(e.shiftKey ? { type: "redo" } : { type: "undo" });
        } else if (k === "c") {
          e.preventDefault();
          copy();
        } else if (k === "a") {
          e.preventDefault();
          dispatch({ type: "select", ids: stateRef.current.shapes.map((s) => s.id) });
        } else if (k === "g") {
          // ⌘G toggles: ≥2 selected units → group; a selection exactly covering
          // one group → ungroup one level (groupActionFor decides; the reducer
          // re-guards). Inert while the camera-gesture bitmap cache is live —
          // the N-identity restamp would force a full recache hitch mid-pan.
          e.preventDefault();
          if (!features.grouping) return; // grouping opted out — swallow, don't group
          if (camBusyRef.current) return;
          const action = groupActionFor(stateRef.current.shapes, stateRef.current.selectedIds);
          if (action === "group") dispatch({ type: "groupSelection", gid: newShapeId() });
          else if (action === "ungroup") dispatch({ type: "ungroup" });
        } else if (policy !== "fixed" && (k === "=" || k === "+")) {
          // ⌘= / ⌘- / ⌘0 zoom the BOARD while it holds focus (like every canvas
          // app) — plain -/= stay stroke-size keys.
          e.preventDefault();
          zoomStep(1);
        } else if (policy !== "fixed" && k === "-") {
          e.preventDefault();
          zoomStep(-1);
        } else if (policy !== "fixed" && k === "0") {
          e.preventDefault();
          fitContent();
        }
        return; // ⌘V handled by the paste listener
      }
      // The lane keys (see cyclePaint/cycleShade): ` cycles the stroke color,
      // ⇧` the fill, ⌥` the stroke SHADE, ⌥⇧` the fill shade. Keyed off
      // e.code — on mac ⌥` is a dead key (composition), so e.key is useless
      // there, and ⇧` types "~"; the physical code stays "Backquote" for all
      // four. Must run BEFORE the alt bail-out below.
      if (e.code === "Backquote" || e.key === "`" || e.key === "~") {
        e.preventDefault();
        if (e.repeat) return;
        // The reducer re-guards these per the feature config (single-color
        // board / fills opted out) — dispatch unconditionally.
        const level = e.shiftKey ? ("fill" as const) : ("stroke" as const);
        dispatch(e.altKey ? { type: "cycleShade", level } : { type: "cyclePaint", level });
        return;
      }
      if (e.altKey) return;
      // One action per PRESS: auto-repeat on the cycling/committing keys would
      // spin tool variants and flood the history with per-repeat commits. (Space
      // is already held-state; repeats are redundant there too.)
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      // Keys landing MID-STROKE must not reroute the live gesture: Esc cancels
      // the draft outright; tool switches and delete are inert. (-/=/` fall
      // through — they deliberately live-restyle the draft.)
      if (stateRef.current.draftId) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          dispatch({ type: "cancelDraw" });
          return;
        }
        if (e.key === "Tab" || e.key === "Delete" || e.key === "Backspace" || e.key === "1" || e.key === "2" || e.key === "3") {
          e.preventDefault();
          return;
        }
      }
      // Space (held) → pan with the pointer.
      if (onSpaceKey(e, true)) return;
      // Backspace/Delete → eraser (delete selection, or arm the erase tool).
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onEraser();
        return;
      }
      // Esc backs out step by step: a one-use/eraser tool → the base tool; then a
      // selection → cleared; only on a base tool with nothing selected does it
      // fall through (uncaught) so the modal closes. Capture phase + stop lets us
      // win the Esc before Radix's dismiss handler when we DO handle it.
      if (e.key === "Escape") {
        if (!isSelectable(stateRef.current.tool)) {
          e.preventDefault();
          e.stopPropagation();
          dispatch({ type: "setTool", tool: stateRef.current.baseTool });
        } else if (stateRef.current.selectedIds.length) {
          e.preventDefault();
          e.stopPropagation();
          dispatch({ type: "select", ids: [] });
        }
        return; // base tool + no selection → let it bubble → modal closes
      }
      // Tab → toggle/return to a selectable tool (primary tool).
      if (e.key === "Tab") {
        e.preventDefault();
        onTilde();
        return;
      }
      // -/= → step size down/up ( + needs shift, so we use = for up).
      if (e.key === "-" || e.code === "Minus") {
        e.preventDefault();
        stepSize(-1);
        return;
      }
      if (e.key === "=" || e.code === "Equal") {
        e.preventDefault();
        stepSize(1);
        return;
      }
      // 0 → size reset to the middle slot, exactly the mid dot (⌘0 above stays
      // fit-content). Falls through the draft guard like -/=: mid-draw it
      // live-resizes the draft back to medium.
      if (e.key === "0" || e.code === "Digit0") {
        e.preventDefault();
        onSizeSlot(1);
        return;
      }
      // 4 → cycle the stroke style (solid → dashed → dotted). Falls through the
      // draft guard like -/=/`: mid-draw it live-restyles the draft.
      if (e.key === "4") {
        e.preventDefault();
        if (!features.strokeStyling) return;
        const cur = stateRef.current.strokeStyle;
        dispatch({ type: "setStrokeStyle", style: STROKE_STYLES[(STROKE_STYLES.indexOf(cur) + 1) % STROKE_STYLES.length] });
        return;
      }
      // 1 → shape cluster (rect⇄ellipse), 2 → connector cluster
      // (line→arrow→double-arrow) — press again to cycle the variant; 3 → text.
      if (e.key === "1") {
        e.preventDefault();
        dispatch({ type: "armCluster", cluster: "shape" });
      } else if (e.key === "2") {
        e.preventDefault();
        dispatch({ type: "armCluster", cluster: "line" });
      } else if (e.key === "3") {
        e.preventDefault();
        dispatch({ type: "setTool", tool: "text" });
      }
    },
    [session, croppingId, dispatch, copy, onEraser, onTilde, stepSize, onSizeSlot, policy, zoomStep, fitContent, onSpaceKey, features]
  );

  // Space release ends pan-mode; losing focus does too (a keyup can land elsewhere).
  const onKeyUp = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === " ") onSpaceKey(e, false);
    },
    [onSpaceKey]
  );
  const onRootBlur = useCallback(() => setSpaceHeld(false), []);

  const editingId = session?.kind === "edit-text" ? session.id : null;

  // The size dots render the SELECTION's remembered position: a whole group /
  // lone image shows its scale step (mid = natural), anything else its stroke.
  const sizeTarget = scaleStepTarget(state.shapes, state.selectedIds);
  const toolbar = (
    <DrawToolbar
      tool={state.tool}
      baseTool={state.baseTool}
      shapeVariant={state.shapeVariant}
      lineVariant={state.lineVariant}
      colors={colorsBase(state)}
      fills={fillsBase(state)}
      strokeWidth={strokeBase(state)}
      strokeStyle={state.strokeStyle}
      sizeStep={sizeTarget ? unitSizeStep(state.shapes, sizeTarget) : null}
      strokeShades={state.strokeShades}
      fillShades={state.fillShades}
      strokeSpecial={state.strokeSpecial}
      fillSpecial={state.fillSpecial}
      hasSelection={state.selectedIds.length > 0}
      // state.features, not the mount-frozen copy: paletteSize is the one
      // field that moves at runtime (the lane's resize handle).
      features={state.features}
      groupAction={groupActionFor(state.shapes, state.selectedIds)}
      onGroup={() => {
        if (camBusyRef.current) return;
        const action = groupActionFor(stateRef.current.shapes, stateRef.current.selectedIds);
        if (action === "group") dispatch({ type: "groupSelection", gid: newShapeId() });
        else if (action === "ungroup") dispatch({ type: "ungroup" });
      }}
      canUndo={canUndo(state)}
      canRedo={canRedo(state)}
      onTool={(tool) => dispatch({ type: "setTool", tool })}
      onArmCluster={(cluster) => dispatch({ type: "armCluster", cluster })}
      onColor={(color) => dispatch({ type: "setColor", color })}
      onFill={(fill) => dispatch({ type: "setFill", fill })}
      onShade={(level, family, shade) => dispatch({ type: "setShade", level, family, shade })}
      onRecolor={(from, to) => dispatch({ type: "recolor", from, to })}
      onRefill={(from, to) => dispatch({ type: "refill", from, to })}
      onPaletteResize={(size) => dispatch({ type: "setPaletteSize", size })}
      onStrokeStyle={(style) => dispatch({ type: "setStrokeStyle", style })}
      onSizeSlot={onSizeSlot}
      onUndo={() => dispatch({ type: "undo" })}
      onRedo={() => dispatch({ type: "redo" })}
      onEraser={onEraser}
      onUpload={pickImages}
      onCancel={onCancel}
      onAdd={onSave ? save : undefined}
      extra={toolbarExtra}
    />
  );

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={onRootBlur}
      onPaste={onPaste}
      onPointerDownCapture={claimFocus}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <div
        ref={areaRef}
        onPointerMove={(e) => {
          pointerPosRef.current = { clientX: e.clientX, clientY: e.clientY };
        }}
        onPointerLeave={() => {
          pointerPosRef.current = null;
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="relative min-h-0 flex-1 overflow-hidden bg-ink-900"
      >
        {onToggleExpand && (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label={expanded ? "Collapse editor" : "Expand editor"}
            title={expanded ? "Collapse to chat" : "Expand to full screen"}
            className="absolute right-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-ink-600 bg-ink-800/80 text-ink-300 backdrop-blur transition-colors hover:bg-ink-700 hover:text-white max-md:[zoom:0.96]"
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
        {avail && view && fontReady && (
          <>
            <DrawCanvas
              state={state}
              dispatch={dispatch}
              bgImage={bgImage}
              bgColor={bgColor}
              view={view}
              stageSize={avail}
              policy={policy}
              onViewChange={onViewChange}
              panning={spaceHeld}
              stageRef={stageRef}
              editing={!!session}
              editingId={editingId}
              croppingId={croppingId}
              onTextClick={startText}
              onEditText={startEditText}
              onCropImage={onCropImage}
              onCropApply={onCropApply}
              onCropCancel={onCropCancel}
              cropControlRef={cropControlRef}
              renderAll={renderAll}
              camBusyRef={camBusyRef}
              newId={newShapeId}
            />
            {session && (
              <textarea
                ref={taRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={() => (ready.current ? commitEdit() : taRef.current?.focus())}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  } else if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    commitEdit();
                  }
                }}
                spellCheck={false}
                // leading-none: Konva.Text lays lines at lineHeight 1, so the
                // field must too — any extra leading pushes the glyphs DOWN vs
                // the canvas text (a visible jump when the editor opens) and
                // compounds per line on multi-line texts.
                className="draw-text-input absolute m-0 resize-none overflow-hidden whitespace-pre border-0 bg-transparent p-0 text-left leading-none outline-none"
                // No left/top here — the WYSIWYG sizing effect places the box
                // off its bond-pinned anchor (pre-paint) after each measure.
                style={(() => {
                  // Adaptive ink resolves against the field's own background
                  // fill, else whatever fill sits under it, else the paper —
                  // the same resolve the committed glyphs will get.
                  const ink =
                    session.color === CONTRAST_INK
                      ? contrastSolidOver(session.fill ?? fillAt(paintOrder(state.shapes), session.anchorX + 1, session.anchorY + 1))
                      : isNoStroke(session.color)
                        ? "transparent" // WYSIWYG: committed glyphs paint nothing too
                        : session.color;
                  // The bg highlight paints live (WYSIWYG): the box-shadow
                  // spread renders the same font-relative pad the commit will.
                  const pad = session.fontSize * 0.15 * view.scale;
                  return {
                    color: ink,
                    caretColor: ink,
                    ...(session.fill && { backgroundColor: session.fill, boxShadow: `0 0 0 ${pad}px ${session.fill}` }),
                    fontSize: session.fontSize * view.scale,
                    fontFamily: BOARD_FONT_STACK,
                    // Capped: the field IS the wrap box — it wraps at the parent's
                    // edge (or the text's own box) instead of growing out of it.
                    // Uncapped: no width here — the WYSIWYG effect grows it with
                    // the longest line (minWidth just keeps an empty field's caret
                    // clickable).
                    ...(session.maxWidth !== undefined
                      ? { width: session.maxWidth * view.scale, whiteSpace: "pre-wrap" as const, overflowWrap: "break-word" as const }
                      : { minWidth: "2rem" }),
                  };
                })()}
              />
            )}
            {policy !== "fixed" && (
              <div
                className={`absolute bottom-2 left-2 z-10 flex items-center gap-0.5 rounded-full border border-ink-600 bg-ink-800/80 px-1 py-0.5 text-ink-300 backdrop-blur${
                  state.gestureBase ? " pointer-events-none" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => zoomStep(-1)}
                  aria-label="Zoom out"
                  title="Zoom out (⌘-)"
                  className="flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-ink-700 hover:text-white"
                >
                  <Minus size={13} />
                </button>
                <button
                  type="button"
                  onClick={resetZoom}
                  aria-label="Reset zoom to 100%"
                  title="Reset to 100%"
                  className="min-w-11 rounded-full px-1 text-center text-[11px] tabular-nums transition-colors hover:bg-ink-700 hover:text-white"
                >
                  {Math.round(view.scale * 100)}%
                </button>
                <button
                  type="button"
                  onClick={() => zoomStep(1)}
                  aria-label="Zoom in"
                  title="Zoom in (⌘=)"
                  className="flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-ink-700 hover:text-white"
                >
                  <Plus size={13} />
                </button>
                <button
                  type="button"
                  onClick={fitContent}
                  aria-label="Fit content"
                  title="Fit content (⌘0)"
                  className="flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-ink-700 hover:text-white"
                >
                  <Frame size={12} />
                </button>
              </div>
            )}
            {minimap && policy !== "fixed" && (
              // pointer-events-none while a content gesture is LIVE: a stroke or
              // drag crossing the overlay must keep flowing to the stage — the
              // minimap swallowing the mouseup stranded the draft (and its
              // pointerdown would teleport the camera mid-stroke).
              <div
                className={`absolute bottom-2 right-2 z-10 overflow-hidden rounded-lg border border-ink-600 bg-ink-800/80 backdrop-blur${
                  state.gestureBase ? " pointer-events-none" : ""
                }`}
              >
                <Minimap shapes={state.shapes} view={view} board={avail} onViewChange={onViewChange} />
              </div>
            )}
          </>
        )}
      </div>

      {toolbar}

      <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={onFilesPicked} />
    </div>
  );
}

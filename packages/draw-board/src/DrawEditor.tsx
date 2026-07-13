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
  isSelectable,
  labelFont,
  toDoc,
  STROKE_WIDTHS,
  CANVAS_BG_DARK,
  CONTRAST_INK,
  PALETTE,
  type DrawDoc,
  type ImageShape,
  type Shape,
  type TextShape,
} from "./drawModel.ts";
import { exportStagePng, sketchFileName } from "./exportPng.ts";
import { exportBoardPng, exportBoardSvg, parseBoardFile } from "./boardFile.ts";
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
/** A concrete color for the text-edit overlay/caret when the adaptive ink is
 *  active (an HTML textarea can't do the canvas blend). */
const CONTRAST_OVERLAY = "#ffffff";

/** Raster bytes for an image placed on the board (paste/drop/pick). */
export interface BoardImageData {
  dataBase64: string;
  mediaType: string;
}

/** Default file→raster reader: plain FileReader, no size policy. A host with
 *  attachment rules (size caps, mime allowlists) injects its own reader via
 *  `imageToData` and REJECTS to surface the refusal through `onNotify`. */
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

/** An in-progress text edit. `kind` selects the target: a NEW standalone text
 *  (nothing exists in the model until commit — so a stray mouse-up can't tear it
 *  down), an EXISTING text shape, or a shape's bound LABEL. Geometry lives here
 *  so the textarea never depends on a model shape existing. */
interface EditSession {
  kind: "new-text" | "edit-text" | "label";
  id: string | null;
  x: number;
  y: number;
  fontSize: number;
  color: string;
}

/**
 * The drawing editor body: toolbar + pan/zoom Konva canvas + inline text
 * overlay + a Cancel / "Add to message" footer. Owns theme-aware defaults, the
 * CAMERA (pan/zoom per its viewport policy), text/label editing, clipboard +
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
  // Operator is dark-only. The primary ink is adaptive (CONTRAST_INK) — it
  // renders via a `difference` blend in the canvas, so it always contrasts the
  // background per pixel with no luminance sampling here.
  const palette = PALETTE;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const bgColor = bgImage ? "transparent" : CANVAS_BG_DARK;

  const { state, dispatch } = useDrawing(doc, CONTRAST_INK);
  const stageRef = useRef<Konva.Stage>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const clipboard = useRef<Shape[]>([]);

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
  useEffect(() => {
    return () => onChangeRef.current?.(toDoc(stateRef.current));
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

  // ── Text / label editing (model-independent, focus-race safe) ───────────────
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

  const startText = useCallback((x: number, y: number) => {
    const s = stateRef.current;
    setValue("");
    setSession({ kind: "new-text", id: null, x, y, fontSize: fontForStroke(s.strokeWidth), color: s.color });
  }, []);
  const startEditText = useCallback((id: string) => {
    const sh = stateRef.current.shapes.find((s) => s.id === id) as TextShape | undefined;
    if (!sh || sh.type !== "text") return;
    setValue(sh.text);
    setSession({ kind: "edit-text", id, x: sh.x, y: sh.y, fontSize: sh.fontSize, color: sh.stroke });
  }, []);
  const startLabel = useCallback((id: string) => {
    const sh = stateRef.current.shapes.find((s) => s.id === id);
    if (!sh) return;
    const b = boundingBox(sh);
    setValue(sh.label ?? "");
    setSession({ kind: "label", id, x: b.x + b.width / 2, y: b.y + b.height / 2, fontSize: labelFont(b), color: sh.stroke });
  }, []);

  const commitEdit = useCallback(() => {
    const cur = sessionRef.current;
    if (!cur) return;
    sessionRef.current = null; // claim it synchronously → a same-tick second call no-ops
    const text = valueRef.current.trim();
    if (cur.kind === "new-text") {
      if (text) {
        dispatch({
          type: "addShapes",
          detectAttach: true, // a placed text glues to a shape it's dropped against
          distScale: distScale(), // screen-true glue range, same as every other placement
          shapes: [{ id: newShapeId(), type: "text", stroke: cur.color, strokeWidth: stateRef.current.strokeWidth, x: cur.x, y: cur.y, text, fontSize: cur.fontSize }],
        });
        // Text is one-use → snap back to the last selectable tool.
        dispatch({ type: "setTool", tool: stateRef.current.baseTool });
      }
    } else if (cur.kind === "edit-text" && cur.id) {
      if (text) dispatch({ type: "setText", id: cur.id, text });
      else dispatch({ type: "deleteShapes", ids: [cur.id] });
    } else if (cur.kind === "label" && cur.id) {
      dispatch({ type: "beginGesture" });
      dispatch({ type: "patchShape", id: cur.id, patch: { label: text || undefined } });
      dispatch({ type: "endGesture" });
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
  const copy = useCallback(() => {
    const sel = new Set(stateRef.current.selectedIds);
    const picked = stateRef.current.shapes.filter((s) => sel.has(s.id)).map(cloneShape);
    if (!picked.length) return;
    clipboard.current = picked;
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
  /** Parse a system-clipboard text as a shapes envelope; null if it's not one. */
  const parseEnvelope = useCallback((text: string): Shape[] | null => {
    if (!text.includes(SHAPES_ENVELOPE)) return null;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const shapes = parsed?.[SHAPES_ENVELOPE] ? (parsed.shapes as Shape[] | undefined) : undefined;
      return Array.isArray(shapes) && shapes.length ? shapes : null;
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
        shapes: [{ id: newShapeId(), type: "text", stroke: s.color, strokeWidth: s.strokeWidth, x, y, text, fontSize: fontForStroke(s.strokeWidth) }],
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
      const items = e.clipboardData?.items ? Array.from(e.clipboardData.items) : [];
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
  const stepSize = useCallback(
    (dir: number) => {
      const idx = STROKE_WIDTHS.indexOf(stateRef.current.strokeWidth as (typeof STROKE_WIDTHS)[number]);
      const ni = Math.min(STROKE_WIDTHS.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + dir));
      dispatch({ type: "setStrokeWidth", width: STROKE_WIDTHS[ni] });
    },
    [dispatch]
  );
  const cycleColor = useCallback(
    (dir: number) => {
      const pal = paletteRef.current;
      const cur = stateRef.current.color.toLowerCase();
      let idx = pal.findIndex((c) => c.toLowerCase() === cur);
      if (idx < 0) idx = 0;
      dispatch({ type: "setColor", color: pal[(idx + dir + pal.length) % pal.length] });
    },
    [dispatch]
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
      // ` (tilde/tick) / ⇧` → cycle the color forward/back.
      if (e.key === "`" || e.code === "Backquote") {
        e.preventDefault();
        cycleColor(e.shiftKey ? -1 : 1);
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
    [session, croppingId, dispatch, copy, onEraser, onTilde, stepSize, cycleColor, policy, zoomStep, fitContent, onSpaceKey]
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
  const editingLabelId = session?.kind === "label" ? session.id : null;
  const centered = session?.kind === "label";

  const toolbar = (
    <DrawToolbar
      tool={state.tool}
      baseTool={state.baseTool}
      shapeVariant={state.shapeVariant}
      lineVariant={state.lineVariant}
      color={state.color}
      strokeWidth={state.strokeWidth}
      palette={palette}
      hasSelection={state.selectedIds.length > 0}
      canUndo={canUndo(state)}
      canRedo={canRedo(state)}
      onTool={(tool) => dispatch({ type: "setTool", tool })}
      onArmCluster={(cluster) => dispatch({ type: "armCluster", cluster })}
      onColor={(color) => dispatch({ type: "setColor", color })}
      onWidth={(width) => dispatch({ type: "setStrokeWidth", width })}
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
        {avail && view && (
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
              editingLabelId={editingLabelId}
              croppingId={croppingId}
              onTextClick={startText}
              onEditText={startEditText}
              onEditLabel={startLabel}
              onCropImage={onCropImage}
              onCropApply={onCropApply}
              onCropCancel={onCropCancel}
              cropControlRef={cropControlRef}
              renderAll={renderAll}
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
                className="draw-text-input absolute m-0 resize-none overflow-hidden whitespace-pre border-0 bg-transparent p-0 text-center leading-tight outline-none"
                style={{
                  left: session.x * view.scale + view.x,
                  top: session.y * view.scale + view.y,
                  transform: centered ? "translate(-50%, -50%)" : undefined,
                  minWidth: "2rem",
                  textAlign: centered ? "center" : "left",
                  color: session.color === CONTRAST_INK ? CONTRAST_OVERLAY : session.color,
                  caretColor: session.color === CONTRAST_INK ? CONTRAST_OVERLAY : session.color,
                  fontSize: session.fontSize * view.scale,
                  fontFamily: "Arial, sans-serif",
                }}
              />
            )}
            {policy !== "fixed" && (
              <div className="absolute bottom-2 left-2 z-20 flex items-center gap-0.5 rounded-full border border-ink-600 bg-ink-800/80 px-1 py-0.5 text-ink-300 backdrop-blur">
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
              <div className="absolute bottom-2 right-2 z-20 overflow-hidden rounded-lg border border-ink-600 bg-ink-800/80 backdrop-blur">
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

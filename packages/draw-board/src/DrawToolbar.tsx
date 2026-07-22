import {
  MousePointer2,
  Pencil,
  Square,
  Circle,
  Minus,
  Plus,
  ArrowUpRight,
  MoveDiagonal,
  Type,
  Eraser,
  Group,
  Ungroup,
  Undo2,
  Redo2,
  Check,
  X,
  ImagePlus,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton.tsx";
import { CONTRAST_INK, FILL_COLORS, STROKE_WIDTHS, STROKE_STYLES, SHAPE_VARIANTS, LINE_VARIANTS, sizeSlotOf, type Tool, type ShapeVariant, type LineVariant, type StrokeStyle } from "./drawModel.ts";

/** The two persistent tools live in a segmented "well" that slides to whichever
 *  is armed; the one-use tools (shape / connector clusters + text) follow it. */
const PILL: { tool: "select" | "pen"; icon: LucideIcon; label: string }[] = [
  { tool: "select", icon: MousePointer2, label: "Cursor — select / move (Tab)" },
  { tool: "pen", icon: Pencil, label: "Pen — draw freehand (Tab)" },
];

/** Icon per cluster variant (drives the morph button's stacked crossfade). */
const SHAPE_ICON: Record<ShapeVariant, LucideIcon> = { rect: Square, ellipse: Circle };
const LINE_ICON: Record<LineVariant, LucideIcon> = { line: Minus, arrow: ArrowUpRight, darrow: MoveDiagonal };
const SHAPE_LABEL: Record<ShapeVariant, string> = { rect: "rectangle", ellipse: "ellipse" };
const LINE_LABEL: Record<LineVariant, string> = { line: "line", arrow: "arrow", darrow: "double arrow" };

const SPRING = "cubic-bezier(0.34,1.4,0.64,1)";
/** Role geometry for a variant inside the morph button: the CURRENT tool sits big +
 *  centered; the NEXT-in-cycle rides small in the bottom-right corner (so the button
 *  visibly shows there's another tool a tap away); any further variant hides behind
 *  the current. Roles swap on cycle and each icon TRANSITIONS between them, so the
 *  small preview grows to center as the big one shrinks into the corner. */
const ROLE = {
  main: { transform: "translate(0,0) scale(1)", opacity: 1, zIndex: 20 },
  hint: { transform: "translate(4.5px,4.5px) scale(0.5)", opacity: 0.6, zIndex: 10 },
  hidden: { transform: "translate(4.5px,4.5px) scale(0.35)", opacity: 0, zIndex: 0 },
} as const;

/** A one-use cluster button. Shows the active variant large and centered, with the
 *  next variant peeking small in the corner; pressing while already armed cycles to
 *  it (one button both selects and switches). All variants stay mounted so the swap
 *  animates (square shrinks to the corner as the circle grows to the center). */
function ClusterButton<V extends string>({
  variants,
  icons,
  labels,
  current,
  active,
  hotkey,
  onArm,
}: {
  variants: readonly V[];
  icons: Record<V, LucideIcon>;
  labels: Record<V, string>;
  current: V;
  active: boolean;
  hotkey: string;
  onArm: () => void;
}) {
  const idx = variants.indexOf(current);
  const next = variants[(idx + 1) % variants.length];
  const others = variants.filter((v) => v !== current).map((v) => labels[v]);
  const label = `${labels[current][0].toUpperCase()}${labels[current].slice(1)} (${hotkey}) — tap to switch to ${others.join(" / ")}`;
  return (
    <IconButton label={label} aria-pressed={active} onClick={onArm} className={active ? "bg-accent-600/25 !text-accent-200" : "!text-ink-200"}>
      <span className="relative block h-5 w-5">
        {variants.map((v) => {
          const Icon: LucideIcon = icons[v];
          const role = v === current ? "main" : v === next ? "hint" : "hidden";
          return (
            <span
              key={v}
              aria-hidden
              className="absolute inset-0 flex items-center justify-center"
              style={{ ...ROLE[role], transition: `transform 260ms ${SPRING}, opacity 180ms ease` }}
            >
              <Icon size={20} strokeWidth={2.25} />
            </span>
          );
        })}
      </span>
    </IconButton>
  );
}

/** The fill pill's value row — none first, then the regular inks. */
const FILL_VALUES: readonly (string | null)[] = [null, ...FILL_COLORS];

/** Shared chrome of the color/fill pills, DECLARATION-aware. With a selection
 *  the pill highlights EVERY value present on it (`active`) — the selection's
 *  editable color declaration: clicking a swatch still repaints the whole
 *  selection (onPick), while DRAGGING one highlighted swatch onto another
 *  merges only that color class into the target (onMerge) — recolor the reds
 *  blue without touching the rest. Null is the fill pill's "none", a mergeable
 *  class like any other (none→c fills the unfilled, c→none strips that class).
 *  With exactly one highlight the accent well keeps its signature slide. */
function SwatchPill<V extends string | null>({
  values,
  active,
  mergeable,
  onPick,
  onMerge,
  swatch,
  labelFor,
  titleFor,
}: {
  values: readonly V[];
  /** The highlighted declaration (the ambient pref when nothing is selected). */
  active: readonly V[];
  /** Whether drag-merge is armed — i.e. a selection exists to retarget. */
  mergeable: boolean;
  onPick: (v: V) => void;
  onMerge: (from: V, to: V) => void;
  swatch: (v: V) => React.ReactNode;
  labelFor: (v: V) => string;
  titleFor: (v: V) => string;
}) {
  const pillRef = useRef<HTMLDivElement>(null);
  // The press being watched for a drag — set on pointerdown on a draggable
  // (highlighted) swatch, promoted to the `drag` render state past 5px.
  const pressRef = useRef<{ v: V; x: number; y: number; started: boolean } | null>(null);
  // A finished drag still fires a click on the (capturing) source button —
  // swallow exactly that one so the drop doesn't ALSO repaint the selection.
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState<{ v: V; x: number; y: number; overIdx: number | null } | null>(null);

  const key = (v: V) => (v === null ? "\0none" : v.toLowerCase());
  const eq = (a: V, b: V) => key(a) === key(b);
  const isActive = (v: V) => active.some((a) => eq(a, v));
  const activeIdxs = values.map((v, i) => (isActive(v) ? i : -1)).filter((i) => i >= 0);
  const srcIdx = drag ? values.findIndex((v) => eq(v, drag.v)) : -1;

  /** The swatch index under a viewport point — the drop target hit-test
   *  (coordinate-based, so pointer capture doesn't blind it). */
  const targetAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest("[data-swatch-idx]");
    if (!(el instanceof HTMLElement) || !pillRef.current?.contains(el)) return null;
    return Number(el.dataset.swatchIdx);
  };

  const wellClass =
    "pointer-events-none absolute inset-y-0.5 left-0.5 w-7 rounded-full bg-accent-600/25 ring-1 ring-inset ring-accent-500/40 [transition:transform_300ms_cubic-bezier(0.34,1.3,0.64,1)]";
  return (
    <div ref={pillRef} className="relative flex items-center rounded-full border border-ink-600 bg-ink-800 p-0.5">
      {activeIdxs.length === 1 ? (
        // Lone highlight: the classic single well — persists across renders, so
        // an ambient color change still SLIDES it (the signature motion).
        <span aria-hidden className={wellClass} style={{ transform: `translateX(${activeIdxs[0] * 100}%)` }} />
      ) : (
        // Multi-color declaration: one static well per member (membership
        // changes discretely with the selection — nothing to slide).
        activeIdxs.map((i) => <span key={i} aria-hidden className={wellClass} style={{ transform: `translateX(${i * 100}%)` }} />)
      )}
      {values.map((v, i) => {
        const draggable = mergeable && isActive(v);
        return (
          <button
            key={v ?? "none"}
            type="button"
            data-swatch-idx={i}
            aria-label={labelFor(v)}
            aria-pressed={isActive(v)}
            title={titleFor(v) + (draggable ? " — drag onto another swatch to repaint just this color" : "")}
            onPointerDown={(e) => {
              suppressClickRef.current = false; // every press starts clean
              if (!draggable || e.button !== 0) return;
              pressRef.current = { v, x: e.clientX, y: e.clientY, started: false };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const p = pressRef.current;
              if (!p || (!p.started && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5)) return;
              p.started = true;
              setDrag({ v: p.v, x: e.clientX, y: e.clientY, overIdx: targetAt(e.clientX, e.clientY) });
            }}
            onPointerUp={(e) => {
              const p = pressRef.current;
              pressRef.current = null;
              if (!p?.started) return; // sub-threshold press → the click event repaints
              suppressClickRef.current = true;
              setDrag(null);
              const over = targetAt(e.clientX, e.clientY);
              if (over != null && !eq(values[over], p.v)) onMerge(p.v, values[over]);
            }}
            onPointerCancel={() => {
              pressRef.current = null;
              setDrag(null);
            }}
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              onPick(v);
            }}
            className={`relative z-10 flex h-7 w-7 touch-none items-center justify-center rounded-full ${draggable ? "cursor-grab" : ""} ${
              drag && drag.overIdx === i && i !== srcIdx ? "ring-2 ring-accent-400" : ""
            } ${drag && i === srcIdx ? "opacity-40" : ""}`}
          >
            {swatch(v)}
          </button>
        );
      })}
      {/* The carried color rides the pointer — portaled to body so the
          toolbar's container-type (layout containment = it would become this
          fixed element's containing block) can't trap it. */}
      {drag &&
        createPortal(
          <span
            aria-hidden
            className="pointer-events-none fixed z-[100] -translate-x-1/2 -translate-y-1/2 scale-125 drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
            style={{ left: drag.x, top: drag.y }}
          >
            {swatch(drag.v)}
          </span>,
          document.body
        )}
    </div>
  );
}

/**
 * The drawing toolbar: tool picker · color swatches · stroke width · history ·
 * delete/clear. Deliberately spare — chrome uses design tokens/`ui` primitives;
 * the color swatches are the one place raw content colors appear (the pixels
 * the user paints, not UI).
 */
export function DrawToolbar({
  tool,
  baseTool,
  shapeVariant,
  lineVariant,
  colors,
  fills,
  strokeWidth,
  strokeStyle,
  sizeStep = null,
  palette,
  hasSelection,
  groupAction,
  onGroup,
  canUndo,
  canRedo,
  onTool,
  onArmCluster,
  onColor,
  onFill,
  onRecolor,
  onRefill,
  onStrokeStyle,
  onSizeSlot,
  onUndo,
  onRedo,
  onEraser,
  onUpload,
  onCancel,
  onAdd,
  extra,
}: {
  tool: Tool;
  /** The armed selectable tool (select/pen) — the pill's well slides here. */
  baseTool: "select" | "pen";
  /** Last-used variant of each one-use cluster — the morph button shows its icon. */
  shapeVariant: ShapeVariant;
  lineVariant: LineVariant;
  /** The stroke pill's highlighted DECLARATION: every stroke color present on
   *  the selection (multi while mixed), or just the ambient pen ink. */
  colors: readonly string[];
  /** The fill pill's declaration (null = none), same contract as `colors`. */
  fills: readonly (string | null)[];
  /** The width the size dots display (the selection's own when it has one). */
  strokeWidth: number;
  /** The armed stroke style (solid/dashed/dotted) — the 4 key cycles it. */
  strokeStyle: StrokeStyle;
  /** Scale mode: the selected group's / lone image's size-control step (0 =
   *  natural "medium"), or null for stroke mode. The dots then read the unit's
   *  position — mid resets, extremes step — instead of stroke widths. */
  sizeStep?: number | null;
  /** Swatch colors: primary theme ink first, then the content colors. */
  palette: readonly string[];
  hasSelection: boolean;
  /** What ⌘G would do to the current selection (drives the group button's icon
   *  + disabled state): 'group', 'ungroup', or null (nothing groupable). */
  groupAction: "group" | "ungroup" | null;
  /** Group/ungroup the selection (the ⌘G toggle). */
  onGroup: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onTool: (t: Tool) => void;
  /** Arm a one-use cluster (select its variant, or cycle if already armed). */
  onArmCluster: (cluster: "shape" | "line") => void;
  onColor: (c: string) => void;
  /** A fill swatch was pressed (null = none; also refills the selection). */
  onFill: (c: string | null) => void;
  /** A highlighted stroke swatch was DRAGGED onto another: repaint just that
   *  color class within the selection (from → to). */
  onRecolor: (from: string, to: string) => void;
  /** Fill counterpart of onRecolor (null = the none class). */
  onRefill: (from: string | null, to: string | null) => void;
  /** A stroke-style swatch was pressed (also restyles the selection). */
  onStrokeStyle: (s: StrokeStyle) => void;
  /** A size dot was pressed (0 small · 1 mid · 2 large). The EDITOR owns the
   *  semantics (secret-ladder stepping / group scaling) — the toolbar only
   *  reports which dot. */
  onSizeSlot: (slot: 0 | 1 | 2) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Eraser: delete the current selection, or (if none) arm the erase tool. */
  onEraser: () => void;
  /** Open the file picker to add image(s) to the canvas. */
  onUpload: () => void;
  /** Discard the drawing (close the editor). Omit to hide the button — a host
   *  that persists continuously (a document editor) has nothing to discard. */
  onCancel?: () => void;
  /** Flatten + export the drawing (the attachment flow). Omit to hide. */
  onAdd?: () => void;
  /** Host-supplied controls rendered at the FAR RIGHT of the actions cluster
   *  (e.g. the standalone app's export buttons). Operator passes nothing. */
  extra?: React.ReactNode;
}) {
  const persistentActive = tool === "select" || tool === "pen";
  // The well sits on the nearest visible slot even for SECRET sizes (past the
  // three shown); the active slot's dot then renders at the REAL size so the
  // secret level stays legible. Repeated presses of an extreme keep stepping.
  // Scale mode (sizeStep != null — a whole group / lone image selected): the
  // slots read the unit's control step instead — small −1 · mid 0 (natural) ·
  // large +1, extended past either end.
  const scaleMode = sizeStep != null;
  const sizeIdx: 0 | 1 | 2 = scaleMode ? (sizeStep <= -1 ? 0 : sizeStep >= 1 ? 2 : 1) : sizeSlotOf(strokeWidth);
  // EXTENDED zone: the OPPOSITE extreme now means "one step back in" (see
  // slotTargetStep) — it renders as −/+ so the changed meaning is visible on
  // the control itself, not just in behavior.
  const extended = scaleMode ? Math.abs(sizeStep) >= 2 : strokeWidth > STROKE_WIDTHS[2] || strokeWidth < STROKE_WIDTHS[0];
  return (
    // Pinning is CONTAINER-query driven (@container ≥72rem), not viewport
    // (md:) — the board panel is routinely narrower than the viewport
    // (sketchbook's sidebar, Operator's chat dock), and viewport-based pinning
    // let the centered pills slide UNDER the absolute history cluster there
    // (the undo button ate the style pill's clicks). 72rem = the measured
    // center row (754px) + 2× the widest pinned side (178px) + slack; below
    // it the pinned pieces fall in flow and flex-wrap stacks rows — overlap
    // is impossible by construction. z-30: container-type implies layout
    // containment, which makes this a stacking context — without an explicit
    // z the export menu inside (z-50, now LOCAL) would trap below the
    // canvas overlays (minimap z-10).
    <div className="relative z-30 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t border-ink-600 px-2 py-1.5 [container-type:inline-size] max-md:[zoom:1.04]">
      {/* Upload image — pinned left when the toolbar is wide enough (the
          in-row copy in the actions cluster covers narrow layouts). */}
      <button
        type="button"
        onClick={onUpload}
        aria-label="Upload image"
        title="Upload image"
        className="hidden h-8 w-8 items-center justify-center rounded-full border border-ink-500 bg-ink-700 text-ink-300 transition-colors hover:bg-ink-600 hover:text-white [@container(min-width:72rem)]:absolute [@container(min-width:72rem)]:left-3 [@container(min-width:72rem)]:top-1/2 [@container(min-width:72rem)]:flex [@container(min-width:72rem)]:-translate-y-1/2"
      >
        <ImagePlus size={16} />
      </button>

      {/* Tools cluster — on mobile it drops below the color cluster (its own row)
          and the buttons run ~18% larger than the rest of the toolbar (fat-finger
          targets for the primary drawing tools). */}
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 max-md:order-2 max-md:basis-full max-md:[zoom:1.18]">
      {/* Eraser: deletes the selection, or arms the erase tool when nothing is
          selected. (Clear all = ⌘A then ⌫.) */}
      <IconButton
        label={hasSelection ? "Delete selected (⌫)" : "Eraser — drag over shapes to delete (⌫)"}
        variant="danger"
        aria-pressed={tool === "eraser"}
        onClick={onEraser}
        className={tool === "eraser" ? "bg-red-900/40 !text-red-300" : "!text-ink-200"}
      >
        <Eraser size={20} strokeWidth={2.25} />
      </IconButton>

      {/* Persistent tools — a segmented well that slides to the armed one
          (`baseTool`). Clicking a segment arms it; ` toggles between them. The
          container + its sliding indicator are deliberately prominent (brighter
          border, inner shadow, a stronger accent well) so the primary tool toggle
          reads as the anchor of the row. */}
      <div className="relative flex items-center rounded-full border border-ink-500 bg-ink-900 p-0.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]">
        {/* The well is accent-tinted while a selectable tool is active; it fades
            to grayscale when a one-use/eraser tool is armed (it's only the
            snap-back target then, not the active tool). */}
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-y-0.5 left-0.5 w-7 rounded-full ring-1 ring-inset [transition:transform_300ms_cubic-bezier(0.34,1.3,0.64,1),background-color_200ms,box-shadow_200ms] ${
            persistentActive
              ? "bg-accent-500/35 ring-accent-400/60 shadow-[0_0_10px_rgba(139,92,246,0.35)]"
              : "bg-ink-700 ring-ink-500"
          }`}
          style={{ transform: `translateX(${baseTool === "pen" ? "100%" : "0%"})` }}
        />
        {PILL.map(({ tool: t, icon: Icon, label }) => (
          <button
            key={t}
            type="button"
            aria-label={label}
            aria-pressed={tool === t}
            title={label}
            onClick={() => onTool(t)}
            className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
              baseTool === t ? (persistentActive ? "text-accent-200" : "text-ink-100") : "text-ink-300 hover:text-ink-100"
            }`}
          >
            <Icon size={20} strokeWidth={2.25} />
          </button>
        ))}
      </div>

      {/* One-use tools: shape cluster (rect⇄ellipse) · connector cluster
          (line→arrow→double-arrow) · text. Each cluster is a single morph button —
          press to arm its last variant, press again to cycle. */}
      <div className="flex items-center gap-0.5">
        <ClusterButton
          variants={SHAPE_VARIANTS}
          icons={SHAPE_ICON}
          labels={SHAPE_LABEL}
          current={shapeVariant}
          active={tool === "rect" || tool === "ellipse"}
          hotkey="1"
          onArm={() => onArmCluster("shape")}
        />
        <ClusterButton
          variants={LINE_VARIANTS}
          icons={LINE_ICON}
          labels={LINE_LABEL}
          current={lineVariant}
          active={tool === "line" || tool === "arrow" || tool === "darrow"}
          hotkey="2"
          onArm={() => onArmCluster("line")}
        />
        <IconButton
          label="Text (3)"
          aria-pressed={tool === "text"}
          onClick={() => onTool("text")}
          className={tool === "text" ? "bg-accent-600/25 !text-accent-200" : "!text-ink-200"}
        >
          <Type size={20} strokeWidth={2.25} />
        </IconButton>
      </div>

      {/* Group/ungroup toggle — mirrors ⌘G (groupAction decides which). An
          action on the selection, not an armable tool, so it sits outside the
          one-use cluster. */}
      <IconButton
        label={groupAction === "ungroup" ? "Ungroup (⌘G)" : "Group selection (⌘G)"}
        disabled={groupAction === null}
        onClick={onGroup}
        className="!text-ink-200 disabled:opacity-30"
      >
        {groupAction === "ungroup" ? <Ungroup size={20} strokeWidth={2.25} /> : <Group size={20} strokeWidth={2.25} />}
      </IconButton>
      </div>

      {/* Style cluster (color + size) — on mobile this is the top row. */}
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 max-md:order-1 max-md:basis-full">
      {/* Color swatches — the selection's editable stroke declaration (see
          SwatchPill): every color present highlights; drag one onto another to
          repaint just that class, click to repaint the whole selection. */}
      <SwatchPill
        values={palette}
        active={colors}
        mergeable={hasSelection}
        onPick={onColor}
        onMerge={onRecolor}
        labelFor={(c) => (c === CONTRAST_INK ? "Adaptive ink — always contrasts the background (`)" : `Color ${c}`)}
        titleFor={(c) => (c === CONTRAST_INK ? "Adaptive — always contrasts what's behind it" : c)}
        swatch={(c) => (
          <span
            className="h-[18px] w-[18px] rounded-full border border-ink-500"
            style={{ backgroundColor: c === CONTRAST_INK ? "#f5f5f5" : c }}
          />
        )}
      />

      {/* Fill swatches — interior / text-background color, none first. SQUARE
          swatches (area) vs the stroke circles; regular inks only — the
          adaptive ink is stroke-only (fills are what it contrasts against).
          None is a declaration class too: drag none→c to fill the unfilled. */}
      <SwatchPill
        values={FILL_VALUES}
        active={fills}
        mergeable={hasSelection}
        onPick={onFill}
        onMerge={onRefill}
        labelFor={(c) => (c ? `Fill ${c}` : "No fill")}
        titleFor={(c) => (c ? `Fill ${c}` : "No fill")}
        swatch={(c) =>
          c ? (
            <span className="h-4 w-4 rounded border border-ink-500" style={{ backgroundColor: c }} />
          ) : (
            <span className="relative h-4 w-4 overflow-hidden rounded border border-ink-400">
              <span className="absolute left-1/2 top-1/2 h-[1.5px] w-6 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-red-400/80" />
            </span>
          )
        }
      />

{/* Stroke / text size — same sliding accent well. Three dots, more sizes: the
    extremes keep stepping when re-pressed (secret levels past the visible
    three; the active dot grows/shrinks with the REAL size), mid resets. With a
    group or image selected the dots read ITS remembered scale step instead
    (mid = natural size), same stepping model. In the extended zone the
    opposite extreme renders as −/+ — it walks one step back, not absolute. */}
      <div className="relative flex items-center rounded-full border border-ink-600 bg-ink-800 p-0.5">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0.5 left-0.5 w-7 rounded-full bg-accent-600/25 ring-1 ring-inset ring-accent-500/40 [transition:transform_300ms_cubic-bezier(0.34,1.3,0.64,1)]"
          style={{ transform: `translateX(${sizeIdx * 100}%)` }}
        />
        {STROKE_WIDTHS.map((w, i) => {
          const active = sizeIdx === i;
          // The active dot mirrors the real size/step (clamped to the button);
          // the spring makes a repeated press visibly grow/shrink it.
          const dot = scaleMode
            ? active
              ? i === 2
                ? Math.min(22, 12 + (sizeStep - 1) * 3)
                : i === 0
                  ? Math.max(2, 5 + (sizeStep + 1) * 1.5)
                  : 8
              : w + 2
            : active
              ? Math.max(3, Math.min(22, strokeWidth + 2))
              : w + 2;
          const backGlyph = extended && !active && i !== 1 ? (i === 0 ? Minus : Plus) : null;
          const BackIcon = backGlyph;
          return (
            <button
              key={w}
              type="button"
              aria-label={`Stroke ${w}px`}
              aria-pressed={active}
              title={
                i === 1
                  ? scaleMode
                    ? "Size normal — resets the scale (-/=)"
                    : "Size medium — resets (-/=)"
                  : BackIcon
                    ? `One step back ${i === 0 ? "down" : "up"} (-/=)`
                    : `Size ${i === 0 ? "small" : "large"} (-/=) — press again for ${i === 0 ? "smaller" : "larger"}`
              }
              onClick={() => onSizeSlot(i as 0 | 1 | 2)}
              className="relative z-10 flex h-7 w-7 items-center justify-center rounded-full"
            >
              {BackIcon ? (
                <BackIcon size={13} strokeWidth={2.5} className="text-ink-100" />
              ) : (
                <span
                  className="rounded-full bg-ink-100"
                  style={{ width: dot, height: dot, transition: `width 220ms ${SPRING}, height 220ms ${SPRING}` }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Stroke style — solid / dashed / dotted, same sliding well; 4 cycles.
          Swatches are literal line previews (an icon set has no honest glyphs
          for these). */}
      <div className="relative flex items-center rounded-full border border-ink-600 bg-ink-800 p-0.5">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0.5 left-0.5 w-7 rounded-full bg-accent-600/25 ring-1 ring-inset ring-accent-500/40 [transition:transform_300ms_cubic-bezier(0.34,1.3,0.64,1)]"
          style={{ transform: `translateX(${STROKE_STYLES.indexOf(strokeStyle) * 100}%)` }}
        />
        {STROKE_STYLES.map((st) => {
          const name = `${st[0].toUpperCase()}${st.slice(1)}`;
          return (
            <button
              key={st}
              type="button"
              aria-label={`${name} stroke (4)`}
              aria-pressed={strokeStyle === st}
              title={`${name} stroke — 4 cycles the styles`}
              onClick={() => onStrokeStyle(st)}
              className="relative z-10 flex h-7 w-7 items-center justify-center rounded-full text-ink-100"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <line
                  x1="2"
                  y1="9"
                  x2="16"
                  y2="9"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={st === "dashed" ? "4 3" : st === "dotted" ? "0.1 3.6" : undefined}
                />
              </svg>
            </button>
          );
        })}
      </div>
      </div>

      {/* History + apply/cancel — absolutely pinned right when the CONTAINER
          fits center row + both pinned sides (so the tool groups stay truly
          centered); otherwise its own full row, history left / actions right
          (the flow classes are unconditional — they're ignored while out of
          flow). z-30 keeps the export menu above the root's local layers. */}
      <div className="z-30 order-3 flex basis-full items-center justify-between gap-2 [@container(min-width:72rem)]:absolute [@container(min-width:72rem)]:right-3 [@container(min-width:72rem)]:top-1/2 [@container(min-width:72rem)]:-translate-y-1/2">
        <div className="flex items-center gap-0.5">
          <IconButton label="Undo (⌘Z)" disabled={!canUndo} onClick={onUndo} className="disabled:opacity-30">
            <Undo2 size={16} />
          </IconButton>
          <IconButton label="Redo (⌘⇧Z)" disabled={!canRedo} onClick={onRedo} className="disabled:opacity-30">
            <Redo2 size={16} />
          </IconButton>
        </div>
        <div className="flex items-center gap-2">
          {/* Narrow-layout upload (before Cancel); the wide copy is pinned left. */}
          <button
            type="button"
            onClick={onUpload}
            aria-label="Upload image"
            title="Upload image"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-ink-500 bg-ink-700 text-ink-300 transition-colors hover:bg-ink-600 hover:text-white [@container(min-width:72rem)]:hidden"
          >
            <ImagePlus size={16} />
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Discard drawing"
              title="Discard"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-ink-500 bg-ink-700 text-ink-300 transition-colors hover:bg-ink-600 hover:text-white"
            >
              <X size={16} />
            </button>
          )}
          {onAdd && (
            <button
              type="button"
              onClick={onAdd}
              aria-label="Add to message"
              title="Add to message"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-600 text-white shadow-sm transition-colors hover:bg-accent-500 active:bg-accent-700"
            >
              <Check size={16} strokeWidth={2.5} />
            </button>
          )}
          {extra}
        </div>
      </div>
    </div>
  );
}

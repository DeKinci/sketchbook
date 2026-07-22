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
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton.tsx";
import { CONTRAST_INK, HUE_FAMILIES, SHADES, familyOf, STROKE_WIDTHS, STROKE_STYLES, SHAPE_VARIANTS, LINE_VARIANTS, sizeSlotOf, type HueFamily, type Tool, type ShapeVariant, type LineVariant, type StrokeStyle } from "./drawModel.ts";

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

type PaintLevel = "stroke" | "fill";

/** The lane's drop hit-test: the half (or open shade-strip rung) under a
 *  viewport point as its {level, value} payload — value is a shade hex, the
 *  contrast sentinel, or "none". Coordinate-based, so pointer capture doesn't
 *  blind it. */
function laneTargetAt(x: number, y: number, within: (el: HTMLElement) => boolean): { level: PaintLevel; value: string } | null {
  const el = document.elementFromPoint(x, y)?.closest("[data-lane-level]");
  if (!(el instanceof HTMLElement) || !within(el)) return null;
  return { level: el.dataset.laneLevel as PaintLevel, value: el.dataset.laneValue! };
}

const DRAG_HINT = " — drag onto another column to repaint just this color";

/** THE paint lane — one shared palette for both paint properties. Each column
 *  is a hue family with two LEVELS: the top half paints the family's armed
 *  STROKE shade, the bottom half its armed FILL shade (independent rungs; the
 *  disc face shows both). Column 0 holds the level specials — adaptive ink
 *  (stroke-only) over "no fill". The halves are the selection's editable
 *  declaration (round-28 grammar, per level): every class present highlights,
 *  clicking a half repaints the whole selection, dragging a highlighted half
 *  onto another column of the SAME level merges just that class. Right-click /
 *  long-press a family half opens its 5-rung shade strip — a changer-picker
 *  that retunes the column durably; mid-drag, hovering a family half pops the
 *  strip so merges can land on exact rungs. */
function PaintLane({
  strokeShades,
  fillShades,
  strokeActive,
  fillActive,
  mergeable,
  onStroke,
  onFillPick,
  onShade,
  onRecolor,
  onRefill,
}: {
  strokeShades: Record<HueFamily, string>;
  fillShades: Record<HueFamily, string>;
  /** Stroke declaration: exact values present on the selection (the contrast
   *  sentinel included), or the ambient ink when nothing is selected. */
  strokeActive: readonly string[];
  /** Fill declaration (null = none), same contract. */
  fillActive: readonly (string | null)[];
  /** Whether drag-merge is armed — i.e. a selection exists to retarget. */
  mergeable: boolean;
  onStroke: (c: string) => void;
  onFillPick: (c: string | null) => void;
  onShade: (level: PaintLevel, family: HueFamily, shade: string) => void;
  onRecolor: (from: string, to: string) => void;
  onRefill: (from: string | null, to: string | null) => void;
}) {
  const pillRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // The press being watched: promoted to a drag past 5px (when draggable),
  // promoted to the shade strip when HELD still for 500ms (family halves).
  const pressRef = useRef<{ level: PaintLevel; from: string; x: number; y: number; started: boolean; draggable: boolean } | null>(null);
  // A finished drag/long-press still fires a click on the source button —
  // swallow exactly that one so it doesn't ALSO repaint the selection.
  const suppressClickRef = useRef(false);
  const holdRef = useRef<number | null>(null);
  const hoverRef = useRef<{ key: string; timer: number } | null>(null);
  const [drag, setDrag] = useState<{ level: PaintLevel; from: string; x: number; y: number; over: string | null } | null>(null);
  const [strip, setStrip] = useState<{ level: PaintLevel; family: HueFamily; x: number; y: number } | null>(null);

  // Column 0 = the specials; then the families.
  const cols: (HueFamily | null)[] = [null, ...HUE_FAMILIES];
  const isTopActive = (f: HueFamily | null) => (f === null ? strokeActive.includes(CONTRAST_INK) : strokeActive.some((c) => familyOf(c) === f));
  const isBotActive = (f: HueFamily | null) => (f === null ? fillActive.includes(null) : fillActive.some((c) => c !== null && familyOf(c) === f));
  /** The exact CLASS a drag from this half carries (the declaration's own
   *  value — it can sit on a different rung than the armed lane shade). */
  const topFrom = (f: HueFamily | null) => (f === null ? CONTRAST_INK : (strokeActive.find((c) => familyOf(c) === f) ?? strokeShades[f]));
  const botFrom = (f: HueFamily | null) => (f === null ? "none" : (fillActive.find((c): c is string => c !== null && familyOf(c) === f) ?? fillShades[f]));
  const topIdxs = cols.map((f, i) => (isTopActive(f) ? i : -1)).filter((i) => i >= 0);
  const botIdxs = cols.map((f, i) => (isBotActive(f) ? i : -1)).filter((i) => i >= 0);

  const clearHold = () => {
    if (holdRef.current !== null) {
      clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  };
  const clearHover = () => {
    if (hoverRef.current) {
      clearTimeout(hoverRef.current.timer);
      hoverRef.current = null;
    }
  };
  const within = (el: HTMLElement) => (pillRef.current?.contains(el) ?? false) || (stripRef.current?.contains(el) ?? false);
  const openStrip = (level: PaintLevel, family: HueFamily, cell: HTMLElement) => {
    const pill = pillRef.current?.getBoundingClientRect();
    const r = cell.getBoundingClientRect();
    setStrip({ level, family, x: r.left + r.width / 2, y: pill?.top ?? r.top });
  };

  // The strip dismisses like a menu: outside press or Escape (captured before
  // the editor's own Esc ladder).
  useEffect(() => {
    if (!strip) return;
    const down = (e: PointerEvent) => {
      if (stripRef.current?.contains(e.target as Node)) return;
      setStrip(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setStrip(null);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [strip]);

  const onHalfDown = (e: React.PointerEvent<HTMLButtonElement>, level: PaintLevel, f: HueFamily | null, from: string, draggable: boolean) => {
    suppressClickRef.current = false; // every press starts clean
    if (e.button !== 0) return; // right button → the contextmenu path
    clearHold();
    if (f) {
      // Long-press = the touch path to the shade strip (mouse has right-click).
      const cell = e.currentTarget;
      holdRef.current = window.setTimeout(() => {
        holdRef.current = null;
        pressRef.current = null;
        suppressClickRef.current = true; // the release click must not paint
        openStrip(level, f, cell);
      }, 500);
    }
    pressRef.current = { level, from, x: e.clientX, y: e.clientY, started: false, draggable };
    if (draggable) e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHalfMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const p = pressRef.current;
    if (!p || (!p.started && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5)) return;
    clearHold(); // real movement — not a long-press
    if (!p.draggable) {
      pressRef.current = null;
      return;
    }
    p.started = true;
    const t = laneTargetAt(e.clientX, e.clientY, within);
    const over = t && t.level === p.level && t.value.toLowerCase() !== p.from.toLowerCase() ? `${t.level}:${t.value}` : null;
    setDrag({ level: p.level, from: p.from, x: e.clientX, y: e.clientY, over });
    // Hovering a FAMILY half of the same level pops its strip, so the merge
    // can land on an exact rung.
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-lane-family]");
    const fam = el instanceof HTMLElement && pillRef.current?.contains(el) && el.dataset.laneLevel === p.level ? (el.dataset.laneFamily as HueFamily) : null;
    const key = fam ? `${p.level}:${fam}` : null;
    if (hoverRef.current?.key !== key) {
      clearHover();
      if (key && fam && el instanceof HTMLElement) {
        hoverRef.current = {
          key,
          timer: window.setTimeout(() => {
            hoverRef.current = null;
            openStrip(p.level, fam, el);
          }, 400),
        };
      }
    }
  };
  const onHalfUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    clearHold();
    clearHover();
    const p = pressRef.current;
    pressRef.current = null;
    if (!p?.started) return; // sub-threshold press → the click event paints
    suppressClickRef.current = true;
    setDrag(null);
    setStrip(null); // a completed drag always puts the strip away
    const t = laneTargetAt(e.clientX, e.clientY, within);
    if (t && t.level === p.level && t.value.toLowerCase() !== p.from.toLowerCase()) {
      if (p.level === "stroke") onRecolor(p.from, t.value);
      else onRefill(p.from === "none" ? null : p.from, t.value === "none" ? null : t.value);
    }
  };
  const onHalfCancel = () => {
    clearHold();
    clearHover();
    pressRef.current = null;
    setDrag(null);
  };

  const halfClass = (level: PaintLevel, value: string, draggable: boolean, isSource: boolean) =>
    `relative z-20 h-[19px] w-[30px] touch-none ${level === "stroke" ? "rounded-t-[14px] rounded-b-[4px]" : "rounded-b-[14px] rounded-t-[4px]"} ${
      draggable ? "cursor-grab" : ""
    } ${drag && drag.over === `${level}:${value}` ? "ring-2 ring-accent-400" : ""} ${drag && isSource ? "opacity-40" : ""}`;
  const wellBase =
    "pointer-events-none absolute left-0.5 h-[19px] w-[30px] bg-accent-600/25 ring-1 ring-inset ring-accent-500/40 [transition:transform_300ms_cubic-bezier(0.34,1.3,0.64,1)]";
  const cap = (f: HueFamily) => f[0].toUpperCase() + f.slice(1);

  return (
    <div ref={pillRef} className="relative flex items-stretch rounded-[16px] border border-ink-600 bg-ink-800 p-0.5">
      {/* Declaration wells, per level: exactly one highlight keeps the
          signature slide; a multi-class declaration renders static wells. */}
      {(
        [
          { idxs: topIdxs, pos: "top-0.5", round: "rounded-t-[14px] rounded-b-[4px]" },
          { idxs: botIdxs, pos: "bottom-0.5", round: "rounded-b-[14px] rounded-t-[4px]" },
        ] as const
      ).map(({ idxs, pos, round }, lvl) =>
        idxs.length === 1 ? (
          <span key={lvl} aria-hidden className={`${wellBase} ${pos} ${round}`} style={{ transform: `translateX(${idxs[0] * 100}%)` }} />
        ) : (
          idxs.map((i) => <span key={`${lvl}:${i}`} aria-hidden className={`${wellBase} ${pos} ${round}`} style={{ transform: `translateX(${i * 100}%)` }} />)
        )
      )}
      {cols.map((f) => {
        const topValue = f === null ? CONTRAST_INK : strokeShades[f];
        const botValue = f === null ? "none" : fillShades[f];
        const topDraggable = mergeable && isTopActive(f);
        const botDraggable = mergeable && isBotActive(f);
        const topSource = !!drag && drag.level === "stroke" && drag.from.toLowerCase() === topFrom(f).toLowerCase();
        const botSource = !!drag && drag.level === "fill" && drag.from.toLowerCase() === botFrom(f).toLowerCase();
        return (
          <div key={f ?? "specials"} className="relative flex w-[30px] flex-col">
            {/* The two-level face: round top half = armed stroke shade (stroke
                is a dot), squarish bottom half = armed fill shade (fill is a
                chip — matches the drag ghost / strip rung grammar; specials:
                adaptive ink over no-fill). */}
            <span
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-t-full rounded-b border border-ink-500"
              style={{
                background: `linear-gradient(to bottom, ${f === null ? "#f5f5f5" : strokeShades[f]} 0%, ${f === null ? "#f5f5f5" : strokeShades[f]} 50%, ${
                  f === null ? "transparent" : fillShades[f]
                } 50%, ${f === null ? "transparent" : fillShades[f]} 100%)`,
              }}
            />
            {f === null && (
              // The no-fill glyph: a slash across the bottom hemisphere only.
              <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-[10px] w-5 -translate-x-1/2 overflow-hidden">
                <span className="absolute left-1/2 top-[3px] h-[1.5px] w-6 -translate-x-1/2 rotate-[20deg] bg-red-400/80" />
              </span>
            )}
            <button
              type="button"
              data-lane-level="stroke"
              data-lane-value={topValue}
              {...(f ? { "data-lane-family": f } : {})}
              aria-label={f === null ? "Adaptive ink — always contrasts the background (`)" : `Stroke ${f} ${strokeShades[f]}`}
              aria-pressed={isTopActive(f)}
              title={
                (f === null
                  ? "Adaptive — always contrasts what's behind it (` cycles color)"
                  : `${cap(f)} stroke ${strokeShades[f]} — right-click for shades (\` cycles color, ⌥\` shade)`) +
                (topDraggable ? DRAG_HINT : "")
              }
              onPointerDown={(e) => onHalfDown(e, "stroke", f, topFrom(f), topDraggable)}
              onPointerMove={onHalfMove}
              onPointerUp={onHalfUp}
              onPointerCancel={onHalfCancel}
              onContextMenu={(e) => {
                e.preventDefault();
                if (f) openStrip("stroke", f, e.currentTarget);
              }}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onStroke(topValue);
              }}
              className={halfClass("stroke", topValue, topDraggable, topSource)}
            />
            <button
              type="button"
              data-lane-level="fill"
              data-lane-value={botValue}
              {...(f ? { "data-lane-family": f } : {})}
              aria-label={f === null ? "No fill" : `Fill ${f} ${fillShades[f]}`}
              aria-pressed={isBotActive(f)}
              title={
                (f === null ? "No fill (⇧` cycles fill)" : `${cap(f)} fill ${fillShades[f]} — right-click for shades (⇧\` cycles fill, ⌥⇧\` shade)`) +
                (botDraggable ? DRAG_HINT : "")
              }
              onPointerDown={(e) => onHalfDown(e, "fill", f, botFrom(f), botDraggable)}
              onPointerMove={onHalfMove}
              onPointerUp={onHalfUp}
              onPointerCancel={onHalfCancel}
              onContextMenu={(e) => {
                e.preventDefault();
                if (f) openStrip("fill", f, e.currentTarget);
              }}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onFillPick(botValue === "none" ? null : botValue);
              }}
              className={halfClass("fill", botValue, botDraggable, botSource)}
            />
          </div>
        );
      })}
      {/* The carried class rides the pointer — portaled to body so the
          toolbar's container-type (layout containment = it would become this
          fixed element's containing block) can't trap it. */}
      {drag &&
        createPortal(
          <span
            aria-hidden
            className="pointer-events-none fixed z-[100] -translate-x-1/2 -translate-y-1/2 scale-125 drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
            style={{ left: drag.x, top: drag.y }}
          >
            {drag.level === "stroke" ? (
              <span
                className="block h-[14px] w-[14px] rounded-full border border-ink-500"
                style={{ backgroundColor: drag.from === CONTRAST_INK ? "#f5f5f5" : drag.from }}
              />
            ) : drag.from === "none" ? (
              <span className="relative block h-3 w-3 overflow-hidden rounded border border-ink-400">
                <span className="absolute left-1/2 top-1/2 h-[1.5px] w-5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-red-400/80" />
              </span>
            ) : (
              <span className="block h-3 w-3 rounded border border-ink-500" style={{ backgroundColor: drag.from }} />
            )}
          </span>,
          document.body
        )}
      {/* The shade strip — a changer-picker for one family × one level. Fixed +
          portaled (the toolbar's containment again), anchored above the lane.
          Its rungs are drop targets too (data-lane-*). */}
      {strip &&
        createPortal(
          <div
            ref={stripRef}
            className="fixed z-[100] flex -translate-x-1/2 flex-col gap-1 rounded-xl border border-ink-500 bg-ink-800 p-1 shadow-[0_4px_16px_rgba(0,0,0,0.5)]"
            style={{ left: strip.x, bottom: window.innerHeight - strip.y + 6 }}
          >
            {SHADES[strip.family].map((shade) => {
              const current = (strip.level === "stroke" ? strokeShades : fillShades)[strip.family] === shade;
              return (
                <button
                  key={shade}
                  type="button"
                  data-lane-level={strip.level}
                  data-lane-value={shade}
                  aria-label={`${strip.level === "stroke" ? "Stroke" : "Fill"} ${strip.family} shade ${shade}`}
                  aria-pressed={current}
                  title={shade}
                  // The strip lives in a body portal — OUTSIDE the board root.
                  // A default pointerdown would move focus there and the
                  // board would go keyboard-dead (Esc, ⌘A, the ` keys). Menus
                  // don't take focus:
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onShade(strip.level, strip.family, shade);
                    setStrip(null);
                  }}
                  className={`flex h-7 w-7 items-center justify-center rounded-lg ${current ? "bg-accent-600/25 ring-1 ring-inset ring-accent-500/40" : ""} ${
                    drag && drag.over === `${strip.level}:${shade}` ? "ring-2 ring-accent-400" : ""
                  }`}
                >
                  {strip.level === "stroke" ? (
                    <span className="h-[18px] w-[18px] rounded-full border border-ink-500" style={{ backgroundColor: shade }} />
                  ) : (
                    <span className="h-4 w-4 rounded border border-ink-500" style={{ backgroundColor: shade }} />
                  )}
                </button>
              );
            })}
          </div>,
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
  strokeShades,
  fillShades,
  strokeWidth,
  strokeStyle,
  sizeStep = null,
  hasSelection,
  groupAction,
  onGroup,
  canUndo,
  canRedo,
  onTool,
  onArmCluster,
  onColor,
  onFill,
  onShade,
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
  /** The lane's highlighted stroke DECLARATION: every stroke color present on
   *  the selection (multi while mixed), or just the ambient pen ink. */
  colors: readonly string[];
  /** The lane's fill declaration (null = none), same contract as `colors`. */
  fills: readonly (string | null)[];
  /** The lane's ARMED shade per hue family, per level (what each column's
   *  halves paint — see PaintLane / DrawState.strokeShades). */
  strokeShades: Record<HueFamily, string>;
  fillShades: Record<HueFamily, string>;
  /** The width the size dots display (the selection's own when it has one). */
  strokeWidth: number;
  /** The armed stroke style (solid/dashed/dotted) — the 4 key cycles it. */
  strokeStyle: StrokeStyle;
  /** Scale mode: the selected group's / lone image's size-control step (0 =
   *  natural "medium"), or null for stroke mode. The dots then read the unit's
   *  position — mid resets, extremes step — instead of stroke widths. */
  sizeStep?: number | null;
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
  /** A fill half was pressed (null = none; also refills the selection). */
  onFill: (c: string | null) => void;
  /** A shade-strip rung was picked: retune `family`'s armed shade at `level`
   *  (the changer-picker — see the setShade action). */
  onShade: (level: "stroke" | "fill", family: HueFamily, shade: string) => void;
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
      {/* The paint lane — ONE shared palette for stroke + fill: hue-family
          columns with the stroke level on top and the fill level below, the
          specials (adaptive ink / no fill) sharing column 0. See PaintLane. */}
      <PaintLane
        strokeShades={strokeShades}
        fillShades={fillShades}
        strokeActive={colors}
        fillActive={fills}
        mergeable={hasSelection}
        onStroke={onColor}
        onFillPick={onFill}
        onShade={onShade}
        onRecolor={onRecolor}
        onRefill={onRefill}
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

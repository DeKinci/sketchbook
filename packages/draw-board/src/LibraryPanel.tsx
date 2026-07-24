/**
 * The element library sidebar — a square-tile showcase grid of reusable
 * elements docked to the board's right edge (opt-in via DrawEditor's `library`
 * prop; the host owns + persists the entries, shared across drawings).
 *
 * Interactions (one unified pointer model — the drags cross the Konva↔DOM
 * boundary a DOM-only DnD lib like dnd-kit can't own, so a focused pointer
 * state machine drives all three):
 *  - **Drag a board selection IN** — a live board move gesture crossing the
 *    panel (the drop never reaches Konva; the panel gets the mouse events)
 *    shows the element MINIATURIZED at the hovered slot and drops it there
 *    (`onDropFromBoard(index)`); the board move is aborted (`boardDrag.cancel`,
 *    wired host-side) so the source shapes stay put — a capture is a copy.
 *  - **Reorder IN PLACE** — dragging a tile within the panel shows it slotting
 *    at the hovered position; release commits `moveEntry`.
 *  - **Drag a tile OUT** — once the pointer leaves the panel over the canvas
 *    the ghost becomes the FULL-SIZE element (board scale — it "materializes"
 *    at the size it will land), and release places a fresh copy (`onPlace`).
 *  - Right-click: delete an element / add a separator below it; rename or
 *    delete a separator (the horizontal group dividers).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addSeparatorAfter,
  elementPreviewUrl,
  moveEntry,
  removeEntry,
  renameSeparator,
  type LibraryElement,
  type LibraryEntry,
} from "./libraryModel.ts";

const DRAG_THRESHOLD = 4; // px of travel before a tile press becomes a drag
const GHOST_CAP = 480; // full-size drag-out ghost never exceeds this per side

interface MenuState {
  x: number;
  y: number;
  id: string;
  kind: "element" | "separator";
}

/** A live library-origin drag (reorder within the panel, or out onto the board). */
interface TileDrag {
  el: LibraryElement;
  x: number;
  y: number;
  live: boolean;
  mode: "reorder" | "out";
  /** Insertion slot among the OTHER entries (reorder mode). */
  index: number;
}

export function LibraryPanel({
  entries,
  onChange,
  boardDrag,
  onDropFromBoard,
  onPlace,
  boardScale,
  newId,
}: {
  entries: LibraryEntry[];
  onChange: (entries: LibraryEntry[]) => void;
  /** A board move gesture is live — the panel is an armed drop target; the
   *  preview URL renders the miniaturized slot at the hovered position. */
  boardDrag: { preview: string } | null;
  /** The live board drag released over the panel — capture it as an element at
   *  the given insertion index. */
  onDropFromBoard: (index: number) => void;
  /** A tile drag released at this client point — place a copy on the board. */
  onPlace: (el: LibraryElement, client: { x: number; y: number }) => void;
  /** Current board camera scale — sizes the full-size drag-out ghost. */
  boardScale: number;
  newId: () => string;
}) {
  const [over, setOver] = useState(false); // board drag hovering the panel
  const [boardIndex, setBoardIndex] = useState(entries.length);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tile, setTile] = useState<TileDrag | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const entryEls = useRef(new Map<string, HTMLElement>());

  // Esc closes the menu BEFORE the editor's own Esc ladder sees the key
  // (capture phase + stopPropagation — the board must not also clear its
  // selection on a menu dismiss).
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenu(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu]);

  // A board drag that ends (or never was) resets the hover state.
  useEffect(() => {
    if (!boardDrag) setOver(false);
  }, [boardDrag]);

  // Tile previews, recomputed only when the entries change (pure string build).
  const previews = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) if (e.kind === "element") m.set(e.id, elementPreviewUrl(e));
    return m;
  }, [entries]);

  /** Row-major insertion index for a client point, over the entries in order
   *  (optionally excluding one — the tile being reordered). */
  const insertionIndexAt = (clientX: number, clientY: number, excludeId?: string) => {
    const ids = entries.filter((e) => e.id !== excludeId).map((e) => e.id);
    for (let i = 0; i < ids.length; i++) {
      const node = entryEls.current.get(ids[i]);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const before = clientY < cy - r.height / 2 ? true : clientY > cy + r.height / 2 ? false : clientX < cx;
      if (before) return i;
    }
    return ids.length;
  };

  const insidePanel = (clientX: number, clientY: number) => {
    const r = asideRef.current?.getBoundingClientRect();
    return !!r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  };

  const closeMenu = () => setMenu(null);
  const armed = !!boardDrag && over;

  // ── The display list: entries with an insertion PLACEHOLDER spliced in ──────
  // Board drag-in and reorder both show a miniaturized preview at the hovered
  // slot; reorder additionally lifts the dragged tile out of the flow.
  const active = boardDrag && over
    ? { index: boardIndex, preview: boardDrag.preview, excludeId: undefined as string | undefined }
    : tile?.live && tile.mode === "reorder"
      ? { index: tile.index, preview: previews.get(tile.el.id) ?? "", excludeId: tile.el.id }
      : null;
  const base = active?.excludeId ? entries.filter((e) => e.id !== active.excludeId) : entries;
  const items: ({ entry: LibraryEntry } | { placeholder: string })[] = [];
  base.forEach((entry, i) => {
    if (active && active.index === i) items.push({ placeholder: active.preview });
    items.push({ entry });
  });
  if (active && active.index >= base.length) items.push({ placeholder: active.preview });

  return (
    <aside
      ref={asideRef}
      aria-label="Library elements"
      className={`relative z-20 flex w-64 shrink-0 flex-col overflow-y-auto border-l border-ink-600 bg-ink-900 ${
        armed ? "bg-accent-600/5 ring-1 ring-inset ring-accent-500/70" : ""
      }`}
      onMouseEnter={
        boardDrag
          ? (e) => {
              setOver(true);
              setBoardIndex(insertionIndexAt(e.clientX, e.clientY));
            }
          : undefined
      }
      onMouseMove={boardDrag ? (e) => setBoardIndex(insertionIndexAt(e.clientX, e.clientY)) : undefined}
      onMouseLeave={boardDrag ? () => setOver(false) : undefined}
      onMouseUp={
        boardDrag
          ? (e) => {
              setOver(false);
              onDropFromBoard(insertionIndexAt(e.clientX, e.clientY));
            }
          : undefined
      }
      // Tile drag runs on the ASIDE (pointer capture lives here, not on the
      // tile): the dragged tile leaves the grid flow while reordering, so its
      // own node unmounts — capturing on the stable panel keeps the gesture.
      onPointerMove={(e) => {
        if (!dragStart.current) return;
        const live = Math.hypot(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y) > DRAG_THRESHOLD;
        setTile((d) => {
          if (!d) return d;
          const inside = insidePanel(e.clientX, e.clientY);
          return {
            ...d,
            x: e.clientX,
            y: e.clientY,
            live: d.live || live,
            mode: inside ? "reorder" : "out",
            index: inside ? insertionIndexAt(e.clientX, e.clientY, d.el.id) : d.index,
          };
        });
      }}
      onPointerUp={(e) => {
        const start = dragStart.current;
        const d = tile;
        dragStart.current = null;
        setTile(null);
        if (!d || !start) return;
        const live = d.live || Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_THRESHOLD;
        if (!live) return;
        if (insidePanel(e.clientX, e.clientY)) onChange(moveEntry(entries, d.el.id, insertionIndexAt(e.clientX, e.clientY, d.el.id)));
        else onPlace(d.el, { x: e.clientX, y: e.clientY });
      }}
      onPointerCancel={() => {
        dragStart.current = null;
        setTile(null);
      }}
    >
      <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-500">Library</div>
      <div className="grid grid-cols-3 content-start gap-2 p-2 pt-1">
        {items.map((item, i) =>
          "placeholder" in item ? (
            <div
              key={`slot-${i}`}
              aria-label="Insertion slot"
              className="flex aspect-square items-center justify-center overflow-hidden rounded-md border-2 border-dashed border-accent-500/70 bg-accent-600/10 p-1"
            >
              {item.placeholder && <img src={item.placeholder} alt="" className="h-full w-full object-contain opacity-70" />}
            </div>
          ) : item.entry.kind === "separator" ? (
            <div
              key={item.entry.id}
              ref={(n) => {
                const e = item.entry;
                if (n) entryEls.current.set(e.id, n);
                else entryEls.current.delete(e.id);
              }}
              role="separator"
              className="col-span-full flex items-center gap-2 py-0.5"
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: item.entry.id, kind: "separator" });
              }}
            >
              <div className="h-px flex-1 bg-ink-600" />
              {renaming === item.entry.id ? (
                <input
                  autoFocus
                  defaultValue={item.entry.label ?? ""}
                  aria-label="Separator label"
                  className="w-20 rounded border border-ink-500 bg-ink-800 px-1 py-0.5 text-[10px] text-ink-200 outline-none"
                  onKeyDown={(e) => {
                    e.stopPropagation(); // keep typing away from the board's hotkeys
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") {
                      setRenaming(null);
                      e.preventDefault();
                    }
                  }}
                  onBlur={(e) => {
                    if (renaming === item.entry.id) onChange(renameSeparator(entries, item.entry.id, e.target.value));
                    setRenaming(null);
                  }}
                />
              ) : (
                item.entry.label && <span className="max-w-24 truncate text-[10px] uppercase tracking-wide text-ink-400">{item.entry.label}</span>
              )}
              {(item.entry.label || renaming === item.entry.id) && <div className="h-px flex-1 bg-ink-600" />}
            </div>
          ) : (
            <div
              key={item.entry.id}
              ref={(n) => {
                const e = item.entry;
                if (n) entryEls.current.set(e.id, n);
                else entryEls.current.delete(e.id);
              }}
              aria-label="Library element"
              className="group relative aspect-square cursor-grab touch-none select-none overflow-hidden rounded-md border border-ink-600 bg-ink-800/60 p-1 transition-colors hover:border-ink-400 active:cursor-grabbing"
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: item.entry.id, kind: "element" });
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                const el = item.entry as LibraryElement;
                e.preventDefault(); // no text selection / native image drag
                // Capture on the ASIDE, not the tile — the tile unmounts while
                // reordering (excluded from the grid), which would drop capture.
                asideRef.current?.setPointerCapture(e.pointerId);
                dragStart.current = { x: e.clientX, y: e.clientY };
                setTile({ el, x: e.clientX, y: e.clientY, live: false, mode: "reorder", index: entries.findIndex((x) => x.id === el.id) });
              }}
            >
              <img src={previews.get(item.entry.id)} alt="" draggable={false} className="h-full w-full object-contain" />
            </div>
          )
        )}
      </div>
      {entries.length === 0 && !boardDrag && (
        <div className="px-3 py-1 text-[11px] leading-snug text-ink-500">
          Drag a shape or group here to save it as a reusable element.
        </div>
      )}

      {/* Drag ghost — portaled (fixed coords must escape transformed hosts).
          Reorder: a small chip trailing the cursor (the slot preview already
          shows placement). Out: the FULL-SIZE element at board scale, so it
          reads as materializing at the size it will land. */}
      {tile?.live &&
        (() => {
          const url = previews.get(tile.el.id);
          if (tile.mode === "out") {
            const gs = Math.min(boardScale, GHOST_CAP / tile.el.width, GHOST_CAP / tile.el.height);
            const w = Math.max(24, tile.el.width * gs);
            const h = Math.max(24, tile.el.height * gs);
            return createPortal(
              <img
                src={url}
                alt=""
                className="pointer-events-none fixed z-[70] object-contain opacity-80 drop-shadow-xl"
                style={{ left: tile.x - w / 2, top: tile.y - h / 2, width: w, height: h }}
              />,
              document.body
            );
          }
          return createPortal(
            <img
              src={url}
              alt=""
              className="pointer-events-none fixed z-[70] h-14 w-14 rounded-md border border-ink-500 bg-ink-900/80 object-contain p-1 opacity-80"
              style={{ left: tile.x + 10, top: tile.y + 10 }}
            />,
            document.body
          );
        })()}

      {/* Context menu — portaled for the same reason; closes on any outside press. */}
      {menu &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[70]" onPointerDown={closeMenu} onContextMenu={(e) => e.preventDefault()} />
            <div
              role="menu"
              className="fixed z-[71] min-w-36 rounded-md border border-ink-600 bg-ink-800 py-1 text-xs text-ink-200 shadow-xl"
              style={{
                left: Math.min(menu.x, (window.innerWidth || 0) - 160),
                top: Math.min(menu.y, (window.innerHeight || 0) - 96),
              }}
            >
              {menu.kind === "element" && (
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left transition-colors hover:bg-ink-700"
                  onClick={() => {
                    onChange(addSeparatorAfter(entries, menu.id, newId()));
                    closeMenu();
                  }}
                >
                  Add separator below
                </button>
              )}
              {menu.kind === "separator" && (
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left transition-colors hover:bg-ink-700"
                  onClick={() => {
                    setRenaming(menu.id);
                    closeMenu();
                  }}
                >
                  Rename
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-1.5 text-left text-red-400 transition-colors hover:bg-ink-700"
                onClick={() => {
                  onChange(removeEntry(entries, menu.id));
                  closeMenu();
                }}
              >
                Delete
              </button>
            </div>
          </>,
          document.body
        )}
    </aside>
  );
}

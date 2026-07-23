/**
 * The element library sidebar — a square-tile showcase grid of reusable
 * elements docked to the board's right edge (opt-in via DrawEditor's `library`
 * prop; the host owns + persists the entries, shared across drawings).
 *
 * Interactions:
 *  - A live board move gesture released over the panel ADDS the dragged
 *    selection as an element (the board drop never reaches Konva — the panel
 *    receives the mouseup itself and aborts the move via `boardDrag.cancel`).
 *  - Dragging a tile out drops a fresh copy on the canvas (`onPlace` — a
 *    pointer-capture drag, so the stage never sees the crossing pointer).
 *  - Right-click opens the context menu: delete an element / add a separator
 *    below it; rename or delete a separator (the horizontal group dividers).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addSeparatorAfter,
  elementPreviewUrl,
  removeEntry,
  renameSeparator,
  type LibraryElement,
  type LibraryEntry,
} from "./libraryModel.ts";

const DRAG_THRESHOLD = 4; // px of pointer travel before a tile press becomes a place-drag

interface MenuState {
  x: number;
  y: number;
  id: string;
  kind: "element" | "separator";
}

export function LibraryPanel({
  entries,
  onChange,
  boardDrag,
  onDropFromBoard,
  onPlace,
  newId,
}: {
  entries: LibraryEntry[];
  onChange: (entries: LibraryEntry[]) => void;
  /** A board move gesture is live (the panel is an armed drop target). */
  boardDrag: boolean;
  /** The live board drag released over the panel — capture it as an element. */
  onDropFromBoard: () => void;
  /** A tile drag released at this client point — place a copy on the board. */
  onPlace: (el: LibraryElement, client: { x: number; y: number }) => void;
  newId: () => string;
}) {
  const [over, setOver] = useState(false); // board drag hovering the panel
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ el: LibraryElement; x: number; y: number; live: boolean } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

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

  // Tile previews, recomputed only when the entries change (pure string build).
  const previews = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) if (e.kind === "element") m.set(e.id, elementPreviewUrl(e));
    return m;
  }, [entries]);

  const closeMenu = () => setMenu(null);

  const armed = boardDrag && over;

  return (
    <aside
      aria-label="Library elements"
      className={`relative z-20 flex w-44 shrink-0 flex-col overflow-y-auto border-l border-ink-600 bg-ink-900 ${
        armed ? "bg-accent-600/5 ring-1 ring-inset ring-accent-500/70" : ""
      }`}
      onMouseEnter={boardDrag ? () => setOver(true) : undefined}
      onMouseLeave={boardDrag ? () => setOver(false) : undefined}
      onMouseUp={
        boardDrag
          ? () => {
              setOver(false);
              onDropFromBoard();
            }
          : undefined
      }
    >
      <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-500">Library</div>
      <div className="grid grid-cols-2 content-start gap-2 p-2 pt-1">
        {entries.map((entry) =>
          entry.kind === "separator" ? (
            <div
              key={entry.id}
              role="separator"
              className="col-span-full flex items-center gap-2 py-0.5"
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: entry.id, kind: "separator" });
              }}
            >
              <div className="h-px flex-1 bg-ink-600" />
              {renaming === entry.id ? (
                <input
                  autoFocus
                  defaultValue={entry.label ?? ""}
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
                    if (renaming === entry.id) onChange(renameSeparator(entries, entry.id, e.target.value));
                    setRenaming(null);
                  }}
                />
              ) : (
                entry.label && <span className="max-w-24 truncate text-[10px] uppercase tracking-wide text-ink-400">{entry.label}</span>
              )}
              {(entry.label || renaming === entry.id) && <div className="h-px flex-1 bg-ink-600" />}
            </div>
          ) : (
            <div
              key={entry.id}
              aria-label="Library element"
              className="group relative aspect-square cursor-grab touch-none select-none overflow-hidden rounded-md border border-ink-600 bg-ink-800/60 p-1 transition-colors hover:border-ink-400 active:cursor-grabbing"
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: entry.id, kind: "element" });
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault(); // no text selection / native image drag
                e.currentTarget.setPointerCapture(e.pointerId);
                dragStart.current = { x: e.clientX, y: e.clientY };
                setDrag({ el: entry, x: e.clientX, y: e.clientY, live: false });
              }}
              onPointerMove={(e) => {
                if (!dragStart.current) return;
                const dx = e.clientX - dragStart.current.x;
                const dy = e.clientY - dragStart.current.y;
                setDrag((d) =>
                  d ? { ...d, x: e.clientX, y: e.clientY, live: d.live || Math.hypot(dx, dy) > DRAG_THRESHOLD } : d
                );
              }}
              onPointerUp={(e) => {
                const start = dragStart.current;
                const d = drag;
                dragStart.current = null;
                setDrag(null);
                if (!d || !start) return;
                // Judge travel from the raw event too — a flick can outrun the
                // state commit of its last pointermove.
                const live = d.live || Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_THRESHOLD;
                if (live) onPlace(d.el, { x: e.clientX, y: e.clientY });
              }}
              onPointerCancel={() => {
                dragStart.current = null;
                setDrag(null);
              }}
            >
              <img src={previews.get(entry.id)} alt="" draggable={false} className="h-full w-full object-contain" />
            </div>
          )
        )}
        {boardDrag && (
          <div className="col-span-full rounded-md border border-dashed border-ink-500 p-2 text-center text-[11px] text-ink-400">
            Release to add
          </div>
        )}
      </div>
      {entries.length === 0 && !boardDrag && (
        <div className="px-3 py-1 text-[11px] leading-snug text-ink-500">
          Drag a shape or group here to save it as a reusable element.
        </div>
      )}

      {/* Place-drag ghost — portaled (fixed coords must escape transformed hosts). */}
      {drag?.live &&
        createPortal(
          <img
            src={previews.get(drag.el.id)}
            alt=""
            className="pointer-events-none fixed z-[70] h-16 w-16 rounded-md border border-ink-500 bg-ink-900/80 object-contain p-1"
            style={{ left: drag.x + 10, top: drag.y + 10 }}
          />,
          document.body
        )}

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

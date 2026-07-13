import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { DrawEditor } from "@operator/draw-board";
import {
  createDrawing,
  loadDrawings,
  renameDrawing,
  saveDrawings,
  updateDoc,
  type Drawing,
} from "./lib/drawings.ts";

/** One sidebar row: click selects, double-click renames in place. */
function DrawingRow({
  drawing,
  active,
  renaming,
  onSelect,
  onStartRename,
  onRename,
  onCancelRename,
}: {
  drawing: Drawing;
  active: boolean;
  renaming: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const [value, setValue] = useState(drawing.name);
  const committed = useRef(false);
  useEffect(() => {
    if (renaming) {
      setValue(drawing.name);
      committed.current = false;
    }
  }, [renaming, drawing.name]);

  if (renaming) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          if (!committed.current) onRename(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            committed.current = true;
            onRename(value);
          } else if (e.key === "Escape") {
            committed.current = true;
            onCancelRename();
          }
        }}
        aria-label={`Rename ${drawing.name}`}
        className="w-full rounded-md border border-accent-500 bg-ink-800 px-2 py-1.5 text-sm text-ink-100 outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onStartRename}
      title="Double-click to rename"
      className={`w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        active ? "bg-ink-600 text-ink-100" : "text-ink-300 hover:bg-ink-700 hover:text-ink-100"
      }`}
    >
      {drawing.name}
    </button>
  );
}

/**
 * Sketchbook: a drawings list on the left (create with +, double-click to
 * rename), the infinite drawing board on the right. Everything persists to
 * localStorage — the board's debounced onChange (plus its unmount flush)
 * writes through per drawing; there is no save button.
 */
export default function App() {
  const [drawings, setDrawings] = useState<Drawing[]>(() => {
    const loaded = loadDrawings();
    if (loaded.length) return loaded;
    const { list } = createDrawing([]); // an empty sketchbook opens on a fresh page
    saveDrawings(list);
    return list;
  });
  const [activeId, setActiveId] = useState<string>(() => drawings[0].id);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mutations go through a ref so the board's UNMOUNT flush (which outlives the
  // render that owned its onChange) still writes against the live list — and so
  // no setState updater carries side effects (StrictMode double-invokes them).
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const mutate = useCallback((up: (list: Drawing[]) => Drawing[]) => {
    const next = up(drawingsRef.current);
    if (next === drawingsRef.current) return;
    drawingsRef.current = next;
    saveDrawings(next);
    setDrawings(next);
  }, []);

  const addDrawing = useCallback(() => {
    const { list, created } = createDrawing(drawingsRef.current);
    drawingsRef.current = list;
    saveDrawings(list);
    setDrawings(list);
    setActiveId(created.id);
    setRenamingId(created.id); // a new page starts in rename — name it right away
  }, []);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const active = drawings.find((d) => d.id === activeId) ?? drawings[0];

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-ink-600 bg-ink-800">
        <div className="flex items-center justify-between border-b border-ink-600 px-3 py-2">
          <h1 className="text-sm font-semibold text-ink-100">Sketchbook</h1>
          <button
            type="button"
            onClick={addDrawing}
            aria-label="New drawing"
            title="New drawing"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-600 text-white transition-colors hover:bg-accent-500"
          >
            <Plus size={15} />
          </button>
        </div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {drawings.map((d) => (
            <DrawingRow
              key={d.id}
              drawing={d}
              active={d.id === active.id}
              renaming={d.id === renamingId}
              onSelect={() => setActiveId(d.id)}
              onStartRename={() => setRenamingId(d.id)}
              onRename={(name) => {
                mutate((list) => renameDrawing(list, d.id, name));
                setRenamingId(null);
              }}
              onCancelRename={() => setRenamingId(null)}
            />
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <DrawEditor
          key={active.id}
          doc={active.doc}
          bgImage={null}
          name={active.name}
          onChange={(doc) => mutate((list) => updateDoc(list, active.id, doc))}
          onNotify={notify}
          // A freshly created page mounts alongside its rename input — the board
          // must not steal the name's first keystrokes. (Read at mount only.)
          autoFocus={renamingId === null}
        />
      </main>

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-ink-500 bg-ink-700 px-4 py-2 text-sm text-ink-100 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

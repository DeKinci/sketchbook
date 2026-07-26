import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { DrawEditor, isLibraryFileName, mergeLibrary, parseBoardFile, parseLibraryFile, renderDocThumbnail, type BoardHandle, type DrawDoc, type DrawFeatures } from "@operator/draw-board";
import { ExportCluster } from "./ExportCluster.tsx";
import {
  createDrawing,
  displayOrder,
  importDrawing,
  loadDrawings,
  renameDrawing,
  saveDrawings,
  updateDoc,
  updateSession,
  type Drawing,
} from "./lib/drawings.ts";
import { loadLibrary, saveLibrary, type LibraryState } from "./lib/library.ts";

/** Decode an image file into a new ANNOTATION doc (the image as background). */
async function docFromImageFile(file: File): Promise<{ doc: DrawDoc; name: string } | null> {
  if (!file.type.startsWith("image/")) return null;
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error(`could not read ${file.name}`));
    r.onload = () => res(String(r.result ?? ""));
    r.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error(`could not decode ${file.name}`));
    img.src = dataUrl;
  });
  return {
    doc: {
      shapes: [],
      width: img.naturalWidth,
      height: img.naturalHeight,
      background: { dataBase64: dataUrl.slice(comma + 1), mediaType: file.type, width: img.naturalWidth, height: img.naturalHeight },
    },
    name: file.name.replace(/\.[a-z0-9]+$/i, "") || "Image",
  };
}

/** Decode the active doc's background raster (annotation boards). */
function useBgImage(doc: DrawDoc): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const bg = doc.background;
  useEffect(() => {
    if (!bg) {
      setImg(null);
      return;
    }
    let live = true;
    const el = new Image();
    el.onload = () => live && setImg(el);
    el.src = `data:${bg.mediaType};base64,${bg.dataBase64}`;
    return () => {
      live = false;
    };
  }, [bg]);
  return bg ? img : null;
}

/** Hover thumbnail — a fixed-position popover so the scrolling sidebar cannot
 *  clip it; rendered only while hovered (the thumbnail paints on mount). */
function RowPreview({ drawing, at }: { drawing: Drawing; at: { x: number; y: number } }) {
  const W = 208;
  const H = 138;
  const top = Math.min(at.y, window.innerHeight - H - 40);
  return (
    <div
      data-row-preview
      className="pointer-events-none fixed z-40 overflow-hidden rounded-lg border border-ink-500 bg-ink-800 shadow-2xl"
      style={{ left: at.x + 8, top }}
    >
      <canvas
        width={W}
        height={H}
        style={{ width: W, height: H, display: "block" }}
        ref={(el) => {
          if (el) void renderDocThumbnail(el, drawing.doc, { w: W, h: H });
        }}
      />
      <div className="truncate border-t border-ink-600 px-2 py-1 text-[11px] text-ink-300">{drawing.name}</div>
    </div>
  );
}

/** One sidebar row: click selects, double-click renames in place. */
function DrawingRow({
  drawing,
  active,
  renaming,
  onSelect,
  onStartRename,
  onRename,
  onCancelRename,
  onHover,
}: {
  drawing: Drawing;
  active: boolean;
  renaming: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  /** Hover in: report the row's screen rect for the preview popover. Null = out. */
  onHover: (at: { x: number; y: number } | null) => void;
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
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onHover({ x: r.right, y: r.top });
      }}
      onMouseLeave={() => onHover(null)}
      title="Double-click to rename"
      className={`w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        active ? "bg-ink-600 text-ink-100" : "text-ink-300 hover:bg-ink-700 hover:text-ink-100"
      }`}
    >
      {drawing.name}
    </button>
  );
}

/** Board feature config from the URL — a dev/test harness, no UI: ?palette=1..12
 *  widens/narrows the color lane, &fills=0 / &styling=0 / &grouping=0 /
 *  &layers=0 / &vectorEdit=0 / &paletteResize=0 opt those out, &shapes=pen,rect,text mounts only the
 *  listed shape tools (see {@link DrawFeatures} — unknown names are dropped by
 *  resolveFeatures). Absent params → the full default board. Read once at
 *  load; the board freezes its config at mount anyway. */
function featuresFromUrl(): Partial<DrawFeatures> | undefined {
  const q = new URLSearchParams(window.location.search);
  const out: Partial<DrawFeatures> = {};
  const palette = q.get("palette");
  if (palette !== null) out.paletteSize = Number(palette);
  const flag = (param: string, key: "fills" | "strokeStyling" | "grouping" | "paletteResize" | "layers" | "vectorEdit") => {
    const v = q.get(param);
    if (v !== null) out[key] = v !== "0" && v !== "false";
  };
  flag("fills", "fills");
  flag("styling", "strokeStyling");
  flag("grouping", "grouping");
  flag("paletteResize", "paletteResize");
  flag("layers", "layers");
  flag("vectorEdit", "vectorEdit");
  const shapes = q.get("shapes");
  if (shapes !== null && shapes.trim() !== "") {
    out.shapes = shapes.split(",").map((s) => s.trim()) as DrawFeatures["shapes"];
  }
  return Object.keys(out).length ? out : undefined;
}
const URL_FEATURES = featuresFromUrl();

/**
 * Sketchbook: a drawings list on the left (create with +, double-click to
 * rename), the infinite drawing board on the right. Everything persists to
 * localStorage — the board's debounced onChange/onSessionChange (plus their
 * unmount flush) write through per drawing (the doc AND the toolbar +
 * selection session); there is no save button.
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

  // The element library — ONE shared collection across every drawing (its
  // entries and the panel's open state persist together; a page switch or
  // reload keeps both). Same ref-routed mutation shape as the drawings.
  const [library, setLibrary] = useState(loadLibrary);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const mutateLibrary = useCallback((up: (s: LibraryState) => LibraryState) => {
    const next = up(libraryRef.current);
    libraryRef.current = next;
    saveLibrary(next);
    setLibrary(next);
  }, []);

  // Drop a `.drawlib` ANYWHERE in the window → merge it into the library and
  // reveal the panel. Capture phase so it preempts the board/sidebar drop
  // handlers (which would try to read it as an image/board file); the global
  // dragover keeps the whole window a valid drop target.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const file = Array.from(e.dataTransfer?.files ?? []).find((f) => isLibraryFileName(f.name));
      if (!file) return; // not ours — let board/sidebar handle images & board files
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        const parsed = parseLibraryFile(await file.text());
        if (!parsed) {
          notify("Not a library file");
          return;
        }
        mutateLibrary((s) => ({ open: true, entries: mergeLibrary(s.entries, parsed) }));
        notify(`Imported ${parsed.length} item${parsed.length === 1 ? "" : "s"} into the library`);
      })();
    };
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [mutateLibrary, notify]);

  // Hover preview: which drawing, anchored where.
  const [preview, setPreview] = useState<{ id: string; at: { x: number; y: number } } | null>(null);

  // Import: a given doc becomes a NEW drawing (board files, image-backed pages).
  const addImported = useCallback((doc: DrawDoc, base: string) => {
    const { list, created } = importDrawing(drawingsRef.current, doc, base);
    drawingsRef.current = list;
    saveDrawings(list);
    setDrawings(list);
    setActiveId(created.id);
    return created;
  }, []);

  /** Sidebar drop: a board FILE imports as a board; a plain image becomes a new
   *  page with that image as its background. (Dropping over the BOARD instead
   *  adds the image on-board — that path lives in DrawEditor.) */
  const [listDrop, setListDrop] = useState(false);
  const onListDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setListDrop(false);
      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;
      void (async () => {
        let imported = 0;
        for (const file of files) {
          const boardDoc = await parseBoardFile(file);
          if (boardDoc) {
            addImported(boardDoc, file.name.replace(/\.[a-z0-9]+$/i, "") || "Imported board");
            imported++;
            continue;
          }
          try {
            const fromImage = await docFromImageFile(file);
            if (fromImage) {
              addImported(fromImage.doc, fromImage.name);
              imported++;
            }
          } catch (err) {
            notify(`Couldn't add ${file.name}: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (imported) notify(imported === 1 ? "New drawing created" : `${imported} drawings created`);
      })();
    },
    [addImported, notify]
  );

  const boardRef = useRef<BoardHandle | null>(null);

  const active = drawings.find((d) => d.id === activeId) ?? drawings[0];
  const bgImage = useBgImage(active.doc);
  const bgPending = !!active.doc.background && !bgImage;

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
        <nav
          className={`min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2 transition-colors ${listDrop ? "bg-accent-900/30" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setListDrop(true);
          }}
          onDragLeave={() => setListDrop(false)}
          onDrop={onListDrop}
        >
          {displayOrder(drawings).map((d) => (
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
              onHover={(at) => setPreview(at ? { id: d.id, at } : null)}
            />
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        {bgPending ? (
          <div className="flex h-full items-center justify-center text-ink-400">
            <Loader2 className="animate-spin" size={22} />
          </div>
        ) : (
          <DrawEditor
            key={active.id}
            doc={active.doc}
            bgImage={bgImage}
            name={active.name}
            onChange={(doc) => mutate((list) => updateDoc(list, active.id, doc))}
            session={active.session}
            onSessionChange={(s) => mutate((list) => updateSession(list, active.id, s))}
            features={URL_FEATURES}
            onNotify={notify}
            minimap
            library={{
              entries: library.entries,
              onChange: (entries) => mutateLibrary((s) => ({ ...s, entries })),
              open: library.open,
              onOpenChange: (open) => mutateLibrary((s) => ({ ...s, open })),
            }}
            boardRef={boardRef}
            toolbarExtra={<ExportCluster board={boardRef} onNotify={notify} />}
            onImportBoard={(doc) => {
              addImported(doc, "Imported board");
              notify("Board imported");
            }}
            // A freshly created page mounts alongside its rename input — the board
            // must not steal the name's first keystrokes. (Read at mount only.)
            autoFocus={renamingId === null}
          />
        )}
      </main>

      {preview && (() => {
        const pd = drawings.find((d) => d.id === preview.id);
        return pd ? <RowPreview drawing={pd} at={preview.at} /> : null;
      })()}

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-ink-500 bg-ink-700 px-4 py-2 text-sm text-ink-100 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

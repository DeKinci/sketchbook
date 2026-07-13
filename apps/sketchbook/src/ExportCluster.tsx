import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, Download } from "lucide-react";
import { boardPayloadText, type BoardHandle } from "@operator/draw-board";

/** Trigger a browser download for a File. */
function download(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The sketchbook's export controls, injected into the board toolbar's far-right
 * slot: copy-as-PNG and download-as-PNG up front (rich — the file carries the
 * board doc and re-imports as a full board), plus a menu with the SVG flavors
 * and the "slim" (metadata-free) variants.
 */
export function ExportCluster({
  board,
  onNotify,
}: {
  board: React.RefObject<BoardHandle | null>;
  onNotify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const run = (label: string, fn: () => Promise<void>) => {
    setOpen(false);
    void fn()
      .then(() => onNotify(label))
      .catch((e) => onNotify(`Export failed: ${e instanceof Error ? e.message : e}`));
  };

  const copyPng = (rich: boolean) =>
    run(rich ? "Copied PNG (board embedded)" : "Copied PNG", async () => {
      const file = await board.current?.exportPng({ rich });
      if (!file) throw new Error("no board");
      // Chromium SANITIZES clipboard images (PNG chunks stripped) — a rich copy
      // pairs the image with the board payload as text/plain, so pasting back
      // into a board app restores the full board while external apps get pixels.
      const types: Record<string, Blob> = { "image/png": file };
      if (rich) {
        const doc = board.current?.getDoc();
        if (doc) types["text/plain"] = new Blob([boardPayloadText(doc)], { type: "text/plain" });
      }
      await navigator.clipboard.write([new ClipboardItem(types)]);
    });
  const downloadPng = (rich: boolean) =>
    run(rich ? "Downloaded PNG (board embedded)" : "Downloaded PNG", async () => {
      const file = await board.current?.exportPng({ rich });
      if (!file) throw new Error("no board");
      download(file);
    });
  const copySvg = (rich: boolean) =>
    run(rich ? "Copied SVG (board embedded)" : "Copied SVG", async () => {
      const file = board.current?.exportSvg({ rich });
      if (!file) throw new Error("no board");
      await navigator.clipboard.writeText(await file.text());
    });
  const downloadSvg = (rich: boolean) =>
    run(rich ? "Downloaded SVG (board embedded)" : "Downloaded SVG", async () => {
      const file = board.current?.exportSvg({ rich });
      if (!file) throw new Error("no board");
      download(file);
    });

  const chip =
    "flex h-8 items-center justify-center rounded-full border border-ink-500 bg-ink-700 text-ink-300 transition-colors hover:bg-ink-600 hover:text-white";

  return (
    <div className="relative flex items-center gap-1.5" ref={menuRef}>
      <button type="button" onClick={() => copyPng(true)} aria-label="Copy as PNG" title="Copy as PNG (re-importable)" className={`${chip} w-8`}>
        <Copy size={15} />
      </button>
      <button type="button" onClick={() => downloadPng(true)} aria-label="Download as PNG" title="Download as PNG (re-importable)" className={`${chip} w-8`}>
        <Download size={15} />
      </button>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="More export options"
        aria-expanded={open}
        title="More export options"
        className={`${chip} w-6`}
      >
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="absolute bottom-10 right-0 z-30 w-56 overflow-hidden rounded-lg border border-ink-500 bg-ink-700 py-1 text-sm text-ink-100 shadow-xl">
          {(
            [
              ["Download as SVG", () => downloadSvg(true)],
              ["Copy as SVG", () => copySvg(true)],
              ["Download PNG — slim", () => downloadPng(false)],
              ["Download SVG — slim", () => downloadSvg(false)],
              ["Copy PNG — slim", () => copyPng(false)],
            ] as const
          ).map(([label, fn]) => (
            <button key={label} type="button" onClick={fn} className="block w-full px-3 py-1.5 text-left transition-colors hover:bg-ink-600">
              {label}
            </button>
          ))}
          <div className="px-3 pb-1 pt-1.5 text-[11px] leading-snug text-ink-300">
            Slim files are pixels only — they can't be re-imported as boards.
          </div>
        </div>
      )}
    </div>
  );
}

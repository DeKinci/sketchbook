import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, Download } from "lucide-react";
import { boardPayloadText, type BoardHandle } from "markup-board";

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
      .then(() => label && onNotify(label))
      .catch((e) => onNotify(`Export failed: ${e instanceof Error ? e.message : e}`));
  };

  const makePng = async (rich: boolean) => {
    const file = await board.current?.exportPng({ rich });
    if (!file) throw new Error("no board");
    return file;
  };
  const makeSvg = (rich: boolean) => {
    const file = board.current?.exportSvg({ rich });
    if (!file) throw new Error("no board");
    return file;
  };

  const copyPng = (rich: boolean) => {
    setOpen(false);
    // Safari voids the user activation at the first await — the ClipboardItem
    // must be constructed SYNCHRONOUSLY inside the gesture, with PROMISES as
    // payloads. The export starts immediately and feeds both paths.
    const pngPromise: Promise<Blob> = makePng(rich);
    void (async () => {
      try {
        const types: Record<string, Blob | Promise<Blob>> = { "image/png": pngPromise };
        if (rich) {
          const doc = board.current?.getDoc();
          // Chromium sanitizes clipboard images (PNG chunks stripped) — the rich
          // copy pairs the pixels with the board payload as text/plain.
          if (doc) types["text/plain"] = new Blob([boardPayloadText(doc)], { type: "text/plain" });
        }
        await navigator.clipboard.write([new ClipboardItem(types as Record<string, Blob>)]);
        onNotify(rich ? "Copied PNG (board embedded)" : "Copied PNG");
      } catch {
        // Clipboard legitimately unavailable (insecure LAN context, Firefox's
        // partial ClipboardItem, denied permission) — never strand the export.
        try {
          download((await pngPromise) as File);
          onNotify("Clipboard unavailable here — downloaded instead");
        } catch (e) {
          onNotify(`Export failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    })();
  };

  const copySvg = (rich: boolean) => {
    setOpen(false);
    void (async () => {
      let file: File;
      try {
        file = makeSvg(rich);
      } catch (e) {
        onNotify(`Export failed: ${e instanceof Error ? e.message : e}`);
        return;
      }
      try {
        await navigator.clipboard.writeText(await file.text());
        onNotify(rich ? "Copied SVG (board embedded)" : "Copied SVG");
      } catch {
        download(file);
        onNotify("Clipboard unavailable here — downloaded instead");
      }
    })();
  };

  const downloadPng = (rich: boolean) =>
    run(rich ? "Downloaded PNG (board embedded)" : "Downloaded PNG", async () => {
      download(await makePng(rich));
    });
  const downloadSvg = (rich: boolean) =>
    run(rich ? "Downloaded SVG (board embedded)" : "Downloaded SVG", async () => {
      download(makeSvg(rich));
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
        <div data-export-menu className="absolute bottom-10 right-0 z-50 w-56 overflow-hidden rounded-lg border border-ink-500 bg-ink-700 py-1 text-sm text-ink-100 shadow-xl">
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

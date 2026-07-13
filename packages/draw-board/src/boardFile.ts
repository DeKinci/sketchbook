/**
 * Board-file interchange: rich exports carry the full doc inside the image
 * file (PNG iTXt chunk / SVG <metadata>), and any pasted/dropped file can be
 * probed for one — a rich file re-imports as a complete editable board.
 *
 * All OPT-IN capability: hosts that never call these (Operator's dock) ship
 * plain flattened PNGs exactly as before.
 */
import type Konva from "konva";
import type { DrawDoc } from "./drawModel.ts";
import { exportStagePng } from "./exportPng.ts";
import { BOARD_KEYWORD, embedPngText, isPng, readPngText } from "./pngMeta.ts";
import { exportSvg, readSvgDoc, type SvgExportOptions } from "./svgExport.ts";

const PAYLOAD_KIND = "draw-board";

function payload(doc: DrawDoc): string {
  return JSON.stringify({ v: 1, kind: PAYLOAD_KIND, doc });
}

function parsePayload(text: string | null): DrawDoc | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { kind?: string; doc?: DrawDoc };
    return parsed?.kind === PAYLOAD_KIND && parsed.doc && Array.isArray(parsed.doc.shapes) ? parsed.doc : null;
  } catch {
    return null;
  }
}

export interface BoardPngOptions {
  /** Embed the doc for re-import (default true). False = "slim", pixels only. */
  rich?: boolean;
  /** See exportStagePng — infinite boards export unclamped content crops. */
  clampCrop?: boolean;
}

/** Flatten the stage to PNG (same pipeline as the attachment flow) and, unless
 *  slim, embed the doc chunk. */
export async function exportBoardPng(stage: Konva.Stage, doc: DrawDoc, name: string, opts?: BoardPngOptions): Promise<File> {
  const flat = await exportStagePng(stage, doc, name, { clampCrop: opts?.clampCrop });
  if (opts?.rich === false) return flat;
  const bytes = new Uint8Array(await flat.arrayBuffer());
  const withDoc = embedPngText(bytes, BOARD_KEYWORD, payload(doc));
  return new File([withDoc as BufferSource], flat.name, { type: "image/png" });
}

/** Serialize to SVG (rich by default) as a File. */
export function exportBoardSvg(doc: DrawDoc, name: string, opts?: SvgExportOptions): File {
  const svg = exportSvg(doc, opts);
  const stem = name.replace(/\.[a-z0-9]+$/i, "") || "board";
  return new File([svg], `${stem}.svg`, { type: "image/svg+xml" });
}

/** Probe arbitrary bytes/text for an embedded board doc. Never throws. */
export function readBoardDocFromPngBytes(bytes: Uint8Array): DrawDoc | null {
  if (!isPng(bytes)) return null;
  return parsePayload(readPngText(bytes, BOARD_KEYWORD));
}

/** Probe a pasted/dropped file for a board doc (rich PNG or rich SVG). */
export async function parseBoardFile(file: Blob): Promise<DrawDoc | null> {
  try {
    if (file.type === "image/png" || file.type === "") {
      const doc = readBoardDocFromPngBytes(new Uint8Array(await file.arrayBuffer()));
      if (doc) return doc;
    }
    if (file.type === "image/svg+xml" || file.type === "" || file.type === "text/plain") {
      const text = await file.text();
      if (text.trimStart().startsWith("<")) {
        const doc = readSvgDoc(text);
        if (doc) return doc;
      }
    }
  } catch {
    // fall through — not a board file
  }
  return null;
}

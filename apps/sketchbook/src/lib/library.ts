/**
 * The sketchbook's element library — ONE library shared across every drawing
 * (that's its point: reusable elements follow you between pages), persisted to
 * its own localStorage key beside the drawings. The panel's open/closed state
 * rides along so the sidebar stays put across page switches and reloads.
 */
import type { LibraryEntry } from "@operator/draw-board";

export interface LibraryState {
  open: boolean;
  entries: LibraryEntry[];
}

const STORAGE_KEY = "sketchbook:library";

export function loadLibrary(): LibraryState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { open: false, entries: [] };
    const parsed = JSON.parse(raw) as LibraryState;
    return {
      open: parsed?.open === true,
      entries: Array.isArray(parsed?.entries)
        ? parsed.entries.filter((e) => e && typeof e.id === "string" && (e.kind === "separator" || (e.kind === "element" && Array.isArray(e.shapes))))
        : [],
    };
  } catch {
    return { open: false, entries: [] };
  }
}

export function saveLibrary(state: LibraryState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best effort — the in-memory session keeps working.
  }
}

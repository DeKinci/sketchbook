/**
 * The sketchbook's drawing collection — pure list operations over an array of
 * named board docs, plus a thin localStorage persistence wrapper (the app is
 * fully client-side). Pure functions are exported separately so they unit-test
 * without a DOM.
 */
import type { DrawDoc } from "@operator/draw-board";

export interface Drawing {
  id: string;
  name: string;
  doc: DrawDoc;
  createdAt: number;
}

const STORAGE_KEY = "sketchbook:drawings";

/** A fresh empty board doc. The size only seeds the legacy doc box — the board
 *  itself is an infinite plane. */
export function emptyDoc(): DrawDoc {
  return { shapes: [], width: 720, height: 460 };
}

/** First free "Untitled" / "Untitled N" name. */
export function nextName(list: Drawing[]): string {
  const taken = new Set(list.map((d) => d.name));
  if (!taken.has("Untitled")) return "Untitled";
  for (let n = 2; ; n++) {
    const name = `Untitled ${n}`;
    if (!taken.has(name)) return name;
  }
}

export function createDrawing(list: Drawing[], now = Date.now()): { list: Drawing[]; created: Drawing } {
  const created: Drawing = { id: crypto.randomUUID(), name: nextName(list), doc: emptyDoc(), createdAt: now };
  return { list: [...list, created], created };
}

/** First free variant of `base` ("Plan", "Plan 2", …). */
export function uniquifyName(list: Drawing[], base: string): string {
  const taken = new Set(list.map((d) => d.name));
  const stem = base.trim() || "Untitled";
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) {
    const name = `${stem} ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Add a drawing with a GIVEN doc (board-file import, image-backed page). */
export function importDrawing(list: Drawing[], doc: DrawDoc, base: string, now = Date.now()): { list: Drawing[]; created: Drawing } {
  const created: Drawing = { id: crypto.randomUUID(), name: uniquifyName(list, base), doc, createdAt: now };
  return { list: [...list, created], created };
}

/** Sidebar order: newest first (stable for equal stamps — insertion wins). */
export function displayOrder(list: Drawing[]): Drawing[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

export function renameDrawing(list: Drawing[], id: string, name: string): Drawing[] {
  const trimmed = name.trim();
  if (!trimmed) return list; // an empty rename is a cancel, not an erase
  return list.map((d) => (d.id === id ? { ...d, name: trimmed } : d));
}

export function updateDoc(list: Drawing[], id: string, doc: DrawDoc): Drawing[] {
  return list.map((d) => (d.id === id ? { ...d, doc } : d));
}

// ── localStorage IO (try/catch-wrapped: private mode / quota safe) ───────────
// Explicitly `window.localStorage`: Node ≥22 defines a bare-global localStorage
// stub that shadows jsdom's real one under vitest — the window property is the
// actual store in both the browser and jsdom.

export function loadDrawings(): Drawing[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Drawing[];
    return Array.isArray(parsed) ? parsed.filter((d) => d && typeof d.id === "string" && !!d.doc) : [];
  } catch {
    return [];
  }
}

export function saveDrawings(list: Drawing[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Best effort — the in-memory session keeps working.
  }
}

/**
 * Element library model — the shared, cross-drawing palette of reusable
 * elements (usually groups) shown in the board's right-hand library panel.
 *
 * The library is HOST state (it outlives any one drawing): the editor renders
 * and mutates it through the `library` prop, the host persists it. Entries are
 * a flat ordered list — elements (square preview tiles) interleaved with
 * separators (full-width horizontal dividers that group the tiles).
 *
 * An element stores its shapes NORMALIZED to the origin (content bounding box
 * at 0,0) with all ids/group-ids freshly minted and edges to shapes outside
 * the captured set dropped — so it is fully self-contained and position-free.
 * Placing it back clones again with fresh ids (every placement is an
 * independent copy).
 */
import { clonePastedShapes, contentBounds, type Shape } from "./drawModel.ts";
import { exportSvg } from "./svgExport.ts";

export interface LibraryElement {
  kind: "element";
  id: string;
  /** The element's shapes, normalized: content bounding box sits at (0,0). */
  shapes: Shape[];
  /** Content bounding box size (for tile aspect + centered placement). */
  width: number;
  height: number;
}

/** A horizontal divider grouping the tiles above it from the ones below. */
export interface LibrarySeparator {
  kind: "separator";
  id: string;
  /** Optional group label rendered on the divider line. */
  label?: string;
}

export type LibraryEntry = LibraryElement | LibrarySeparator;

/** Capture shapes as a library element: clone with fresh ids (edges to shapes
 *  OUTSIDE the set drop; internal attach/bind/group structure is kept, gids
 *  reminted) and translate so the content bbox lands at the origin. Null for
 *  an empty capture. */
export function elementFromShapes(shapes: Shape[], newId: () => string): LibraryElement | null {
  const b = contentBounds(shapes);
  if (!b) return null;
  return {
    kind: "element",
    id: newId(),
    shapes: clonePastedShapes(shapes, -b.x, -b.y, newId),
    width: b.width,
    height: b.height,
  };
}

/** Instantiate an element on the board: fresh-id clones, CENTERED at `at`
 *  (the drop point) — the element's normalized bbox spans (0,0)..(w,h), so
 *  shifting by `at - size/2` centers the whole assembly on the cursor. */
export function placeElement(el: LibraryElement, at: { x: number; y: number }, newId: () => string): Shape[] {
  return clonePastedShapes(el.shapes, at.x - el.width / 2, at.y - el.height / 2, newId);
}

/** Standalone SVG preview for an element tile (data URL). Content-trimmed by
 *  the export's own crop rules; `rich: false` — a preview embeds no doc. */
export function elementPreviewUrl(el: LibraryElement): string {
  const svg = exportSvg({ shapes: el.shapes, width: el.width, height: el.height }, { rich: false });
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Remove one entry (element or separator) by id. */
export function removeEntry(entries: LibraryEntry[], id: string): LibraryEntry[] {
  return entries.filter((e) => e.id !== id);
}

/** Insert a new separator right after the entry `afterId` (append if gone). */
export function addSeparatorAfter(entries: LibraryEntry[], afterId: string, sepId: string): LibraryEntry[] {
  const sep: LibrarySeparator = { kind: "separator", id: sepId };
  const i = entries.findIndex((e) => e.id === afterId);
  if (i === -1) return [...entries, sep];
  return [...entries.slice(0, i + 1), sep, ...entries.slice(i + 1)];
}

/** Set (or clear — blank trims to unlabeled) a separator's label. */
export function renameSeparator(entries: LibraryEntry[], id: string, label: string): LibraryEntry[] {
  const trimmed = label.trim();
  return entries.map((e) => (e.id === id && e.kind === "separator" ? { ...e, label: trimmed || undefined } : e));
}

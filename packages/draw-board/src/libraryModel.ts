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

/** Insert an element at a specific position (drag-in drops at the hovered slot,
 *  not just the end). Index is clamped into [0, length]. */
export function insertElementAt(entries: LibraryEntry[], el: LibraryElement, index: number): LibraryEntry[] {
  const at = Math.max(0, Math.min(index, entries.length));
  return [...entries.slice(0, at), el, ...entries.slice(at)];
}

/** Reorder: pull entry `id` out and reinsert it at `toIndex` — where `toIndex`
 *  is an index into the list WITH the entry already removed (the panel computes
 *  the drop slot over the OTHER entries, so this matches what the user sees). */
export function moveEntry(entries: LibraryEntry[], id: string, toIndex: number): LibraryEntry[] {
  const from = entries.findIndex((e) => e.id === id);
  if (from === -1) return entries;
  const without = entries.filter((e) => e.id !== id);
  const at = Math.max(0, Math.min(toIndex, without.length));
  return [...without.slice(0, at), entries[from], ...without.slice(at)];
}

/** A canonical, id-INDEPENDENT signature of an element's shapes — two captures
 *  of the same arrangement (fresh ids/gids each time, normalized to the origin)
 *  produce the SAME string, so the library can reject exact duplicates.
 *
 *  Canonicalization: strip each shape's `id`; renumber group ids and every
 *  id-reference (attach / arrow binds / dormant-edge targets) to the shape's
 *  array index or the gid's first-seen ordinal; round geometry to 2 decimals so
 *  ULP-level offset noise from two different board positions can't diverge. */
export function elementSignature(shapes: Shape[]): string {
  const idIndex = new Map(shapes.map((s, i) => [s.id, i] as const));
  const gidOrdinal = new Map<string, number>();
  for (const s of shapes) for (const g of s.groupPath ?? []) if (!gidOrdinal.has(g)) gidOrdinal.set(g, gidOrdinal.size);
  const ref = (id: string) => idIndex.get(id) ?? -1;
  const gid = (g: string) => gidOrdinal.get(g) ?? -1;

  const canon = shapes.map((s) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = { ...s };
    delete c.id;
    if (s.groupPath) c.groupPath = s.groupPath.map(gid);
    if (c.attach) c.attach = { ...c.attach, id: ref(c.attach.id) };
    if (c.bindStart) c.bindStart = { ...c.bindStart, id: ref(c.bindStart.id) };
    if (c.bindEnd) c.bindEnd = { ...c.bindEnd, id: ref(c.bindEnd.id) };
    if (c.dormant) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.dormant = c.dormant.map((d: any) => ({
        ...d,
        gid: gid(d.gid),
        attach: d.attach ? { ...d.attach, id: ref(d.attach.id) } : undefined,
        bindStart: d.bindStart ? { ...d.bindStart, id: ref(d.bindStart.id) } : undefined,
        bindEnd: d.bindEnd ? { ...d.bindEnd, id: ref(d.bindEnd.id) } : undefined,
      }));
    }
    return c;
  });
  return JSON.stringify(canon, (_k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v));
}

/** The id of the first library element whose shapes match `el` exactly (same
 *  signature), or null if `el` is new. Separators never match. */
export function findDuplicateId(entries: LibraryEntry[], el: LibraryElement): string | null {
  const sig = elementSignature(el.shapes);
  for (const e of entries) if (e.kind === "element" && elementSignature(e.shapes) === sig) return e.id;
  return null;
}

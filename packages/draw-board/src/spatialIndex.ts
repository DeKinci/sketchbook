/**
 * Incremental uniform-grid spatial index over shape bounding boxes.
 *
 * The board's per-frame costs that scale with TOTAL shape count are queries —
 * "what's in the cull window", "what's under the pointer", "what's near this
 * endpoint" — and a flat filter pays O(n) bbox math (pen boxes walk every
 * point) on every content frame. The index keeps an id-keyed cache of each
 * shape's bbox + grid cells and, because the reducer PRESERVES the object
 * identity of untouched shapes, an update after an edit frame is an O(n)
 * pointer walk plus O(changed) real work. Queries then touch only the cells a
 * rect overlaps.
 *
 * Not a React thing and not pure-functional — it's a mutable accelerator owned
 * by the view layer (a ref), rebuilt from scratch trivially (`update` with a
 * fresh index) and correct after ANY shapes array via identity diffing.
 */
import { boundingBox, type Shape } from "./drawModel.ts";
import type { Box } from "./viewport.ts";

/** Grid pitch in logical px — sketch shapes are tens-to-hundreds of px, so most
 *  land in 1–4 cells. Queries grow rects by fractions of a viewport, touching
 *  tens of cells. */
const CELL = 512;

type Entry = {
  shape: Shape;
  bbox: Box;
  /** Cell keys this shape's bbox overlaps. */
  cells: string[];
};

const keyOf = (cx: number, cy: number) => `${cx}:${cy}`;

function cellsFor(b: Box): string[] {
  const x0 = Math.floor(b.x / CELL);
  const y0 = Math.floor(b.y / CELL);
  const x1 = Math.floor((b.x + b.width) / CELL);
  const y1 = Math.floor((b.y + b.height) / CELL);
  const out: string[] = [];
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) out.push(keyOf(cx, cy));
  return out;
}

export class SpatialIndex {
  private byId = new Map<string, Entry>();
  private grid = new Map<string, Set<string>>();
  /** The shapes array this index reflects (identity gate for `update`). */
  private current: Shape[] | null = null;

  /** Sync to `shapes`. O(n) pointer walk; real work only for shapes whose
   *  identity changed (the reducer keeps untouched shapes identical). */
  update(shapes: Shape[]): void {
    if (this.current === shapes) return;
    const seen = new Set<string>();
    for (const sh of shapes) {
      seen.add(sh.id);
      const prev = this.byId.get(sh.id);
      if (prev && prev.shape === sh) continue;
      if (prev) this.remove(prev);
      const bbox = boundingBox(sh);
      const cells = cellsFor(bbox);
      const entry: Entry = { shape: sh, bbox, cells };
      this.byId.set(sh.id, entry);
      for (const c of cells) {
        let set = this.grid.get(c);
        if (!set) this.grid.set(c, (set = new Set()));
        set.add(sh.id);
      }
    }
    if (seen.size !== this.byId.size) {
      for (const [id, entry] of this.byId) {
        if (!seen.has(id)) {
          this.remove(entry);
          this.byId.delete(id);
        }
      }
    }
    this.current = shapes;
  }

  private remove(entry: Entry): void {
    for (const c of entry.cells) {
      const set = this.grid.get(c);
      if (set) {
        set.delete(entry.shape.id);
        if (set.size === 0) this.grid.delete(c);
      }
    }
  }

  /** Cached bbox for a live shape (exact, not cell-grained). */
  bboxOf(id: string): Box | undefined {
    return this.byId.get(id)?.bbox;
  }

  /** Shapes whose bbox intersects `rect`. Preserves no particular order. */
  query(rect: Box): Shape[] {
    const x0 = Math.floor(rect.x / CELL);
    const y0 = Math.floor(rect.y / CELL);
    const x1 = Math.floor((rect.x + rect.width) / CELL);
    const y1 = Math.floor((rect.y + rect.height) / CELL);
    // Degenerate/huge windows: walking more cells than shapes is a loss.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.byId.size) {
      const out: Shape[] = [];
      for (const e of this.byId.values()) if (intersects(e.bbox, rect)) out.push(e.shape);
      return out;
    }
    const hit = new Set<string>();
    const out: Shape[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const set = this.grid.get(keyOf(cx, cy));
        if (!set) continue;
        for (const id of set) {
          if (hit.has(id)) continue;
          hit.add(id);
          const e = this.byId.get(id)!;
          if (intersects(e.bbox, rect)) out.push(e.shape);
        }
      }
    }
    return out;
  }

  /** Shapes whose bbox comes within `pad` of a point. */
  queryPoint(pt: { x: number; y: number }, pad: number): Shape[] {
    return this.query({ x: pt.x - pad, y: pt.y - pad, width: pad * 2, height: pad * 2 });
  }
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

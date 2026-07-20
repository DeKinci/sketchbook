/**
 * Incremental root-unit index over shapes — the view-side accelerator for group
 * queries (selection outline partitioning, proxy-rect bounds, drag glue
 * highlights). Same contract as {@link SpatialIndex}: because the reducer
 * PRESERVES the object identity of untouched shapes, `update` after an edit
 * frame is an O(n) pointer walk plus real work only for shapes whose identity
 * changed; a same-array update is free. NOT rebuilt per frame.
 *
 * Owned by the view layer (a ref), rebuilt trivially from scratch, correct
 * after ANY shapes array via identity diffing. The reducer never touches it —
 * it uses the pure O(n) helpers in drawModel.ts instead.
 */
import { boundingBox, rootUnitKeyOf, type Shape } from "./drawModel.ts";
import type { Box } from "./viewport.ts";

type Entry = {
  shape: Shape;
  rootKey: string;
};

export class UnitIndex {
  private byId = new Map<string, Entry>();
  private members = new Map<string, Set<string>>(); // rootKey → member ids
  /** Union-AABB cache per unit, dropped whenever a member entry changes. */
  private bounds = new Map<string, Box>();
  /** The shapes array this index reflects (identity gate for `update`). */
  private current: Shape[] | null = null;

  /** Sync to `shapes`. O(n) pointer walk; real work only for changed shapes. */
  update(shapes: Shape[]): void {
    if (this.current === shapes) return;
    const seen = new Set<string>();
    for (const sh of shapes) {
      seen.add(sh.id);
      const prev = this.byId.get(sh.id);
      if (prev && prev.shape === sh) continue;
      const rootKey = rootUnitKeyOf(sh);
      if (prev) {
        this.bounds.delete(prev.rootKey);
        if (prev.rootKey !== rootKey) this.dropMember(prev.rootKey, sh.id);
      }
      this.byId.set(sh.id, { shape: sh, rootKey });
      let set = this.members.get(rootKey);
      if (!set) this.members.set(rootKey, (set = new Set()));
      set.add(sh.id);
      this.bounds.delete(rootKey);
    }
    if (seen.size !== this.byId.size) {
      for (const [id, entry] of this.byId) {
        if (!seen.has(id)) {
          this.dropMember(entry.rootKey, id);
          this.bounds.delete(entry.rootKey);
          this.byId.delete(id);
        }
      }
    }
    this.current = shapes;
  }

  private dropMember(rootKey: string, id: string): void {
    const set = this.members.get(rootKey);
    if (set) {
      set.delete(id);
      if (set.size === 0) this.members.delete(rootKey);
    }
  }

  /** Root unit key of a live shape (its root gid, or its own id when loose). */
  rootOf(id: string): string | undefined {
    return this.byId.get(id)?.rootKey;
  }

  /** Member ids of a root unit (empty set for an unknown key). */
  membersOf(rootKey: string): ReadonlySet<string> {
    return this.members.get(rootKey) ?? EMPTY;
  }

  /** True when the shape belongs to a real (multi-member) group unit. */
  isGroupedMember(id: string): boolean {
    const entry = this.byId.get(id);
    return !!entry?.shape.groupPath?.length;
  }

  /** Smallest GROUP unit (multi-member — loose singletons never qualify) whose
   *  union AABB contains the point, or null. The gap-click fallback: a group
   *  presents as its whole box, so a click landing BETWEEN members (hitting no
   *  shape) still finds the group. Smallest-wins mirrors the shape hit test. */
  smallestGroupAt(pt: { x: number; y: number }): string | null {
    let bestKey: string | null = null;
    let bestArea = Infinity;
    for (const [key, set] of this.members) {
      if (set.size < 2) continue; // rootKey = own id ⇒ singleton ⇒ not a group
      const b = this.boundsOf(key);
      if (!b || pt.x < b.x || pt.x > b.x + b.width || pt.y < b.y || pt.y > b.y + b.height) continue;
      const area = b.width * b.height;
      if (area < bestArea) {
        bestArea = area;
        bestKey = key;
      }
    }
    return bestKey;
  }

  /** Union AABB of a root unit's members (cached until a member changes). */
  boundsOf(rootKey: string): Box | null {
    const cached = this.bounds.get(rootKey);
    if (cached) return cached;
    const set = this.members.get(rootKey);
    if (!set?.size) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of set) {
      const b = boundingBox(this.byId.get(id)!.shape);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    const box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    this.bounds.set(rootKey, box);
    return box;
  }
}

const EMPTY: ReadonlySet<string> = new Set();

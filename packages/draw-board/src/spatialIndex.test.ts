import { describe, expect, it } from "vitest";
import { SpatialIndex } from "./spatialIndex.ts";
import type { Shape } from "./drawModel.ts";

const rect = (id: string, x: number, y: number, w = 40, h = 30): Shape => ({ id, type: "rect", stroke: "#fff", strokeWidth: 3, x, y, width: w, height: h });
const pen = (id: string, pts: number[]): Shape => ({ id, type: "pen", stroke: "#fff", strokeWidth: 3, points: pts });

describe("SpatialIndex", () => {
  it("query returns exactly the intersecting shapes", () => {
    const idx = new SpatialIndex();
    const shapes = [rect("a", 0, 0), rect("b", 1000, 1000), pen("c", [500, 500, 550, 540, 600, 560])];
    idx.update(shapes);
    expect(idx.query({ x: -10, y: -10, width: 100, height: 100 }).map((s) => s.id)).toEqual(["a"]);
    expect(new Set(idx.query({ x: 0, y: 0, width: 1200, height: 1200 }).map((s) => s.id))).toEqual(new Set(["a", "b", "c"]));
    expect(idx.query({ x: 480, y: 480, width: 50, height: 50 }).map((s) => s.id)).toEqual(["c"]);
    expect(idx.query({ x: 5000, y: 5000, width: 10, height: 10 })).toEqual([]);
  });

  it("spanning shapes are returned once (multi-cell dedupe)", () => {
    const idx = new SpatialIndex();
    idx.update([rect("wide", -100, -100, 2000, 2000)]);
    expect(idx.query({ x: 0, y: 0, width: 1500, height: 1500 }).map((s) => s.id)).toEqual(["wide"]);
  });

  it("incremental update: moved shape leaves old cells, joins new; removed shape vanishes", () => {
    const idx = new SpatialIndex();
    const a = rect("a", 0, 0);
    const b = rect("b", 2000, 0);
    idx.update([a, b]);
    // Move a far away (new identity, same id) — old spot empty, new spot hits.
    const a2 = { ...a, x: 5000 } as Shape;
    idx.update([a2, b]);
    expect(idx.query({ x: -50, y: -50, width: 200, height: 200 })).toEqual([]);
    expect(idx.query({ x: 4950, y: -50, width: 200, height: 200 }).map((s) => s.id)).toEqual(["a"]);
    // Delete b.
    idx.update([a2]);
    expect(idx.query({ x: 1900, y: -50, width: 300, height: 200 })).toEqual([]);
  });

  it("same-array update is a no-op; unchanged identities keep cached boxes", () => {
    const idx = new SpatialIndex();
    const shapes = [rect("a", 0, 0)];
    idx.update(shapes);
    const box1 = idx.bboxOf("a");
    idx.update(shapes);
    expect(idx.bboxOf("a")).toBe(box1); // same cached object
  });

  it("queryPoint pads symmetrically", () => {
    const idx = new SpatialIndex();
    idx.update([rect("a", 100, 100)]);
    expect(idx.queryPoint({ x: 90, y: 90 }, 5)).toEqual([]);
    expect(idx.queryPoint({ x: 90, y: 90 }, 15).map((s) => s.id)).toEqual(["a"]);
  });

  it("negative coordinates work (infinite plane)", () => {
    const idx = new SpatialIndex();
    idx.update([rect("neg", -5000, -3000)]);
    expect(idx.query({ x: -5010, y: -3010, width: 100, height: 100 }).map((s) => s.id)).toEqual(["neg"]);
  });
});

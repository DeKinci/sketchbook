import { describe, it, expect } from "vitest";
import { contentCropLogical } from "./exportPng.ts";
import type { DrawDoc, Shape } from "./drawModel.ts";

const rect = (x: number, y: number, w: number, h: number): Shape => ({ id: `r${x}-${y}`, type: "rect", stroke: "#fff", strokeWidth: 3, x, y, width: w, height: h });
const doc = (shapes: Shape[], over: Partial<DrawDoc> = {}): DrawDoc => ({ shapes, width: 400, height: 300, ...over });

describe("contentCropLogical — trim a blank sketch to content + 30px", () => {
  it("wraps a single shape with 30px padding", () => {
    expect(contentCropLogical(doc([rect(100, 100, 40, 30)]))).toEqual({ x: 70, y: 70, width: 100, height: 90 });
    // right = 140+30 = 170 → width 170-70 = 100; bottom = 130+30 = 160 → height 90.
  });

  it("unions multiple shapes then pads", () => {
    expect(contentCropLogical(doc([rect(100, 100, 20, 20), rect(200, 150, 40, 30)]))).toEqual({
      x: 70, // minX 100 - 30
      y: 70, // minY 100 - 30
      width: 200, // maxX 240 + 30 = 270 → 270-70
      height: 140, // maxY 180 + 30 = 210 → 210-70
    });
  });

  it("clamps the padding to the canvas edges (no empty area beyond the board)", () => {
    // Shape hugging the top-left: pad clamps to 0.
    expect(contentCropLogical(doc([rect(10, 5, 50, 50)]))).toEqual({ x: 0, y: 0, width: 90, height: 85 });
    // 10+50=60 +30 = 90; 5+50=55 +30 = 85.
  });

  it("clamps the far edges to the canvas size", () => {
    const c = contentCropLogical(doc([rect(360, 260, 30, 30)]))!; // near 400x300 corner
    expect(c.x).toBe(330); // 360-30
    expect(c.y).toBe(230); // 260-30
    expect(c.x + c.width).toBe(400); // right clamped to canvas width
    expect(c.y + c.height).toBe(300); // bottom clamped to canvas height
  });

  it("returns null for an image annotation (image is the content) and an empty board", () => {
    expect(contentCropLogical(doc([rect(10, 10, 20, 20)], { background: { dataBase64: "", mediaType: "image/png", width: 400, height: 300 } }))).toBeNull();
    expect(contentCropLogical(doc([]))).toBeNull();
  });

  it("clamp:false (infinite board) pads without clamping — content beyond the doc box exports whole", () => {
    // Content at negative coords, far outside the 400×300 doc box.
    const c = contentCropLogical(doc([rect(-500, -200, 100, 50), rect(700, 400, 40, 30)]), { clamp: false })!;
    expect(c).toEqual({ x: -530, y: -230, width: 1300, height: 690 });
    // minX -500-30; maxX 740+30=770 → width 770-(-530)=1300; minY -230; maxY 460 → 690.
    // …while the default clamp still pins to the doc box (legacy behavior).
    const clamped = contentCropLogical(doc([rect(-500, -200, 100, 50), rect(700, 400, 40, 30)]))!;
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
    expect(clamped.x + clamped.width).toBe(400);
    expect(clamped.y + clamped.height).toBe(300);
  });
});

describe("exportScale — output capped in BOTH dimensions", () => {
  it("blank sketch: 2× until a dimension would exceed the cap", async () => {
    const { exportScale } = await import("./exportPng.ts");
    expect(exportScale(doc([]), { width: 500, height: 300 })).toBe(2);
    // Tall skinny content: 500×40000 logical — 2× would be 80000px tall.
    expect(exportScale(doc([]), { width: 500, height: 40000 })).toBeCloseTo(4096 / 40000, 6);
    // Very wide content: width cap engages (the old 0.05 floor defeated it).
    expect(exportScale(doc([]), { width: 100000, height: 200 })).toBeCloseTo(4096 / 100000, 8);
  });

  it("annotation: natural resolution, still capped both ways", async () => {
    const { exportScale } = await import("./exportPng.ts");
    const bg = { dataBase64: "", mediaType: "image/png", width: 800, height: 600 };
    expect(exportScale(doc([], { background: bg, width: 400, height: 300 }), { width: 400, height: 300 })).toBe(2); // 800/400
    const tall = { dataBase64: "", mediaType: "image/png", width: 1000, height: 20000 };
    expect(exportScale(doc([], { background: tall, width: 500, height: 10000 }), { width: 500, height: 10000 })).toBeCloseTo(4096 / 10000, 6);
  });
});

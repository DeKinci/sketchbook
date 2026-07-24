import { describe, it, expect } from "vitest";
import {
  drawReducer,
  initialDrawState,
  selectionStrokes,
  selectionFills,
  shapeStrokes,
  shapeFills,
  paintStroke,
  paintFill,
  type DrawState,
  type Shape,
  type ImageShape,
  type SvgPaint,
} from "./drawModel.ts";

/** An SVG image shape with a discovered palette. */
const svgImg = (id: string, svg: SvgPaint, over: Partial<ImageShape> = {}): ImageShape => ({
  id,
  type: "image",
  stroke: "#000000",
  strokeWidth: 1,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  dataBase64: "PHN2Zy8+", // "<svg/>" — irrelevant to the pure paint model
  mediaType: "image/svg+xml",
  svg,
  ...over,
});

const rasterImg = (id: string): ImageShape => ({
  id,
  type: "image",
  stroke: "#000000",
  strokeWidth: 1,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  dataBase64: "AAAA",
  mediaType: "image/png",
});

const seeded = (shapes: Shape[]): DrawState => initialDrawState({ shapes, width: 400, height: 300 });
const select = (s: DrawState, ...ids: string[]): DrawState => drawReducer(s, { type: "select", ids });
const imageOf = (s: DrawState, id: string) => s.shapes.find((sh) => sh.id === id) as ImageShape;

describe("SVG image is a two-channel palette (shape/selection derivations)", () => {
  it("shapeStrokes/shapeFills read an SVG image's current palette", () => {
    const im = svgImg("i1", { fills: ["#00ff00"], strokes: ["#111111", "#222222"] });
    expect(shapeStrokes(im)).toEqual(["#111111", "#222222"]);
    expect(shapeFills(im)).toEqual(["#00ff00"]);
  });

  it("a mapped entry surfaces its CURRENT color; a none-mapped fill reads as null", () => {
    const im = svgImg("i1", {
      fills: ["#00ff00"],
      strokes: ["#111111"],
      fillMap: { "#00ff00": "none" },
      strokeMap: { "#111111": "#ff0000" },
    });
    expect(shapeStrokes(im)).toEqual(["#ff0000"]);
    expect(shapeFills(im)).toEqual([null]);
  });

  it("selectionStrokes/Fills fold an SVG image's palette in alongside vector shapes", () => {
    const s = select(seeded([svgImg("i1", { fills: ["#00ff00"], strokes: ["#111111", "#222222"] })]), "i1");
    expect(selectionStrokes(s.shapes, s.selectedIds)).toEqual(["#111111", "#222222"]);
    expect(selectionFills(s.shapes, s.selectedIds)).toEqual(["#00ff00"]);
  });

  it("a raster image contributes no colors (unchanged from before)", () => {
    const s = select(seeded([rasterImg("i1")]), "i1");
    expect(selectionStrokes(s.shapes, s.selectedIds)).toEqual([]);
    expect(selectionFills(s.shapes, s.selectedIds)).toEqual([]);
  });
});

describe("setColor / setFill on a selected SVG image (whole-channel)", () => {
  it("setColor maps EVERY stroke-palette entry to the color; fills untouched; undoable", () => {
    let s = select(seeded([svgImg("i1", { fills: ["#00ff00"], strokes: ["#111111", "#222222"] })]), "i1");
    s = drawReducer(s, { type: "setColor", color: "#ff0000" });
    const im = imageOf(s, "i1");
    expect(im.svg!.strokeMap).toEqual({ "#111111": "#ff0000", "#222222": "#ff0000" });
    expect(im.svg!.fillMap).toBeUndefined();
    expect([...new Set(shapeStrokes(im))]).toEqual(["#ff0000"]); // both classes now red
    s = drawReducer(s, { type: "undo" });
    expect(imageOf(s, "i1").svg!.strokeMap).toBeUndefined();
  });

  it("setFill maps every fill entry; 'none' maps a fill to none", () => {
    let s = select(seeded([svgImg("i1", { fills: ["#00ff00", "#0000ff"], strokes: [] })]), "i1");
    s = drawReducer(s, { type: "setFill", fill: "#abcdef" });
    expect(imageOf(s, "i1").svg!.fillMap).toEqual({ "#00ff00": "#abcdef", "#0000ff": "#abcdef" });
    s = drawReducer(s, { type: "setFill", fill: null });
    expect(imageOf(s, "i1").svg!.fillMap).toEqual({ "#00ff00": "none", "#0000ff": "none" });
    expect([...new Set(shapeFills(imageOf(s, "i1")))]).toEqual([null]);
  });

  it("a raster image is inert under setColor/setFill (no svg palette to touch)", () => {
    let s = select(seeded([rasterImg("i1")]), "i1");
    s = drawReducer(s, { type: "setColor", color: "#ff0000" });
    s = drawReducer(s, { type: "setFill", fill: "#ff0000" });
    const im = imageOf(s, "i1");
    expect(im.svg).toBeUndefined();
    expect(im.stroke).toBe("#000000"); // cosmetic stroke field untouched
  });
});

describe("partial recoloring — recolor / refill one class (drag a swatch)", () => {
  it("recolor(from,to) remaps only the matching stroke class; other class + fills stay", () => {
    let s = select(seeded([svgImg("i1", { fills: ["#00ff00"], strokes: ["#111111", "#222222"] })]), "i1");
    s = drawReducer(s, { type: "recolor", from: "#111111", to: "#ff0000" });
    const im = imageOf(s, "i1");
    expect(im.svg!.strokeMap).toEqual({ "#111111": "#ff0000" });
    expect(shapeStrokes(im)).toEqual(["#ff0000", "#222222"]); // 2nd class unchanged
    expect(shapeFills(im)).toEqual(["#00ff00"]); // fill channel untouched
  });

  it("recolor matches on the CURRENT color and strips the map when set back to original", () => {
    let s = select(seeded([svgImg("i1", { fills: [], strokes: ["#111111"] })]), "i1");
    s = drawReducer(s, { type: "recolor", from: "#111111", to: "#ff0000" });
    expect(imageOf(s, "i1").svg!.strokeMap).toEqual({ "#111111": "#ff0000" });
    // now the class shows red; recolor red -> original strips the entry
    s = drawReducer(s, { type: "recolor", from: "#ff0000", to: "#111111" });
    expect(imageOf(s, "i1").svg!.strokeMap).toBeUndefined();
  });

  it("refill(from,to) remaps only the matching fill class", () => {
    let s = select(seeded([svgImg("i1", { fills: ["#00ff00", "#0000ff"], strokes: [] })]), "i1");
    s = drawReducer(s, { type: "refill", from: "#00ff00", to: "#abcdef" });
    expect(imageOf(s, "i1").svg!.fillMap).toEqual({ "#00ff00": "#abcdef" });
    expect(shapeFills(imageOf(s, "i1"))).toEqual(["#abcdef", "#0000ff"]);
  });

  it("a recolor spanning a vector shape and an SVG image touches BOTH shared classes", () => {
    const vec: Shape = { id: "r1", type: "rect", stroke: "#111111", strokeWidth: 3, x: 0, y: 0, width: 10, height: 10 };
    let s = select(seeded([vec, svgImg("i1", { fills: [], strokes: ["#111111", "#999999"] })]), "r1", "i1");
    s = drawReducer(s, { type: "recolor", from: "#111111", to: "#ff0000" });
    expect((s.shapes.find((x) => x.id === "r1") as any).stroke).toBe("#ff0000");
    expect(imageOf(s, "i1").svg!.strokeMap).toEqual({ "#111111": "#ff0000" });
  });

  it("recolor with no matching class is a no-op (no history entry)", () => {
    const s0 = select(seeded([svgImg("i1", { fills: [], strokes: ["#111111"] })]), "i1");
    const s1 = drawReducer(s0, { type: "recolor", from: "#abcdef", to: "#ff0000" });
    expect(s1).toBe(s0); // same reference — nothing changed
  });
});

describe("setShade repaints an SVG image's palette in the picked column", () => {
  it("a red-family stroke entry unifies onto the new red shade; others stay", () => {
    // #e5484d is the red base; #0000ff is not red.
    let s = select(seeded([svgImg("i1", { fills: [], strokes: ["#e5484d", "#0000ff"] })]), "i1");
    s = drawReducer(s, { type: "setShade", level: "stroke", family: "red", shade: "#7a1e22" });
    const im = imageOf(s, "i1");
    expect(im.svg!.strokeMap).toEqual({ "#e5484d": "#7a1e22" });
    expect(shapeStrokes(im)).toEqual(["#7a1e22", "#0000ff"]);
  });
});

describe("paint* helpers return the same reference on a no-op", () => {
  it("paintStroke/paintFill no-op → identical reference", () => {
    const im = svgImg("i1", { fills: ["#00ff00"], strokes: ["#111111"] });
    expect(paintStroke(im, () => undefined)).toBe(im);
    expect(paintFill(im, () => undefined)).toBe(im);
    // a raster image has no channels to paint
    const r = rasterImg("i2");
    expect(paintStroke(r, () => "#ff0000")).toBe(r);
    expect(paintFill(r, () => "#ff0000")).toBe(r);
  });

  it("paintStroke on a vector shape sets its single stroke", () => {
    const vec: Shape = { id: "r1", type: "rect", stroke: "#111111", strokeWidth: 3, x: 0, y: 0, width: 10, height: 10 };
    expect((paintStroke(vec, () => "#ff0000") as any).stroke).toBe("#ff0000");
    expect(paintStroke(vec, (cur) => (cur === "#000000" ? "#ff0000" : undefined))).toBe(vec); // no match → same ref
  });
});

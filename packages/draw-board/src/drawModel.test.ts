import { describe, it, expect } from "vitest";
import {
  drawReducer,
  initialDrawState,
  normalizeBox,
  boundingBox,
  shapesInMarquee,
  offsetShape,
  isSelectable,
  reflowBindings,
  bindAt,
  nearestBindableId,
  nearestEdgeBindableId,
  attachAt,
  growthOrigin,
  sideAnchor,
  migrateLabels,
  reflowAttachments,
  containedIds,
  moveClusterIds,
  clusterWeight,
  toClusterVariant,
  paintOrder,
  clonePastedShapes,
  toDoc,
  canUndo,
  canRedo,
  stepStroke,
  sizeSlotOf,
  slotTargetStep,
  fontForStroke,
  strokeForFont,
  dashFor,
  CONTRAST_INK,
  isContrastInk,
  INK_COLORS,
  HUE_FAMILIES,
  SHADES,
  BASE_SHADE,
  GRAYS,
  familyOf,
  shadeIndexOf,
  hexLum,
  isEnclosed,
  paintsFill,
  fillAt,
  selectionStrokes,
  selectionFills,
  contrastSolidOver,
  textBgBox,
  CONTRAST_DARK,
  CONTRAST_BRIGHT,
  type DrawState,
  type BoxShape,
  type TextShape,
  type Shape,
  type Attach,
} from "./drawModel.ts";
import { lineWidth } from "./textMetrics.ts";

const box = (id: string, over: Partial<BoxShape> = {}): BoxShape => ({
  id,
  type: "rect",
  stroke: "#000",
  strokeWidth: 3,
  x: 10,
  y: 10,
  width: 40,
  height: 30,
  ...over,
});

const text = (id: string, over: Partial<TextShape> = {}): TextShape => ({
  id,
  type: "text",
  stroke: "#000",
  strokeWidth: 3,
  x: 5,
  y: 5,
  text: "hi",
  fontSize: 18,
  ...over,
});

const seeded = (shapes: Shape[]): DrawState => initialDrawState({ shapes, width: 400, height: 300 });

describe("secret size ladder (stepStroke / sizeSlotOf / fontForStroke)", () => {
  it("steps the full ladder one rung per press, clamped at the secret ends", () => {
    // Up from default 3 all the way past the visible top.
    const up: number[] = [];
    let w = 3;
    for (let i = 0; i < 7; i++) up.push((w = stepStroke(w, 1)));
    expect(up).toEqual([6, 10, 14, 20, 28, 28, 28]); // clamps at 28
    // Down past the visible bottom.
    const down: number[] = [];
    w = 6;
    for (let i = 0; i < 5; i++) down.push((w = stepStroke(w, -1)));
    expect(down).toEqual([3, 2, 1, 1, 1]); // clamps at 1
  });

  it("off-ladder legacy widths step from the nearest rung", () => {
    expect(stepStroke(4, 1)).toBe(6); // nearest 3 → up
    expect(stepStroke(5, -1)).toBe(3); // nearest 6 → down
    expect(stepStroke(12, 1)).toBe(14);
  });

  it("sizeSlotOf lights the nearest visible dot — secrets land on the extremes", () => {
    expect([1, 2, 3].map(sizeSlotOf)).toEqual([0, 0, 0]);
    expect(sizeSlotOf(6)).toBe(1);
    expect([10, 14, 20, 28].map(sizeSlotOf)).toEqual([2, 2, 2, 2]);
  });

  it("fontForStroke covers the secret rungs (text keeps sizing past S/M/L)", () => {
    expect(fontForStroke(1)).toBeLessThan(fontForStroke(3));
    expect(fontForStroke(28)).toBeGreaterThan(fontForStroke(10));
    expect(fontForStroke(7)).toBe(24); // off-ladder fallback unchanged
  });

  it("strokeForFont inverts fontForStroke (a selected text lands on its dot)", () => {
    for (const w of [1, 2, 3, 6, 10, 14, 20, 28]) expect(strokeForFont(fontForStroke(w))).toBe(w);
    expect(strokeForFont(30)).toBe(6); // off-ladder font → nearest rung (28)
  });

  it("slotTargetStep — absolute dots in the normal zone, relative in the extended zone, mid always resets", () => {
    // Mid: absolute reset from anywhere.
    for (const step of [-3, -1, 0, 1, 4]) expect(slotTargetStep(step, 1)).toBe(0);
    // Normal zone: the extremes are absolute selectors…
    expect(slotTargetStep(0, 2)).toBe(1); // fresh (natural) → large
    expect(slotTargetStep(0, 0)).toBe(-1); // fresh → small
    expect(slotTargetStep(1, 0)).toBe(-1); // "if we are large, we become small"
    expect(slotTargetStep(-1, 2)).toBe(1); // …and symmetrically small → large
    // …and re-pressing the extreme you're at enters the extended zone.
    expect(slotTargetStep(1, 2)).toBe(2);
    expect(slotTargetStep(3, 2)).toBe(4); // keeps growing
    expect(slotTargetStep(-1, 0)).toBe(-2);
    // Extended zone: the OPPOSITE extreme is one step back in, not absolute.
    expect(slotTargetStep(2, 0)).toBe(1); // "above large → only step downstairs once"
    expect(slotTargetStep(5, 0)).toBe(4);
    expect(slotTargetStep(-2, 2)).toBe(-1);
    expect(slotTargetStep(-4, 2)).toBe(-3);
  });
});

describe("drawReducer — draw gesture", () => {
  it("draws a rect and (from the cursor base) auto-selects it, one history entry", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "setTool", tool: "select" }); // cursor base → snap back auto-selects
    s = drawReducer(s, { type: "setTool", tool: "rect" });
    s = drawReducer(s, { type: "beginDraw", shape: box("r1", { width: 0, height: 0 }) });
    s = drawReducer(s, { type: "updateDraw", point: { x: 60, y: 50 } });
    s = drawReducer(s, { type: "endDraw" });
    expect(s.shapes).toHaveLength(1);
    expect(s.shapes[0]).toMatchObject({ id: "r1", width: 50, height: 40 });
    expect(s.selectedIds).toEqual(["r1"]);
    expect(s.tool).toBe("select"); // snapped back to the cursor
    expect(s.draftId).toBeNull();
    expect(s.past).toHaveLength(1);
  });

  it("normalizes a box dragged up-and-left at commit", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "beginDraw", shape: box("r1", { x: 100, y: 100, width: 0, height: 0 }) });
    s = drawReducer(s, { type: "updateDraw", point: { x: 40, y: 30 } });
    s = drawReducer(s, { type: "endDraw" });
    expect(s.shapes[0]).toMatchObject({ x: 40, y: 30, width: 60, height: 70 });
  });

  it("discards a degenerate click-without-drag (no shape, no history)", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "beginDraw", shape: box("r1", { width: 0, height: 0 }) });
    s = drawReducer(s, { type: "endDraw" });
    expect(s.shapes).toHaveLength(0);
    expect(s.past).toHaveLength(0);
  });

  it("accumulates freehand points then commits", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "beginDraw", shape: { id: "p1", type: "pen", stroke: "#000", strokeWidth: 3, points: [0, 0] } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 5, y: 5 } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 9, y: 2 } });
    s = drawReducer(s, { type: "endDraw" });
    const pen = s.shapes[0];
    expect(pen.type === "pen" && pen.points).toEqual([0, 0, 5, 5, 9, 2]);
    expect(s.past).toHaveLength(1);
  });

  it("a pen TAP commits a dot (epsilon segment) — a pencil touch marks, undoably", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "beginDraw", shape: { id: "p1", type: "pen", stroke: "#000", strokeWidth: 3, points: [100, 100] } });
    s = drawReducer(s, { type: "endDraw", minSize: 2 });
    const pen = s.shapes[0];
    expect(pen?.type === "pen" && pen.points).toEqual([100, 100, 100.001, 100]);
    expect(s.past).toHaveLength(1);
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes).toHaveLength(0);
  });

  it("zoomed out, a sub-threshold pen micro-scribble collapses to the dot too", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "beginDraw", shape: { id: "p1", type: "pen", stroke: "#000", strokeWidth: 3, points: [100, 100] } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 102, y: 101 } });
    s = drawReducer(s, { type: "endDraw", minSize: 8 }); // deep zoom-out: 2 screen px ≫ 2 model px
    const pen = s.shapes[0];
    expect(pen?.type === "pen" && pen.points).toEqual([100, 100, 100.001, 100]);
  });
});

describe("drawReducer — move gesture (single + group)", () => {
  it("translates one shape, single history entry", () => {
    let s = seeded([box("r1")]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "translateShapes", ids: ["r1"], dx: 15, dy: -5 });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.shapes[0]).toMatchObject({ x: 25, y: 5 });
    expect(s.past).toHaveLength(1);
  });

  it("translates a whole multi-selection together, one history entry", () => {
    let s = seeded([box("r1"), box("r2", { x: 100, y: 100 })]);
    s = drawReducer(s, { type: "select", ids: ["r1", "r2"] });
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "translateShapes", ids: ["r1", "r2"], dx: 10, dy: 10 });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.shapes[0]).toMatchObject({ x: 20, y: 20 });
    expect(s.shapes[1]).toMatchObject({ x: 110, y: 110 });
    expect(s.past).toHaveLength(1);
  });

  it("records no history for a gesture that changed nothing", () => {
    let s = seeded([box("r1")]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.past).toHaveLength(0);
  });

  it("translates line points, not x/y", () => {
    let s = seeded([{ id: "l1", type: "arrow", stroke: "#000", strokeWidth: 3, points: [0, 0, 10, 10] }]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "translateShapes", ids: ["l1"], dx: 5, dy: 7 });
    s = drawReducer(s, { type: "endGesture" });
    const l = s.shapes[0];
    expect(l.type === "arrow" && l.points).toEqual([5, 7, 15, 17]);
  });

  it("resizes via patchShape", () => {
    let s = seeded([box("r1")]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "patchShape", id: "r1", patch: { width: 80, height: 60 } });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.shapes[0]).toMatchObject({ width: 80, height: 60 });
    expect(s.past).toHaveLength(1);
  });
});

describe("drawReducer — tool classes (persistent vs one-use snap-back)", () => {
  it("picking a selectable tool updates baseTool; a shape tool does not", () => {
    let s = seeded([]);
    s = drawReducer(s, { type: "setTool", tool: "pen" });
    expect(s.baseTool).toBe("pen");
    s = drawReducer(s, { type: "setTool", tool: "rect" });
    expect(s.tool).toBe("rect");
    expect(s.baseTool).toBe("pen"); // unchanged by a one-use tool
    s = drawReducer(s, { type: "setTool", tool: "select" });
    expect(s.baseTool).toBe("select");
  });

  it("a one-use shape snaps back to baseTool=select and auto-selects the shape", () => {
    let s = seeded([]);
    s = drawReducer(s, { type: "setTool", tool: "select" }); // baseTool = select
    s = drawReducer(s, { type: "setTool", tool: "rect" });
    s = drawReducer(s, { type: "beginDraw", shape: box("r1", { width: 0, height: 0 }) });
    s = drawReducer(s, { type: "updateDraw", point: { x: 60, y: 50 } });
    s = drawReducer(s, { type: "endDraw" });
    expect(s.tool).toBe("select"); // snapped back
    expect(s.selectedIds).toEqual(["r1"]); // auto-selected (we returned to cursor)
  });

  it("a one-use shape snaps back to baseTool=pen with NO lingering selection", () => {
    let s = seeded([]);
    s = drawReducer(s, { type: "setTool", tool: "pen" }); // baseTool = pen
    s = drawReducer(s, { type: "setTool", tool: "rect" });
    s = drawReducer(s, { type: "beginDraw", shape: box("r1", { width: 0, height: 0 }) });
    s = drawReducer(s, { type: "updateDraw", point: { x: 60, y: 50 } });
    s = drawReducer(s, { type: "endDraw" });
    expect(s.tool).toBe("pen"); // stayed in the pen base
    expect(s.selectedIds).toEqual([]); // no selection in pen mode
  });

  it("pen is persistent — drawing a stroke keeps the pen tool", () => {
    let s = seeded([]);
    s = drawReducer(s, { type: "setTool", tool: "pen" });
    s = drawReducer(s, { type: "beginDraw", shape: { id: "p1", type: "pen", stroke: "#000", strokeWidth: 3, points: [0, 0] } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 5, y: 5 } });
    s = drawReducer(s, { type: "endDraw" });
    expect(s.tool).toBe("pen");
  });

  it("isSelectable is true only for cursor + pen", () => {
    expect([isSelectable("select"), isSelectable("pen")]).toEqual([true, true]);
    expect([isSelectable("rect"), isSelectable("eraser"), isSelectable("text")]).toEqual([false, false, false]);
  });
});

describe("drawReducer — selection", () => {
  it("select replaces, toggleSelect adds/removes", () => {
    let s = seeded([box("r1"), box("r2")]);
    s = drawReducer(s, { type: "select", ids: ["r1"] });
    expect(s.selectedIds).toEqual(["r1"]);
    s = drawReducer(s, { type: "toggleSelect", id: "r2" });
    expect(s.selectedIds).toEqual(["r1", "r2"]);
    s = drawReducer(s, { type: "toggleSelect", id: "r1" });
    expect(s.selectedIds).toEqual(["r2"]);
  });

  it("resizeCanvas sets the logical canvas size (blank fills its container)", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "resizeCanvas", width: 1000, height: 620 });
    expect(s).toMatchObject({ width: 1000, height: 620 });
  });

  it("resizeCanvasCentered grows from center — shifts content AND history by half the delta", () => {
    let s = seeded([box("r1", { x: 100, y: 100, width: 20, height: 20 })]); // 400x300
    s = drawReducer(s, { type: "select", ids: ["r1"] });
    s = drawReducer(s, { type: "setColor", color: "#ff0000" }); // one history entry (pre-color)
    s = drawReducer(s, { type: "resizeCanvasCentered", width: 500, height: 340 }); // +100 w, +40 h
    expect(s).toMatchObject({ width: 500, height: 340 });
    expect(s.shapes[0]).toMatchObject({ x: 150, y: 120 }); // shifted +50, +20
    expect((s.past[s.past.length - 1][0] as BoxShape).x).toBe(150); // history shifted too
  });

  it("switching off select clears the selection", () => {
    let s = seeded([box("r1")]);
    s = drawReducer(s, { type: "select", ids: ["r1"] });
    s = drawReducer(s, { type: "setTool", tool: "pen" });
    expect(s.selectedIds).toEqual([]);
  });

  it("recolors ALL selected shapes as one undoable edit", () => {
    let s = seeded([box("r1"), box("r2")]);
    s = drawReducer(s, { type: "select", ids: ["r1", "r2"] });
    s = drawReducer(s, { type: "setColor", color: "#ff0000" });
    expect(s.shapes.every((sh) => sh.stroke === "#ff0000")).toBe(true);
    expect(s.color).toBe("#ff0000");
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes.every((sh) => sh.stroke === "#000")).toBe(true);
  });

  it("recolors + resizes the in-progress draft mid-draw, without a history entry", () => {
    let s = seeded([]);
    s = drawReducer(s, { type: "beginDraw", shape: { id: "p1", type: "pen", stroke: "#000", strokeWidth: 3, points: [0, 0] } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 5, y: 5 } });
    s = drawReducer(s, { type: "setColor", color: "#ff0000" });
    expect(s.shapes[0].stroke).toBe("#ff0000");
    expect(s.color).toBe("#ff0000");
    s = drawReducer(s, { type: "setStrokeWidth", width: 10 });
    expect(s.shapes[0].strokeWidth).toBe(10);
    expect(s.past).toHaveLength(0); // mid-gesture: no discrete commits
    s = drawReducer(s, { type: "endDraw" });
    expect(s.shapes[0].stroke).toBe("#ff0000");
    expect(s.past).toHaveLength(1); // one entry for the whole stroke
  });

  it("setColor with nothing selected only changes the active color", () => {
    let s = seeded([box("r1")]);
    s = drawReducer(s, { type: "setColor", color: "#00ff00" });
    expect(s.shapes[0].stroke).toBe("#000");
    expect(s.color).toBe("#00ff00");
    expect(canUndo(s)).toBe(false);
  });

  it("deletes every selected shape and clears selection", () => {
    let s = seeded([box("r1"), box("r2"), box("r3")]);
    s = drawReducer(s, { type: "select", ids: ["r1", "r3"] });
    s = drawReducer(s, { type: "deleteSelected" });
    expect(s.shapes.map((sh) => sh.id)).toEqual(["r2"]);
    expect(s.selectedIds).toEqual([]);
  });

  it("deleteShapes removes by id (eraser) and drops them from selection", () => {
    let s = seeded([box("r1"), box("r2")]);
    s = drawReducer(s, { type: "select", ids: ["r1", "r2"] });
    s = drawReducer(s, { type: "deleteShapes", ids: ["r1"] });
    expect(s.shapes.map((sh) => sh.id)).toEqual(["r2"]);
    expect(s.selectedIds).toEqual(["r2"]);
    // erasing a non-existent id is a no-op (no history churn)
    const before = s.past.length;
    s = drawReducer(s, { type: "deleteShapes", ids: ["nope"] });
    expect(s.past.length).toBe(before);
  });
});

describe("fills — setFill / enclosure / fillAt / contrast resolve", () => {
  // A closed-ish hand loop: square path whose end lands near its start.
  const loop = [0, 0, 100, 0, 100, 100, 0, 100, 2, 6];

  it("setFill fills the selection (fillable types only) as one undoable edit + sets the pref", () => {
    let s = seeded([
      box("r1"),
      { id: "l1", type: "line", stroke: "#000", strokeWidth: 3, points: [0, 0, 50, 50] } as Shape,
    ]);
    s = drawReducer(s, { type: "select", ids: ["r1", "l1"] });
    s = drawReducer(s, { type: "setFill", fill: "#f5a623" });
    expect(s.shapes.find((sh) => sh.id === "r1")).toMatchObject({ fill: "#f5a623" });
    expect("fill" in s.shapes.find((sh) => sh.id === "l1")!).toBe(false); // segments have no interior
    expect(s.fill).toBe("#f5a623");
    s = drawReducer(s, { type: "undo" });
    expect("fill" in s.shapes.find((sh) => sh.id === "r1")!).toBe(false);
  });

  it("setFill null STRIPS the field (docs stay slim), nothing selected sets only the pref", () => {
    let s = seeded([box("r1", { fill: "#30a46c" })]);
    s = drawReducer(s, { type: "select", ids: ["r1"] });
    s = drawReducer(s, { type: "setFill", fill: null });
    expect("fill" in s.shapes[0]).toBe(false);
    s = drawReducer(s, { type: "select", ids: [] });
    s = drawReducer(s, { type: "setFill", fill: "#3b82f6" });
    expect("fill" in s.shapes[0]).toBe(false);
    expect(s.fill).toBe("#3b82f6");
  });

  it("refills the in-progress draft live, without a history entry", () => {
    let s = seeded([]);
    s = drawReducer(s, { type: "beginDraw", shape: { id: "p1", type: "pen", stroke: "#000", strokeWidth: 3, points: [0, 0] } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 5, y: 5 } });
    s = drawReducer(s, { type: "setFill", fill: "#e5484d" });
    expect(s.shapes[0]).toMatchObject({ fill: "#e5484d" });
    expect(s.past).toHaveLength(0);
  });

  it("isEnclosed: a loop that lands near its start closes; open strokes and long-gap scribbles don't", () => {
    expect(isEnclosed(loop)).toBe(true);
    expect(isEnclosed([0, 0, 100, 0, 200, 0])).toBe(false); // straight line
    expect(isEnclosed([0, 0, 10, 10])).toBe(false); // too few points
    // 1000-long path ending 100 away: over the capped tolerance.
    expect(isEnclosed([0, 0, 500, 0, 500, 500, 100, 0])).toBe(false);
  });

  it("paintsFill: pen fills only while enclosed; segments/images never", () => {
    expect(paintsFill(box("r", { fill: "#e5484d" }))).toBe(true);
    expect(paintsFill(box("r"))).toBe(false);
    expect(paintsFill({ id: "p", type: "pen", stroke: "#000", strokeWidth: 3, points: loop, fill: "#e5484d" } as Shape)).toBe(true);
    expect(paintsFill({ id: "p", type: "pen", stroke: "#000", strokeWidth: 3, points: [0, 0, 80, 0], fill: "#e5484d" } as Shape)).toBe(false);
    expect(paintsFill({ id: "l", type: "line", stroke: "#000", strokeWidth: 3, points: [0, 0, 9, 9] } as Shape)).toBe(false);
  });

  it("fillAt: topmost fill wins; ellipse corners miss; text bg spans the padded block", () => {
    const under = box("under", { x: 0, y: 0, width: 200, height: 200, fill: "#30a46c" });
    const over = box("over", { x: 50, y: 50, width: 60, height: 60, fill: "#e5484d" });
    expect(fillAt([under, over], 80, 80)).toBe("#e5484d");
    expect(fillAt([under, over], 10, 10)).toBe("#30a46c");
    expect(fillAt([under, over], 300, 300)).toBeNull();
    // Ellipse: bbox corner is OUTSIDE the curve → the fill below shows through.
    const ell = box("e", { type: "ellipse", x: 50, y: 50, width: 60, height: 60, fill: "#3b82f6" });
    expect(fillAt([under, ell], 52, 52)).toBe("#30a46c");
    expect(fillAt([under, ell], 80, 80)).toBe("#3b82f6");
    // Text bg: the PADDED block is the painted area.
    const t = text("t", { x: 100, y: 100, fontSize: 18, text: "hi", fill: "#f5a623" });
    const bg = textBgBox(t);
    expect(fillAt([t], bg.x + 1, bg.y + 1)).toBe("#f5a623");
    expect(fillAt([t], bg.x - 2, bg.y - 2)).toBeNull();
    // Enclosed doodle: point-in-polygon, not bbox.
    const pen = { id: "p", type: "pen", stroke: "#000", strokeWidth: 3, points: loop, fill: "#8267c1" } as Shape;
    expect(fillAt([pen], 50, 50)).toBe("#8267c1");
    expect(fillAt([pen], -10, 50)).toBeNull();
  });

  it("contrastSolidOver: dark ink on light fills, bright on dark fills / bare paper", () => {
    expect(contrastSolidOver("#f5a623")).toBe(CONTRAST_DARK); // amber is light
    expect(contrastSolidOver("#e5484d")).toBe(CONTRAST_BRIGHT); // red is dark enough
    expect(contrastSolidOver(null)).toBe(CONTRAST_BRIGHT); // bare dark paper
    expect(contrastSolidOver("#ffffff")).toBe(CONTRAST_DARK);
  });
});

describe("color declaration — selectionStrokes / selectionFills / recolor / refill", () => {
  const red = "#e5484d";
  const blue = "#3b82f6";
  const green = "#30a46c";
  const image = (id: string, stroke = "#000"): Shape => ({
    id,
    type: "image",
    stroke,
    strokeWidth: 1,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    dataBase64: "",
    mediaType: "image/png",
  });

  it("selectionStrokes lists the distinct strokes of the selection — images excluded (their stroke never paints)", () => {
    const shapes = [box("r1", { stroke: red }), box("r2", { stroke: blue }), box("r3", { stroke: red }), image("i1", red)];
    expect(selectionStrokes(shapes, [])).toEqual([]);
    expect(selectionStrokes(shapes, ["r1", "r2", "r3", "i1"])).toEqual([red, blue]);
    expect(selectionStrokes(shapes, ["i1"])).toEqual([]); // image-only → nothing painted
  });

  it("selectionFills lists distinct fills of the fillable selection, none as null", () => {
    const shapes = [
      box("r1", { fill: red }),
      box("r2"),
      text("t1", { fill: red }),
      { id: "l1", type: "line", stroke: "#000", strokeWidth: 3, points: [0, 0, 9, 9] } as Shape,
    ];
    expect(selectionFills(shapes, ["r1", "r2", "t1", "l1"])).toEqual([red, null]);
    expect(selectionFills(shapes, ["l1"])).toEqual([]); // nothing fillable → empty declaration
  });

  it("recolor restrokes ONLY the matching color class within the selection — one undoable edit, pen pref untouched", () => {
    let s = seeded([
      box("r1", { stroke: red }),
      box("r2", { stroke: blue }),
      box("out", { stroke: red }), // same class, NOT selected — stays
    ]);
    s = drawReducer(s, { type: "select", ids: ["r1", "r2"] });
    const ink = s.color;
    s = drawReducer(s, { type: "recolor", from: red, to: green });
    expect(s.shapes.map((sh) => sh.stroke)).toEqual([green, blue, red]);
    expect(s.color).toBe(ink); // a declaration edit, not a pen pick
    expect(s.selectedIds).toEqual(["r1", "r2"]); // selection survives for further edits
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes.map((sh) => sh.stroke)).toEqual([red, blue, red]);
  });

  it("recolor reaches grouped members (color edits are allowed on groups) but never images", () => {
    let s = seeded([box("g1", { stroke: red, groupPath: ["G"] }), box("g2", { stroke: blue, groupPath: ["G"] }), image("i1", red)]);
    s = drawReducer(s, { type: "select", ids: ["g1", "g2", "i1"] });
    s = drawReducer(s, { type: "recolor", from: red, to: green });
    expect(s.shapes.map((sh) => sh.stroke)).toEqual([green, blue, red]);
  });

  it("recolor no-ops without history churn: no selection, no match, or from === to", () => {
    let s = seeded([box("r1", { stroke: red })]);
    expect(drawReducer(s, { type: "recolor", from: red, to: green })).toBe(s); // no selection
    s = drawReducer(s, { type: "select", ids: ["r1"] });
    expect(drawReducer(s, { type: "recolor", from: blue, to: green })).toBe(s); // no match
    expect(drawReducer(s, { type: "recolor", from: red, to: red })).toBe(s); // self-drop
  });

  it("refill merges a fill class: none→c fills exactly the unfilled, c→none strips exactly that class", () => {
    let s = seeded([
      box("r1", { fill: red }),
      box("r2"),
      { id: "l1", type: "line", stroke: "#000", strokeWidth: 3, points: [0, 0, 9, 9] } as Shape,
    ]);
    const pref = s.fill;
    s = drawReducer(s, { type: "select", ids: ["r1", "r2", "l1"] });
    s = drawReducer(s, { type: "refill", from: null, to: green });
    expect(s.shapes.find((sh) => sh.id === "r2")).toMatchObject({ fill: green });
    expect(s.shapes.find((sh) => sh.id === "r1")).toMatchObject({ fill: red }); // other class untouched
    expect("fill" in s.shapes.find((sh) => sh.id === "l1")!).toBe(false); // segments can't fill
    s = drawReducer(s, { type: "refill", from: red, to: null });
    expect("fill" in s.shapes.find((sh) => sh.id === "r1")!).toBe(false); // stripped (docs stay slim)
    expect(s.shapes.find((sh) => sh.id === "r2")).toMatchObject({ fill: green }); // survives
    expect(s.past).toHaveLength(2); // two discrete refill commits (select doesn't push)
    expect(s.fill).toBe(pref); // ambient pref untouched
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes.find((sh) => sh.id === "r1")).toMatchObject({ fill: red });
  });
});

describe("drawReducer — text size (S/M/L) via stroke slots", () => {
  it("stroke width sets fontSize on a selected TEXT (not strokeWidth)", () => {
    let s = seeded([text("t1", { fontSize: 18 })]);
    s = drawReducer(s, { type: "select", ids: ["t1"] });
    s = drawReducer(s, { type: "setStrokeWidth", width: 10 });
    const t = s.shapes[0] as TextShape;
    expect(t.fontSize).toBe(44); // fontForStroke(10)
    expect(s.strokeWidth).toBe(10);
  });
});

describe("legacy label migration — bound labels become free text shapes on load", () => {
  it("an area label becomes a centered text bonded to its old owner (and follows it)", () => {
    const s = initialDrawState({
      width: 400,
      height: 300,
      shapes: [box("r1", { x: 100, y: 100, width: 120, height: 80, label: "DB" })],
    });
    expect(s.shapes.find((sh) => sh.id === "r1")!.label).toBeUndefined();
    const t = s.shapes.find((sh) => sh.type === "text") as TextShape;
    expect(t.text).toBe("DB");
    expect(t.fontSize).toBe(26); // labelFont of a 120×80 box — the size it rendered at
    const b = boundingBox(t);
    expect(b.x + b.width / 2).toBeCloseTo(160); // centered where the label sat
    expect(b.y + b.height / 2).toBeCloseTo(140);
    expect(t.attach).toMatchObject({ id: "r1", kind: "box", ax: 0.5, ay: 0.5 });
    let s2 = drawReducer(s, { type: "beginGesture" });
    // Drag as the editor does: the move cluster expands to glued followers.
    s2 = drawReducer(s2, { type: "translateShapes", ids: moveClusterIds(s.shapes, ["r1"]), dx: 20, dy: 0 });
    s2 = drawReducer(s2, { type: "endGesture" });
    const t2 = s2.shapes.find((sh) => sh.type === "text") as TextShape;
    expect(t2.x).toBeCloseTo(t.x + 20); // the bond carries the caption along
  });

  it("a stroke chip label becomes a free text at the chip position (strokes aren't attach parents)", () => {
    const s = initialDrawState({
      width: 400,
      height: 300,
      shapes: [{ id: "l1", type: "line", stroke: "#e5484d", strokeWidth: 3, points: [40, 40, 140, 40], label: "wire" }],
    });
    expect(s.shapes.find((sh) => sh.id === "l1")!.label).toBeUndefined();
    const t = s.shapes.find((sh) => sh.type === "text") as TextShape;
    expect(t.text).toBe("wire");
    expect(t.fontSize).toBe(15); // the chip's fixed size
    const b = boundingBox(t);
    expect(b.x + b.width / 2).toBeCloseTo(90); // segment midpoint — where the chip hung
    expect(b.y + b.height / 2).toBeCloseTo(40);
    expect(t.attach).toBeUndefined();
  });

  it("label-free shape arrays pass through migrateLabels untouched (identity)", () => {
    const shapes: Shape[] = [box("r1"), text("t1")];
    expect(migrateLabels(shapes)).toBe(shapes);
  });
});

describe("drawReducer — marquee hit-test", () => {
  it("selects shapes whose bbox intersects the marquee", () => {
    const shapes: Shape[] = [box("r1", { x: 0, y: 0, width: 20, height: 20 }), box("r2", { x: 200, y: 200, width: 20, height: 20 })];
    expect(shapesInMarquee(shapes, { x: -5, y: -5, width: 40, height: 40 })).toEqual(["r1"]);
    expect(shapesInMarquee(shapes, { x: -5, y: -5, width: 300, height: 300 })).toEqual(["r1", "r2"]);
    expect(shapesInMarquee(shapes, { x: 50, y: 50, width: 20, height: 20 })).toEqual([]);
  });

  it("handles a marquee dragged up-left (negative extent)", () => {
    const shapes: Shape[] = [box("r1", { x: 0, y: 0, width: 20, height: 20 })];
    expect(shapesInMarquee(shapes, { x: 30, y: 30, width: -40, height: -40 })).toEqual(["r1"]);
  });
});

describe("drawReducer — clipboard (addShapes) + paste offset", () => {
  it("addShapes appends, selects the new ones, one history entry", () => {
    let s = seeded([box("r1")]);
    s = drawReducer(s, { type: "addShapes", shapes: [box("r2"), box("r3")] });
    expect(s.shapes.map((sh) => sh.id)).toEqual(["r1", "r2", "r3"]);
    expect(s.selectedIds).toEqual(["r2", "r3"]);
    expect(s.past).toHaveLength(1);
  });

  it("offsetShape shifts box x/y and segment points", () => {
    expect(offsetShape(box("r1"), 5, 5)).toMatchObject({ x: 15, y: 15 });
    const seg = offsetShape({ id: "l", type: "line", stroke: "#000", strokeWidth: 3, points: [0, 0, 10, 0] }, 4, 4);
    expect(seg.type === "line" && seg.points).toEqual([4, 4, 14, 4]);
  });
});

describe("drawReducer — text", () => {
  it("adds and edits text, each an undoable commit", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "addShapes", shapes: [text("t1", { text: "hi" })] });
    s = drawReducer(s, { type: "setText", id: "t1", text: "hello" });
    const t = s.shapes[0];
    expect(t.type === "text" && t.text).toBe("hello");
    expect(s.past).toHaveLength(2);
  });
});

describe("drawReducer — undo/redo", () => {
  it("undo restores prior shapes and redo re-applies; selection survives if the shape does", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "beginDraw", shape: box("r1", { width: 0, height: 0 }) });
    s = drawReducer(s, { type: "updateDraw", point: { x: 60, y: 50 } });
    s = drawReducer(s, { type: "endDraw" });
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes).toHaveLength(0);
    expect(s.selectedIds).toEqual([]);
    expect(canRedo(s)).toBe(true);
    s = drawReducer(s, { type: "redo" });
    expect(s.shapes).toHaveLength(1);
    expect(canRedo(s)).toBe(false);
  });

  it("a fresh commit clears the redo stack", () => {
    let s = seeded([box("r1")]);
    s = drawReducer(s, { type: "select", ids: ["r1"] });
    s = drawReducer(s, { type: "deleteSelected" });
    s = drawReducer(s, { type: "undo" });
    expect(canRedo(s)).toBe(true);
    s = drawReducer(s, { type: "select", ids: ["r1"] });
    s = drawReducer(s, { type: "setColor", color: "#123456" });
    expect(canRedo(s)).toBe(false);
  });

  it("undo is a no-op with empty history", () => {
    const s = initialDrawState();
    expect(drawReducer(s, { type: "undo" })).toBe(s);
  });
});

describe("bindings (arrow/line cling to shapes) + containment", () => {
  const arrow = (id: string, pts: [number, number, number, number], over: Partial<Shape> = {}): Shape =>
    ({ id, type: "arrow", stroke: "#fff", strokeWidth: 3, points: pts, ...over } as Shape);

  it("nearestBindableId finds a nearby area shape, not a far one", () => {
    const rect = box("r1", { x: 100, y: 100, width: 50, height: 50 });
    expect(nearestBindableId({ x: 160, y: 125 }, [rect], "a1")).toBe("r1"); // ~10px past the border
    expect(nearestBindableId({ x: 400, y: 400 }, [rect], "a1")).toBeUndefined();
  });

  it("bindAt captures the drawn point; reflow reproduces it unchanged", () => {
    const rect = box("r1", { x: 100, y: 100, width: 50, height: 50 }); // center (125,125)
    // endpoint (160,125), other endpoint to the right at (300,125)
    const b = bindAt({ x: 160, y: 125 }, { x: 300, y: 125 }, [rect], "a1")!;
    expect(b.id).toBe("r1");
    const a = arrow("a1", [300, 125, 160, 125], { bindEnd: b });
    const out = reflowBindings([rect, a]);
    const seg = out.find((s) => s.id === "a1") as Shape & { points: number[] };
    expect(seg.points[2]).toBeCloseTo(160); // stays exactly where drawn
    expect(seg.points[3]).toBeCloseTo(125);
  });

  it("the bound endpoint ROTATES around the shape when the other end swings", () => {
    const rect = box("r1", { x: 100, y: 100, width: 50, height: 50 }); // center (125,125)
    // drawn: endpoint at (160,125) — to the RIGHT of the rect — other end at (300,125).
    const b = bindAt({ x: 160, y: 125 }, { x: 300, y: 125 }, [rect], "a1")!;
    // now the other end swings to directly ABOVE (125,-100); the bound endpoint
    // should rotate to the TOP of the rect (~x=125, y<125), not stay on the right.
    const a = arrow("a1", [125, -100, 0, 0], { bindEnd: b });
    const seg = reflowBindings([rect, a]).find((s) => s.id === "a1") as Shape & { points: number[] };
    expect(seg.points[2]).toBeCloseTo(125); // rotated to the top (x back to center)
    expect(seg.points[3]).toBeCloseTo(90); // 125 - 35 radius, above the center
  });

  it("reflowBindings drops a binding whose target no longer exists", () => {
    const out = reflowBindings([arrow("a1", [200, 200, 150, 150], { bindEnd: { id: "gone", angle: 0, gap: 10 } })]);
    expect((out[0] as Shape & { bindEnd?: unknown }).bindEnd).toBeUndefined();
  });

  it("a bound endpoint clings to a RECTANGLE's border (not a circular path) as it rotates", () => {
    // Non-square rect so a rect border differs clearly from a circle/ellipse.
    const rect = box("r1", { x: 0, y: 0, width: 200, height: 40 }); // center (100,20), hx=100 hy=20
    // draw the endpoint just past the right edge (205,20): on-border + tiny gap.
    const b = bindAt({ x: 205, y: 20 }, { x: 400, y: 20 }, [rect], "a1")!; // gap ≈ 5
    // swing the other end straight DOWN → endpoint should drop to the BOTTOM edge
    // (y ≈ 20 + 20 + gap = ~45), a rect-edge distance, not the ~105 a circle would give.
    const a = arrow("a1", [100, 400, 0, 0], { bindEnd: b });
    const seg = reflowBindings([rect, a]).find((s) => s.id === "a1") as Shape & { points: number[] };
    expect(seg.points[2]).toBeCloseTo(100); // straight below center
    expect(seg.points[3]).toBeCloseTo(45); // bottom edge (20 + hy 20) + gap 5 — NOT ~105
  });

  it("moving the bound shape drags the endpoint along (translation preserves the spot)", () => {
    const rect = box("r1", { x: 100, y: 100, width: 50, height: 50 });
    const b = bindAt({ x: 160, y: 125 }, { x: 300, y: 125 }, [rect], "a1")!;
    let s = seeded([box("r1", { x: 100, y: 100, width: 50, height: 50 }), arrow("a1", [300, 125, 160, 125], { bindEnd: b })]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "translateShapes", ids: ["r1"], dx: 100, dy: 0 });
    s = drawReducer(s, { type: "endGesture" });
    const seg = s.shapes.find((x) => x.id === "a1") as Shape & { points: number[] };
    // rect center now (225,125); the free other end is still at 300 (to the right),
    // so the endpoint keeps its +35 right offset → 225+35 = 260.
    expect(seg.points[2]).toBeCloseTo(260);
  });

  it("containedIds returns shapes fully inside a container (area shapes only)", () => {
    const big = box("big", { x: 0, y: 0, width: 200, height: 200 });
    const small = box("small", { x: 20, y: 20, width: 30, height: 30 });
    const outside = box("out", { x: 300, y: 300, width: 10, height: 10 });
    expect(containedIds([big, small, outside], ["big"])).toEqual(["small"]);
    expect(containedIds([big, small, outside], ["small"])).toEqual([]); // small contains nothing
  });
});

describe("shape-to-shape attachment", () => {
  const attachOf = (sh: Shape) => (sh as Shape & { attach?: { kind: string; ax?: number; ay?: number; dx?: number } }).attach;

  it("attachAt binds an edge-touching rect (box anchor on the near side), not a centered-inside one", () => {
    const parent = box("p", { x: 0, y: 0, width: 100, height: 100 });
    const rightChild = box("c", { x: 100, y: 40, width: 20, height: 20 }); // touching the right edge, v-centered
    const a = attachAt(rightChild, [parent])!;
    expect(a).toMatchObject({ id: "p", kind: "box", ax: 1, ay: 0.5, dx: 10, dy: 0 });
    const insideChild = box("c2", { x: 40, y: 40, width: 20, height: 20 }); // centered inside → resting, not attached
    expect(attachAt(insideChild, [parent])).toBeUndefined();
  });

  it("attachAt detects a child sitting just INSIDE a parent's edge (edge proximity, not center band)", () => {
    const parent = box("p", { x: 0, y: 0, width: 200, height: 100 });
    // right edge at 180, near the parent's right (200); center 165 is only rx=0.83 — a
    // wider child near the edge that the old center-band (>0.8 of *center*) would miss.
    const insideRight = box("c", { x: 150, y: 42, width: 30, height: 16 });
    expect(attachAt(insideRight, [parent])).toMatchObject({ id: "p", kind: "box", ax: 1 });
    // genuinely centered inside → no attach (plain containment)
    const centered = box("c2", { x: 90, y: 42, width: 20, height: 16 });
    expect(attachAt(centered, [parent])).toBeUndefined();
  });

  it("a shape resting DEEP inside a large parent is not attached (mere containment, no bind/highlight)", () => {
    const parent = box("p", { x: 0, y: 0, width: 600, height: 400 }); // large
    // 100px in from the left/top edges — well clear of any border. The old
    // parent-proportional band (25% = 150px) wrongly pinned this to the left edge.
    const resting = box("c", { x: 100, y: 100, width: 40, height: 40 });
    expect(attachAt(resting, [parent])).toBeUndefined();
    // still binds when actually dragged snug against a border (within near-touch)
    const snug = box("c2", { x: 10, y: 180, width: 40, height: 40 }); // left edge 10px from parent left
    expect(attachAt(snug, [parent])).toMatchObject({ id: "p", kind: "box", ax: 0 });
  });

  it("nearestEdgeBindableId glows near a border but NOT the deep interior (box-tool hover)", () => {
    const p = box("p", { x: 0, y: 0, width: 400, height: 300 });
    expect(nearestEdgeBindableId({ x: 200, y: 150 }, [p], "")).toBeUndefined(); // dead center → no glow
    expect(nearestEdgeBindableId({ x: 8, y: 150 }, [p], "")).toBe("p"); // 8px inside the left border → glow
    expect(nearestEdgeBindableId({ x: -10, y: 150 }, [p], "")).toBe("p"); // 10px outside → glow
    expect(nearestEdgeBindableId({ x: -40, y: 150 }, [p], "")).toBeUndefined(); // well outside → no glow
    // contrast: the interior-inclusive predicate DOES glow at the center
    expect(nearestBindableId({ x: 200, y: 150 }, [p], "")).toBe("p");
  });

  it("sideAnchor classifies a zero-size point-box to the hugged edge(s) — the hover preview's edge picker", () => {
    const p = { x: 100, y: 100, width: 200, height: 100 }; // 100..300 × 100..200
    const pt = (x: number, y: number) => ({ x, y, width: 0, height: 0 });
    expect(sideAnchor(pt(295, 150), p)).toEqual({ ax: 1, ay: 0.5 }); // 5px inside the right edge
    expect(sideAnchor(pt(310, 105), p)).toEqual({ ax: 1, ay: 0 }); // outside, hugging the top-right corner
    expect(sideAnchor(pt(200, 195), p)).toEqual({ ax: 0.5, ay: 1 }); // hugging the bottom, centered horizontally
    expect(sideAnchor(pt(200, 150), p)).toEqual({ ax: 0.5, ay: 0.5 }); // dead center — unpinned
  });

  it("attachAt uses a radial anchor for an ellipse parent", () => {
    const ell = { id: "e", type: "ellipse", stroke: "#fff", strokeWidth: 3, x: 0, y: 0, width: 100, height: 100 } as Shape;
    const child = box("c", { x: 100, y: 40, width: 20, height: 20 }); // right of the ellipse
    const a = attachAt(child, [ell]) as { kind: string; angle: number };
    expect(a.kind).toBe("radial");
    expect(a.angle).toBeCloseTo(0); // to the right of center
  });

  it("a right-attached child follows the parent on MOVE — via the size-gated cluster (new contract)", () => {
    // NEW LAW (§2.2): followers ride by INCLUSION in the translated ids (the view
    // passes moveClusterIds), not by attachment reflow. The parent (10000) is
    // heavier than the child (400) → the child is in the cluster and moves.
    let s = seeded([box("p", { x: 0, y: 0, width: 100, height: 100 }), box("c", { x: 100, y: 40, width: 20, height: 20 })]);
    s = drawReducer(s, { type: "reattach", ids: ["c"] }); // attach c to p's right side
    expect(attachOf(s.shapes.find((x) => x.id === "c")!)).toMatchObject({ id: "p", ax: 1 });
    s = drawReducer(s, { type: "beginGesture" });
    const ids = moveClusterIds(s.shapes, ["p"]);
    expect(new Set(ids)).toEqual(new Set(["p", "c"]));
    s = drawReducer(s, { type: "translateShapes", ids, dx: 50, dy: 0 });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.shapes.find((x) => x.id === "c")).toMatchObject({ x: 150 }); // followed +50
  });

  it("reflowAttachments makes a right-attached child follow the parent's RIGHT RESIZE", () => {
    let s = seeded([box("p", { x: 0, y: 0, width: 100, height: 100 }), box("c", { x: 100, y: 40, width: 20, height: 20 })]);
    s = drawReducer(s, { type: "reattach", ids: ["c"] });
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "patchShape", id: "p", patch: { width: 200 } }); // grow the right edge
    s = drawReducer(s, { type: "endGesture" });
    // child center was at x=110 (parent.right 100 + gap 10); now parent.right=200 → child center 210 → x=200
    expect(s.shapes.find((x) => x.id === "c")).toMatchObject({ x: 200 });
  });

  it("resize drags ATTACHED-inside children with the edge, but leaves contained-not-attached ones in place", () => {
    const parent = box("p", { x: 0, y: 0, width: 100, height: 100 });
    // attached just INSIDE the right edge (center 87.5,50), pinned to the right side
    const attachedInside = { ...box("a", { x: 80, y: 42.5, width: 15, height: 15 }), attach: { id: "p", kind: "box", ax: 1, ay: 0.5, dx: -12.5, dy: 0 } } as Shape;
    // resting in the CENTER, no attachment
    const restingCenter = box("c", { x: 42, y: 42, width: 16, height: 16 });
    let s = seeded([parent, attachedInside, restingCenter]);
    s = drawReducer(s, { type: "patchShape", id: "p", patch: { width: 200 } }); // grow the right edge 100 → 200
    // attached child follows the right edge (new right 200 + gap -12.5 → center 187.5 → x 180)
    expect(s.shapes.find((x) => x.id === "a")).toMatchObject({ x: 180 });
    // contained-not-attached stays put
    expect(s.shapes.find((x) => x.id === "c")).toMatchObject({ x: 42, y: 42 });
  });

  it("a box drawn edge-to-edge with a shape attaches to it (attach-on-draw)", () => {
    let s = seeded([box("p", { x: 0, y: 0, width: 100, height: 100 })]);
    s = drawReducer(s, { type: "setTool", tool: "rect" });
    s = drawReducer(s, { type: "beginDraw", shape: { id: "d", type: "rect", stroke: "#fff", strokeWidth: 3, x: 100, y: 40, width: 0, height: 0 } });
    s = drawReducer(s, { type: "updateDraw", point: { x: 122, y: 62 } }); // right edge of parent
    s = drawReducer(s, { type: "endDraw" });
    const drawn = s.shapes.find((x) => x.id === "d") as Shape & { attach?: { id: string; ax: number } };
    expect(drawn.attach).toMatchObject({ id: "p", ax: 1 });
  });

  it("reflowAttachments drops an attachment whose parent is gone", () => {
    const out = reflowAttachments(
      [{ ...box("c"), attach: { id: "gone", kind: "box", ax: 1, ay: 0.5, dx: 0, dy: 0 } } as Shape],
      new Set()
    );
    expect(attachOf(out[0])).toBeUndefined();
  });
});

describe("bond-aware text growth (a bound text grows AWAY from its glued edge)", () => {
  const shapeOf = (s: DrawState, id: string) => s.shapes.find((x) => x.id === id)!;

  it("growthOrigin: the glued edge pins per axis — seam side from the offset sign, center bond pins the center", () => {
    // Text ABOVE a parent (bond at the top seam, text outside) → bottom pinned.
    expect(growthOrigin({ id: "p", kind: "box", ax: 0.5, ay: 0, dx: -7, dy: -10 })).toEqual({ gx: 0, gy: 1 });
    // Corner bond, text up-right of the parent's top-right → left + bottom pinned.
    expect(growthOrigin({ id: "p", kind: "box", ax: 1, ay: 0, dx: 9, dy: -10 })).toEqual({ gx: 0, gy: 1 });
    // Centered caption (pure-center containment bond) → grows symmetrically.
    expect(growthOrigin({ id: "p", kind: "box", ax: 0.5, ay: 0.5, dx: 0, dy: 0 })).toEqual({ gx: 0.5, gy: 0.5 });
    // Radial above the pole: bottom pinned, sideways symmetric (the bond centers on the ray).
    expect(growthOrigin({ id: "e", kind: "radial", angle: -Math.PI / 2, gap: 20 })).toEqual({ gx: 0.5, gy: 1 });
    // Unbound → today's top-left growth.
    expect(growthOrigin(undefined)).toEqual({ gx: 0, gy: 0 });
  });

  it("setText on a bottom-glued text grows UP (bottom edge pinned) and lifts a chip bound to its top", () => {
    const parent = box("p", { x: 0, y: 100, width: 100, height: 50 });
    // "a" @10 → block 5.56×10; box y∈[85,95], bottom 5 above the parent's top seam.
    const t = { ...text("t", { x: 40, y: 85, fontSize: 10, text: "a" }), attach: { id: "p", kind: "box", ax: 0.5, ay: 0, dx: -7.2, dy: -10 } } as Shape;
    // A chip riding the TEXT's top seam from above (its follower).
    const c = { ...box("c", { x: 40, y: 70, width: 10, height: 10 }), attach: { id: "t", kind: "box", ax: 0.5, ay: 0, dx: 2.2, dy: -10 } } as Shape;
    let s = seeded([parent, t, c]);
    s = drawReducer(s, { type: "setText", id: "t", text: "a\na\na" }); // 10 → 30 tall
    expect(shapeOf(s, "t")).toMatchObject({ y: 65 }); // bottom stays 95 (65 + 30)
    expect(shapeOf(s, "c")).toMatchObject({ y: 50 }); // lifted by the same 20
    expect(shapeOf(s, "p")).toMatchObject({ y: 100 }); // the parent never moves
  });

  it("setText on a top-glued text (below the parent) keeps y and pushes a follower under it DOWN", () => {
    const parent = box("p", { x: 0, y: 0, width: 100, height: 50 });
    const t = { ...text("t", { x: 40, y: 55, fontSize: 10, text: "a" }), attach: { id: "p", kind: "box", ax: 0.5, ay: 1, dx: -7.2, dy: 10 } } as Shape;
    const f = { ...box("f", { x: 40, y: 73, width: 10, height: 10 }), attach: { id: "t", kind: "box", ax: 0.5, ay: 1, dx: 2.2, dy: 13 } } as Shape;
    let s = seeded([parent, t, f]);
    s = drawReducer(s, { type: "setText", id: "t", text: "a\na\na" });
    expect(shapeOf(s, "t")).toMatchObject({ y: 55 }); // top glued — grows down as before
    expect(shapeOf(s, "f")).toMatchObject({ y: 93 }); // rides the bottom seam down 20
  });

  it("a centered caption grows symmetrically — its center never drifts", () => {
    const parent = box("p", { x: 0, y: 0, width: 100, height: 100 });
    // "a" @10 measures as an 8×10 BLOCK (min-box floor) — center it at (50,50).
    const t = { ...text("t", { x: 46, y: 45, fontSize: 10, text: "a" }), attach: { id: "p", kind: "box", ax: 0.5, ay: 0.5, dx: 0, dy: 0 } } as Shape;
    let s = seeded([parent, t]);
    s = drawReducer(s, { type: "setText", id: "t", text: "aaa\na\na" }); // 16.68×30
    const grown = shapeOf(s, "t") as TextShape;
    expect(grown.x + lineWidth("aaa", 10) / 2).toBeCloseTo(50, 1);
    expect(grown.y + 15).toBeCloseTo(50, 1);
  });

  it("an unbound text still grows down — but a follower attached to its bottom seam rides the growth", () => {
    const t = text("t", { x: 5, y: 5, fontSize: 10, text: "a" });
    const f = { ...box("f", { x: 5, y: 23, width: 10, height: 10 }), attach: { id: "t", kind: "box", ax: 0.5, ay: 1, dx: 2.2, dy: 13 } } as Shape;
    let s = seeded([t, f]);
    s = drawReducer(s, { type: "setText", id: "t", text: "a\na" });
    expect(shapeOf(s, "t")).toMatchObject({ y: 5 });
    expect(shapeOf(s, "f")).toMatchObject({ y: 33 }); // bottom seam moved 10 down
  });

  it("radial: a text above an ellipse keeps its border gap (bottom edge pinned)", () => {
    const ell = box("e", { x: 0, y: 100, width: 100, height: 60 }); // center (50,130), semi-minor 30
    const t = { ...text("t", { x: 47.22, y: 75, fontSize: 10, text: "a" }), attach: { id: "e", kind: "radial", angle: -Math.PI / 2, gap: 20 } } as Shape;
    let s = seeded([{ ...ell, type: "ellipse" } as Shape, t]);
    s = drawReducer(s, { type: "setText", id: "t", text: "a\na\na" });
    const grown = shapeOf(s, "t") as TextShape;
    expect(grown.y).toBeCloseTo(55, 1); // bottom stays at 85 (55 + 30)
  });

  it("setStrokeWidth (the font-size slots) grows a bottom-glued text upward and lifts its follower", () => {
    const parent = box("p", { x: 0, y: 100, width: 100, height: 50 });
    const t = { ...text("t", { x: 40, y: 85, fontSize: 10, text: "a" }), attach: { id: "p", kind: "box", ax: 0.5, ay: 0, dx: -7.2, dy: -10 } } as Shape;
    const c = { ...box("c", { x: 40, y: 70, width: 10, height: 10 }), attach: { id: "t", kind: "box", ax: 0.5, ay: 0, dx: 2.2, dy: -10 } } as Shape;
    let s = seeded([parent, t, c]);
    s = drawReducer(s, { type: "select", ids: ["t"] });
    s = drawReducer(s, { type: "setStrokeWidth", width: 2 }); // fontSize 10 → 14, one line → Δh 4
    expect(shapeOf(s, "t")).toMatchObject({ y: 81, fontSize: 14 }); // bottom stays 95
    expect(shapeOf(s, "c")).toMatchObject({ y: 66 }); // lifted 4
  });
});

describe("image crop", () => {
  const imageShape = (over: Partial<Shape> = {}): Shape =>
    ({ id: "i1", type: "image", stroke: "#000", strokeWidth: 1, x: 0, y: 0, width: 200, height: 200, dataBase64: "x", mediaType: "image/png", ...over } as Shape);

  it("cropImage sets the display box + source crop; undo reverts to the full image", () => {
    let s = seeded([imageShape()]);
    s = drawReducer(s, { type: "cropImage", id: "i1", box: { x: 10, y: 10, width: 100, height: 100 }, crop: { x: 20, y: 20, width: 100, height: 100 } });
    expect(s.shapes[0]).toMatchObject({ x: 10, y: 10, width: 100, height: 100, crop: { x: 20, y: 20, width: 100, height: 100 } });
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes[0]).toMatchObject({ x: 0, y: 0, width: 200, height: 200 });
    expect((s.shapes[0] as Shape & { crop?: unknown }).crop).toBeUndefined();
  });

  it("cropImage with no crop uncrops (clears it)", () => {
    let s = seeded([imageShape({ crop: { x: 20, y: 20, width: 50, height: 50 } })]);
    s = drawReducer(s, { type: "cropImage", id: "i1", box: { x: 0, y: 0, width: 200, height: 200 }, crop: undefined });
    expect((s.shapes[0] as Shape & { crop?: unknown }).crop).toBeUndefined();
  });
});

describe("helpers", () => {
  it("normalizeBox fixes negative extent", () => {
    expect(normalizeBox(box("x", { x: 100, y: 100, width: -60, height: -40 }))).toMatchObject({ x: 40, y: 60, width: 60, height: 40 });
  });

  it("boundingBox covers each shape kind", () => {
    expect(boundingBox(box("r", { x: 5, y: 5, width: 10, height: 20 }))).toMatchObject({ x: 5, y: 5, width: 10, height: 20 });
    expect(boundingBox({ id: "l", type: "line", stroke: "#000", strokeWidth: 3, points: [0, 30, 40, 0] })).toMatchObject({ x: 0, y: 0, width: 40, height: 30 });
    expect(boundingBox({ id: "p", type: "pen", stroke: "#000", strokeWidth: 3, points: [10, 10, 20, 40] })).toMatchObject({ x: 10, y: 10, width: 10, height: 30 });
  });

  it("toDoc deep-clones shapes (no aliasing into live state)", () => {
    const s = seeded([box("r1")]);
    const doc = toDoc(s);
    (doc.shapes[0] as BoxShape).x = 999;
    expect((s.shapes[0] as BoxShape).x).toBe(10);
  });

  it("initialDrawState defaults to the adaptive ink and always opens in pen", () => {
    expect(initialDrawState(undefined, { color: "#abcdef" }).color).toBe("#abcdef");
    expect(initialDrawState().color).toBe(CONTRAST_INK);
    expect(isContrastInk(initialDrawState().color)).toBe(true);
    expect(isContrastInk("#e5484d")).toBe(false);
    expect(initialDrawState({ shapes: [box("r1")], width: 1, height: 1 }).tool).toBe("pen");
    expect(initialDrawState().tool).toBe("pen");
    expect(initialDrawState().baseTool).toBe("pen");
  });
});

// ── Size-based drag propagation: "largest drags smallest" (moveClusterIds) ──────
const att = (id: string): Attach => ({ id, kind: "box", ax: 1, ay: 0.5, dx: 0, dy: 0 });
const clusterOf = (shapes: Shape[], seeds: string[]) => new Set(moveClusterIds(shapes, seeds));
// square box of a given side, placed on the y=0 row (far apart → no containment)
const sq = (id: string, x: number, side: number, over: Partial<BoxShape> = {}): BoxShape =>
  box(id, { x, y: 0, width: side, height: side, ...over });

describe("moveClusterIds — largest drags smallest", () => {
  it("1. mixed-direction chain L–M–S: the grabbed seed's size gates propagation", () => {
    const L = sq("L", 0, 200); // area 40000
    const M = sq("M", 300, 100, { attach: att("L") }); // 10000, M.attach=L
    const S = sq("S", 500, 40, { attach: att("M") }); // 1600, S.attach=M
    const shapes = [L, M, S];
    expect(clusterOf(shapes, ["L"])).toEqual(new Set(["L", "M", "S"])); // big drags all
    expect(clusterOf(shapes, ["M"])).toEqual(new Set(["M", "S"])); // medium drags smaller
    expect(clusterOf(shapes, ["S"])).toEqual(new Set(["S"])); // small drags itself
  });

  it("2. a heavier middle node blocks its subtree", () => {
    const M = sq("M", 0, 100); // seed 10000
    const L = sq("L", 1000, 200, { attach: att("M") }); // 40000, edge M–L
    const S = sq("S", 500, 40, { attach: att("L") }); // 1600, edge L–S
    expect(clusterOf([M, L, S], ["M"])).toEqual(new Set(["M"])); // L too heavy → S unreachable
  });

  it("3. equal-weight neighbors DON'T follow — a same-size glued pair must be separable by grabbing either", () => {
    // (Semantics changed from "equal comes along": that welded same-size pairs
    // permanently — dragging either moved both, so they could never be pulled
    // apart. Equals stay independent; multi-select moves them together.)
    const A = sq("A", 0, 100);
    const B = sq("B", 300, 100, { attach: att("A") }); // equal 10000
    expect(clusterOf([A, B], ["A"])).toEqual(new Set(["A"]));
    expect(clusterOf([A, B], ["B"])).toEqual(new Set(["B"]));
  });

  it("3b. two IDENTICAL stacked shapes are separable (equal box ≠ contained)", () => {
    const A = box("A", { x: 50, y: 50, width: 120, height: 90 });
    const B = box("B", { x: 50, y: 50, width: 120, height: 90 }); // exact overlay
    expect(containedIds([A, B], ["A"])).toEqual([]); // proper containment only
    expect(containedIds([A, B], ["B"])).toEqual([]);
    expect(clusterOf([A, B], ["A"])).toEqual(new Set(["A"]));
    expect(clusterOf([A, B], ["B"])).toEqual(new Set(["B"]));
    // A strictly smaller shape inside still rides (real containment unchanged).
    const S = box("S", { x: 60, y: 60, width: 40, height: 40 });
    expect(new Set(containedIds([A, S], ["A"]))).toEqual(new Set(["S"]));
  });

  it("4. multi-seed union — a selected big shape moves even beside a tiny seed", () => {
    const L = sq("L", 0, 200);
    const M = sq("M", 300, 100, { attach: att("L") });
    const S = sq("S", 600, 40); // tiny, isolated
    const shapes = [L, M, S];
    expect(clusterOf(shapes, ["S"])).toEqual(new Set(["S"]));
    expect(clusterOf(shapes, ["L"])).toEqual(new Set(["L", "M"]));
    expect(clusterOf(shapes, ["S", "L"])).toEqual(new Set(["S", "L", "M"])); // union
  });

  it("5. contained (and contained-of-contained) ride every cluster member", () => {
    const P = box("P", { x: 0, y: 0, width: 200, height: 200 });
    const Q = box("Q", { x: 20, y: 20, width: 100, height: 100 }); // inside P
    const T = box("T", { x: 30, y: 30, width: 20, height: 20 }); // inside Q (& P)
    expect(clusterOf([P, Q, T], ["P"])).toEqual(new Set(["P", "Q", "T"]));
  });

  it("6. edge direction is irrelevant to the cluster", () => {
    const A = box("A", { x: 0, y: 0, width: 100, height: 100 }); // 10000
    const B = box("B", { x: 300, y: 0, width: 40, height: 40 }); // 1600
    const fwd = [A, { ...B, attach: att("A") }]; // B.attach=A
    const rev = [{ ...A, attach: att("B") }, B]; // A.attach=B
    expect(clusterOf(fwd, ["A"])).toEqual(clusterOf(rev, ["A"]));
    expect(clusterOf(fwd, ["B"])).toEqual(clusterOf(rev, ["B"]));
    expect(clusterOf(fwd, ["A"])).toEqual(new Set(["A", "B"]));
    expect(clusterOf(fwd, ["B"])).toEqual(new Set(["B"]));
  });

  it("6a. massless scribble: the rect grabs it; grabbing it drags only itself", () => {
    const R = box("R", { x: 100, y: 100, width: 50, height: 50 }); // 2500
    const scribble: Shape = {
      id: "sc",
      type: "pen",
      stroke: "#000",
      strokeWidth: 3,
      points: [0, 0, 300, 0, 300, 300, 0, 300, 0, 0], // encircling: bbox 300x300 ≥ R
      attach: att("R"),
    };
    const shapes = [R, scribble];
    expect(clusterWeight(scribble)).toBe(0); // massless
    expect(clusterOf(shapes, ["R"])).toEqual(new Set(["R", "sc"])); // rect drags the scribble
    expect(clusterOf(shapes, ["sc"])).toEqual(new Set(["sc"])); // scribble alone
  });

  it("6b. legacy 2-cycle terminates (equal sizes stay separable; a lighter cycle partner still rides)", () => {
    // Equal-size cycle: no follow (same-size pairs must be separable), no hang.
    const A = box("A", { x: 0, y: 0, width: 100, height: 100, attach: att("B") });
    const B = box("B", { x: 300, y: 0, width: 100, height: 100, attach: att("A") });
    expect(clusterOf([A, B], ["A"])).toEqual(new Set(["A"]));
    // Unequal cycle: traversal still crosses the cycle edge for a lighter partner.
    const L = box("L", { x: 0, y: 0, width: 100, height: 100, attach: att("S") });
    const S = box("S", { x: 300, y: 0, width: 40, height: 40, attach: att("L") });
    expect(clusterOf([L, S], ["L"])).toEqual(new Set(["L", "S"]));
  });
});

describe("drawReducer — move freeze + reattach (crossing vs intra-cluster edges)", () => {
  const attachOf = (sh?: Shape) => (sh as (Shape & { attach?: Attach }) | undefined)?.attach;

  it("7. a heavier stayer whose edge points INTO the moved set is frozen (not dragged)", () => {
    // X (40000) is attached to M (1600). Grabbing M drags only {M} (X too heavy).
    // The freeze must keep X put — today reflow would yank X toward the moved M.
    const M = box("M", { x: 300, y: 0, width: 40, height: 40 });
    const X = box("X", { x: 0, y: 0, width: 200, height: 200, attach: att("M") });
    let s = seeded([M, X]);
    s = drawReducer(s, { type: "beginGesture" });
    const ids = moveClusterIds(s.shapes, ["M"]);
    expect(new Set(ids)).toEqual(new Set(["M"])); // X too heavy → not in the cluster
    s = drawReducer(s, { type: "translateShapes", ids, dx: 100, dy: 0 });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.shapes.find((x) => x.id === "X")).toMatchObject({ x: 0, y: 0 }); // frozen
    expect(s.shapes.find((x) => x.id === "M")).toMatchObject({ x: 400 }); // moved +100
  });

  it("8. an intra-cluster edge is preserved through reattach (regression: latent bug #3)", () => {
    // Move a glued pair {p,c} rigidly, then reattach the moved set: c.attach must
    // survive (today it's dropped because candidates exclude the moved set).
    const p = box("p", { x: 0, y: 0, width: 100, height: 100 });
    const c = box("c", { x: 100, y: 40, width: 20, height: 20, attach: { id: "p", kind: "box", ax: 1, ay: 0.5, dx: 10, dy: 0 } });
    let s = seeded([p, c]);
    s = drawReducer(s, { type: "beginGesture" });
    const ids = moveClusterIds(s.shapes, ["p"]); // {p,c}
    s = drawReducer(s, { type: "translateShapes", ids, dx: 200, dy: 0 });
    s = drawReducer(s, { type: "reattach", ids });
    s = drawReducer(s, { type: "endGesture" });
    expect(attachOf(s.shapes.find((x) => x.id === "c"))?.id).toBe("p"); // preserved
    expect(s.shapes.find((x) => x.id === "c")).toMatchObject({ x: 300 }); // rode along
  });

  it("9. a crossing edge detaches on drop when dragged far (grab the small one)", () => {
    const L = box("L", { x: 0, y: 0, width: 100, height: 100 });
    const S: Shape = { ...box("S", { x: 100, y: 40, width: 20, height: 20 }), attach: { id: "L", kind: "box", ax: 1, ay: 0.5, dx: 10, dy: 0 } } as Shape;
    let s = seeded([L, S]);
    s = drawReducer(s, { type: "beginGesture" });
    const ids = moveClusterIds(s.shapes, ["S"]); // {S} — L too heavy to drag
    expect(new Set(ids)).toEqual(new Set(["S"]));
    s = drawReducer(s, { type: "translateShapes", ids, dx: 300, dy: 0 });
    s = drawReducer(s, { type: "reattach", ids });
    s = drawReducer(s, { type: "endGesture" });
    expect(attachOf(s.shapes.find((x) => x.id === "S"))).toBeUndefined(); // detached
    expect(s.shapes.find((x) => x.id === "L")).toMatchObject({ x: 0 }); // stayer unmoved
  });

  it("10. a stayer's stale edge is re-evaluated at drop (cleared when it abuts nothing)", () => {
    // X (heavy) is frozen while M departs; at drop X's stale edge to M is dropped.
    const M = box("M", { x: 300, y: 0, width: 40, height: 40 });
    const X = box("X", { x: 0, y: 0, width: 200, height: 200, attach: att("M") });
    let s = seeded([M, X]);
    s = drawReducer(s, { type: "beginGesture" });
    const ids = moveClusterIds(s.shapes, ["M"]); // {M}
    s = drawReducer(s, { type: "translateShapes", ids, dx: 500, dy: 0 });
    s = drawReducer(s, { type: "reattach", ids });
    s = drawReducer(s, { type: "endGesture" });
    expect(attachOf(s.shapes.find((x) => x.id === "X"))).toBeUndefined(); // stale edge cleared
    expect(s.shapes.find((x) => x.id === "X")).toMatchObject({ x: 0 }); // never moved
  });

  it("11. reattach re-glues a still-adjacent parent after a tiny drag (does NOT detach)", () => {
    const L = box("L", { x: 0, y: 0, width: 100, height: 100 });
    const S: Shape = { ...box("S", { x: 100, y: 40, width: 20, height: 20 }), attach: { id: "L", kind: "box", ax: 1, ay: 0.5, dx: 10, dy: 0 } } as Shape;
    let s = seeded([L, S]);
    s = drawReducer(s, { type: "beginGesture" });
    const ids = moveClusterIds(s.shapes, ["S"]); // {S}
    s = drawReducer(s, { type: "translateShapes", ids, dx: 5, dy: 0 }); // still within ATTACH_DIST
    s = drawReducer(s, { type: "reattach", ids });
    s = drawReducer(s, { type: "endGesture" });
    expect(attachOf(s.shapes.find((x) => x.id === "S"))?.id).toBe("L"); // stays glued
  });
});

describe("drawReducer — direction-agnostic resize (commitResize / reflowChildrenTo / crop)", () => {
  const attachOf = (sh?: Shape) => (sh as (Shape & { attach?: Attach }) | undefined)?.attach;

  it("12. an in-edge child follows commitResize of its parent", () => {
    const P = box("P", { x: 0, y: 0, width: 100, height: 100 });
    const C = box("C", { x: 100, y: 40, width: 20, height: 20, attach: { id: "P", kind: "box", ax: 1, ay: 0.5, dx: 10, dy: 0 } });
    let s = seeded([P, C]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "commitResize", id: "P", patch: { width: 180 } });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.shapes.find((x) => x.id === "C")).toMatchObject({ x: 180 }); // center 180+10=190
  });

  it("13. an OUT-edge neighbor follows resize — the 'attached-from-inside' repro", () => {
    // P.attach=C (edge stored the 'wrong way'): resizing P must STILL drag C.
    const P = box("P", { x: 0, y: 0, width: 100, height: 100, attach: { id: "C", kind: "box", ax: 0, ay: 0.5, dx: -50, dy: 0 } });
    const C = box("C", { x: 100, y: 40, width: 20, height: 20 });
    let s = seeded([P, C]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "commitResize", id: "P", patch: { width: 180 } });
    s = drawReducer(s, { type: "endGesture" });
    expect((s.shapes.find((x) => x.id === "C") as BoxShape).x).toBeCloseTo(180); // followed the moved edge
    expect(s.shapes.find((x) => x.id === "P")).toMatchObject({ x: 0, width: 180 }); // exactly the resize
  });

  it("14. commitResize never repositions the resized shape (no snap-back) + refreshes its anchor", () => {
    const N = box("N", { x: 0, y: 0, width: 100, height: 100 });
    const S = box("S", { x: 100, y: 40, width: 20, height: 20, attach: { id: "N", kind: "box", ax: 1, ay: 0.5, dx: 10, dy: 0 } });
    let s = seeded([N, S]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "commitResize", id: "S", patch: { width: 40 } });
    s = drawReducer(s, { type: "endGesture" });
    const sNew = s.shapes.find((x) => x.id === "S")!;
    expect(sNew).toMatchObject({ x: 100, y: 40, width: 40 }); // EXACTLY the patch — no yank-back
    const a = attachOf(sNew)!;
    expect(a.id).toBe("N");
    expect(a.kind === "box" && a.dx).toBeCloseTo(20); // anchor consistent with the new geometry
  });

  it("15. shrinking a shape away from its neighbor drops the edge", () => {
    const N = box("N", { x: 0, y: 0, width: 200, height: 200 });
    // S is pinned to N's right edge but sits INSIDE N (so N is not edge-adjacent to
    // S → N won't chase); shrink S to N's dead center → the edge must drop.
    const S = box("S", { x: 170, y: 90, width: 20, height: 20, attach: { id: "N", kind: "box", ax: 1, ay: 0.5, dx: -20, dy: 0 } });
    let s = seeded([N, S]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "commitResize", id: "S", patch: { x: 90, y: 90, width: 20, height: 20 } });
    s = drawReducer(s, { type: "endGesture" });
    expect(attachOf(s.shapes.find((x) => x.id === "S"))).toBeUndefined(); // dropped
    expect(s.shapes.find((x) => x.id === "N")).toMatchObject({ x: 0, width: 200 }); // N never moved
  });

  it("16. resizing a container leaves a contained-not-attached shape in place", () => {
    const P = box("P", { x: 0, y: 0, width: 100, height: 100 });
    const C = box("C", { x: 42, y: 42, width: 16, height: 16 }); // centered inside, no attach
    let s = seeded([P, C]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "commitResize", id: "P", patch: { width: 200 } });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.shapes.find((x) => x.id === "C")).toMatchObject({ x: 42, y: 42 });
  });

  it("17. the synthesized inverted anchor is never persisted (reflowChildrenTo & commitResize)", () => {
    const P = box("P", { x: 0, y: 0, width: 100, height: 100, attach: { id: "C", kind: "box", ax: 0, ay: 0.5, dx: -50, dy: 0 } });
    const C = box("C", { x: 100, y: 40, width: 20, height: 20 });
    let s = seeded([P, C]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "reflowChildrenTo", parentId: "P", box: { x: 0, y: 0, width: 180, height: 100 } });
    expect(attachOf(s.shapes.find((x) => x.id === "C"))).toBeUndefined(); // synthesis restored
    s = drawReducer(s, { type: "commitResize", id: "P", patch: { width: 180 } });
    s = drawReducer(s, { type: "endGesture" });
    expect(attachOf(s.shapes.find((x) => x.id === "C"))).toBeUndefined();
  });

  it("18. cropImage: an attached neighbor follows the new box; own anchor refreshed", () => {
    const I: Shape = {
      id: "I",
      type: "image",
      stroke: "#000",
      strokeWidth: 1,
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      dataBase64: "x",
      mediaType: "image/png",
      attach: { id: "R", kind: "box", ax: 0, ay: 0.5, dx: -100, dy: 0 },
    } as Shape;
    const R = box("R", { x: 200, y: 40, width: 20, height: 20 });
    let s = seeded([I, R]);
    s = drawReducer(s, { type: "cropImage", id: "I", box: { x: 0, y: 0, width: 100, height: 100 }, crop: { x: 0, y: 0, width: 100, height: 100 } });
    expect((s.shapes.find((x) => x.id === "R") as BoxShape).x).toBeCloseTo(100); // R tracked the new right edge
    expect(attachOf(s.shapes.find((x) => x.id === "I"))?.id).toBe("R"); // own anchor refreshed
    expect((s.shapes.find((x) => x.id === "I") as Shape & { crop?: unknown }).crop).toBeTruthy();
  });

  it("18a. beginGesture→commitResize→endGesture = one history entry; undo restores both shapes", () => {
    const P = box("P", { x: 0, y: 0, width: 100, height: 100, attach: { id: "C", kind: "box", ax: 0, ay: 0.5, dx: -50, dy: 0 } });
    const C = box("C", { x: 100, y: 40, width: 20, height: 20 });
    let s = seeded([P, C]);
    const before = s.past.length;
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "commitResize", id: "P", patch: { width: 180 } });
    expect(s.past.length).toBe(before); // history-neutral
    s = drawReducer(s, { type: "endGesture" });
    expect(s.past.length).toBe(before + 1); // exactly one, from endGesture
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes.find((x) => x.id === "P")).toMatchObject({ width: 100 }); // resized shape
    expect(s.shapes.find((x) => x.id === "C")).toMatchObject({ x: 100 }); // AND the followed neighbor
  });

  it("18b. commitResize on TEXT: neighbor follows the derived bbox; no snap-back", () => {
    const T = text("T", { x: 0, y: 0, text: "hello", fontSize: 20 });
    const R = box("R", { x: 60, y: 4, width: 16, height: 16, attach: { id: "T", kind: "box", ax: 1, ay: 0.5, dx: 8, dy: 0 } });
    let s = seeded([T, R]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "commitResize", id: "T", patch: { fontSize: 40 } });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.shapes.find((x) => x.id === "T")).toMatchObject({ fontSize: 40, x: 0 }); // no snap-back
    // R's center rides T's (metric-true) right edge + dx(8) → x = edge + 8 - 8.
    expect((s.shapes.find((x) => x.id === "R") as BoxShape).x).toBeCloseTo(lineWidth("hello", 40));
  });

  it("18c. reflowChildrenTo converges — the neighbor's spot is frame-order-independent (D9)", () => {
    const mk = () => {
      const P = box("P", { x: 0, y: 0, width: 100, height: 100, attach: { id: "C", kind: "box", ax: 0, ay: 0.5, dx: -50, dy: 0 } });
      const C = box("C", { x: 100, y: 40, width: 20, height: 20 });
      return drawReducer(seeded([P, C]), { type: "beginGesture" });
    };
    const finalBox = { x: 0, y: 0, width: 200, height: 100 };
    let a = mk();
    a = drawReducer(a, { type: "reflowChildrenTo", parentId: "P", box: { x: 0, y: 0, width: 150, height: 100 } });
    a = drawReducer(a, { type: "reflowChildrenTo", parentId: "P", box: finalBox });
    let b = mk();
    b = drawReducer(b, { type: "reflowChildrenTo", parentId: "P", box: finalBox });
    const ca = a.shapes.find((x) => x.id === "C") as { x: number; y: number };
    const cb = b.shapes.find((x) => x.id === "C") as { x: number; y: number };
    expect(ca.x).toBeCloseTo(cb.x);
    expect(ca.y).toBeCloseTo(cb.y);
  });
});

describe("drawReducer — attach-on-create + paste glue", () => {
  const attachOf = (sh?: Shape) => (sh as (Shape & { attach?: Attach }) | undefined)?.attach;

  it("19. a pen stroke drawn along a shape edge attaches on release", () => {
    let s = seeded([box("r", { x: 0, y: 0, width: 100, height: 100 })]);
    s = drawReducer(s, { type: "setTool", tool: "pen" });
    s = drawReducer(s, { type: "beginDraw", shape: { id: "pn", type: "pen", stroke: "#fff", strokeWidth: 3, points: [100, 20] } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 104, y: 50 } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 100, y: 80 } });
    s = drawReducer(s, { type: "endDraw" });
    expect(attachOf(s.shapes.find((x) => x.id === "pn"))?.id).toBe("r"); // glued to r's right edge
    expect(new Set(moveClusterIds(s.shapes, ["r"]))).toEqual(new Set(["r", "pn"])); // rect drags it
  });

  it("20. addShapes { detectAttach } stamps an edge-adjacent shape, not a centered one; off by default", () => {
    const p = box("p", { x: 0, y: 0, width: 100, height: 100 });
    // adjacent to p's right edge + flag → attaches
    let s = drawReducer(seeded([p]), { type: "addShapes", detectAttach: true, shapes: [text("adj", { x: 100, y: 44, text: "hi", fontSize: 18 })] });
    expect(attachOf(s.shapes.find((x) => x.id === "adj"))?.id).toBe("p");
    // centered inside + flag → TEXT center-anchors (typography: a caption keeps
    // its center offset through parent resizes; non-text stays containment-only)
    s = drawReducer(seeded([p]), { type: "addShapes", detectAttach: true, shapes: [text("mid", { x: 40, y: 44, text: "hi", fontSize: 18 })] });
    expect(attachOf(s.shapes.find((x) => x.id === "mid"))).toMatchObject({ id: "p", kind: "box", ax: 0.5, ay: 0.5 });
    // adjacent, WITHOUT the flag → never stamped
    s = drawReducer(seeded([p]), { type: "addShapes", shapes: [text("noflag", { x: 100, y: 44, text: "hi", fontSize: 18 })] });
    expect(attachOf(s.shapes.find((x) => x.id === "noflag"))).toBeUndefined();
  });

  it("21. paste (clonePastedShapes): intra-batch attach + binds remapped & kept; external edges dropped", () => {
    const P = box("P", { x: 0, y: 0, width: 100, height: 100 });
    const C = box("C", { x: 100, y: 40, width: 20, height: 20, attach: { id: "P", kind: "box", ax: 1, ay: 0.5, dx: 10, dy: 0 } });
    const A: Shape = { id: "A", type: "arrow", stroke: "#fff", strokeWidth: 3, points: [200, 50, 100, 50], bindEnd: { id: "P", angle: 0, gap: 5 } };
    const E = box("E", { x: 400, y: 0, width: 20, height: 20, attach: { id: "outside", kind: "box", ax: 0, ay: 0.5, dx: 0, dy: 0 } });
    let n = 0;
    const out = clonePastedShapes([P, C, A, E], 16, 16, () => `new${n++}`);
    const [Pn, Cn, An, En] = out;
    expect(Pn.id).toBe("new0");
    expect(Pn).toMatchObject({ x: 16, y: 16 }); // translated by the offset
    expect(attachOf(Cn)?.id).toBe("new0"); // intra-batch attach remapped to the copy
    expect((An as Shape & { bindEnd?: { id: string } }).bindEnd?.id).toBe("new0"); // bind remapped
    expect(attachOf(En)).toBeUndefined(); // external edge dropped, not re-detected
  });

  it("21a. pasting a copy at the paste offset does NOT glue it to its original (B1)", () => {
    const orig = box("orig", { x: 0, y: 0, width: 100, height: 100 });
    let n = 0;
    const [copy] = clonePastedShapes([orig], 16, 16, () => `copy${n++}`);
    expect(attachOf(copy)).toBeUndefined();
    expect(new Set(moveClusterIds([orig, copy], ["orig"]))).toEqual(new Set(["orig"])); // dragging orig leaves copy
  });

  it("21b. sequential addShapes without detectAttach never chains attaches (cascade)", () => {
    let s = seeded([]);
    s = drawReducer(s, { type: "addShapes", shapes: [box("a1", { x: 0, y: 0, width: 40, height: 40 })] });
    s = drawReducer(s, { type: "addShapes", shapes: [box("a2", { x: 12, y: 12, width: 40, height: 40 })] });
    s = drawReducer(s, { type: "addShapes", shapes: [box("a3", { x: 24, y: 24, width: 40, height: 40 })] });
    expect(s.shapes.every((sh) => !attachOf(sh))).toBe(true);
  });
});

// ── Paint order: images are a background layer; vector shapes always above ───────
const ids = (shapes: Shape[]) => paintOrder(shapes).map((s) => s.id);
const image = (id: string, over: Partial<Extract<Shape, { type: "image" }>> = {}): Shape => ({
  id, type: "image", stroke: "#000", strokeWidth: 1, x: 0, y: 0, width: 400, height: 300, dataBase64: "", mediaType: "image/png", ...over,
});

describe("paintOrder — images beneath, vector shapes on top", () => {
  it("a small rect paints above a big image (the reported nuance)", () => {
    const img = image("img", { width: 400, height: 300 });
    const small = box("r", { x: 20, y: 20, width: 40, height: 40 });
    expect(ids([small, img])).toEqual(["img", "r"]); // rect on top whatever insertion order
    expect(ids([img, small])).toEqual(["img", "r"]);
  });

  it("even a LARGE rect stays above an image", () => {
    const img = image("img", { width: 100, height: 100 });
    const big = box("big", { width: 500, height: 500 }); // bigger than the image
    expect(ids([img, big])).toEqual(["img", "big"]); // shape still on top
    expect(ids([big, img])).toEqual(["img", "big"]);
  });

  it("non-image shapes keep DRAW order (not size-sorted among themselves)", () => {
    const big = box("big", { width: 200, height: 200 });
    const small = box("small", { width: 30, height: 30 });
    expect(ids([big, small])).toEqual(["big", "small"]); // drawn big→small: small on top
    expect(ids([small, big])).toEqual(["small", "big"]); // drawn small→big: big on top
  });

  it("a stroke keeps draw order relative to other shapes (no forced top)", () => {
    const scribble: Shape = { id: "sc", type: "pen", stroke: "#000", strokeWidth: 3, points: [0, 0, 500, 500] };
    const rect = box("rect", { width: 100, height: 100 });
    expect(ids([scribble, rect])).toEqual(["sc", "rect"]); // scribble drawn first → below
    expect(ids([rect, scribble])).toEqual(["rect", "sc"]);
  });

  it("within the image layer the larger image paints lower", () => {
    const bigImg = image("big", { width: 400, height: 400 });
    const smallImg = image("small", { width: 80, height: 80 });
    const rect = box("r", { width: 50, height: 50 });
    // both images below the rect; bigger image lowest.
    expect(ids([smallImg, rect, bigImg])).toEqual(["big", "small", "r"]);
  });

  it("does not mutate the input array (model keeps insertion order)", () => {
    const input = [box("a", { width: 20, height: 20 }), image("b", { width: 200, height: 200 })];
    const before = input.map((s) => s.id);
    paintOrder(input);
    expect(input.map((s) => s.id)).toEqual(before); // ["a","b"] unchanged
  });
});

describe("drawReducer — one-use tool clusters (arm + cycle + variant memory)", () => {
  const fresh = () => initialDrawState({ shapes: [], width: 400, height: 300 });

  it("arming a cluster from a base tool selects its remembered variant (defaults)", () => {
    const s = fresh(); // shapeVariant "rect", lineVariant "arrow"
    const shape = drawReducer(s, { type: "armCluster", cluster: "shape" });
    expect(shape.tool).toBe("rect");
    const line = drawReducer(s, { type: "armCluster", cluster: "line" });
    expect(line.tool).toBe("arrow");
  });

  it("re-arming while already armed cycles the variant and remembers it", () => {
    let s = drawReducer(fresh(), { type: "armCluster", cluster: "shape" }); // rect
    s = drawReducer(s, { type: "armCluster", cluster: "shape" }); // rect → ellipse
    expect(s.tool).toBe("ellipse");
    expect(s.shapeVariant).toBe("ellipse");
    s = drawReducer(s, { type: "armCluster", cluster: "shape" }); // ellipse → rect (wraps)
    expect(s.tool).toBe("rect");
  });

  it("the connector cluster cycles line → arrow → double-arrow → line", () => {
    let s = fresh();
    s = drawReducer(s, { type: "setTool", tool: "line" }); // start on line
    expect(s.lineVariant).toBe("line");
    s = drawReducer(s, { type: "armCluster", cluster: "line" }); // line → arrow
    expect(s.tool).toBe("arrow");
    s = drawReducer(s, { type: "armCluster", cluster: "line" }); // arrow → darrow
    expect(s.tool).toBe("darrow");
    expect(s.lineVariant).toBe("darrow");
    s = drawReducer(s, { type: "armCluster", cluster: "line" }); // darrow → line (wraps)
    expect(s.tool).toBe("line");
  });

  it("the remembered variant survives a draw's snap-back to baseTool", () => {
    // Cycle the shape cluster to ellipse, then draw with it → tool resets, memory stays.
    let s = drawReducer(fresh(), { type: "armCluster", cluster: "shape" }); // rect
    s = drawReducer(s, { type: "armCluster", cluster: "shape" }); // ellipse
    s = drawReducer(s, { type: "beginDraw", shape: { id: "e1", type: "ellipse", stroke: "#000", strokeWidth: 3, x: 0, y: 0, width: 0, height: 0 } });
    s = drawReducer(s, { type: "updateDraw", point: { x: 40, y: 40 } });
    s = drawReducer(s, { type: "endDraw" });
    expect(s.tool).toBe(s.baseTool); // one-use snap-back
    expect(s.shapeVariant).toBe("ellipse"); // but the choice persists
    s = drawReducer(s, { type: "armCluster", cluster: "shape" });
    expect(s.tool).toBe("ellipse"); // re-arm returns to it
  });

  it("selecting a variant directly (setTool) updates the cluster memory", () => {
    let s = drawReducer(fresh(), { type: "setTool", tool: "ellipse" });
    expect(s.shapeVariant).toBe("ellipse");
    s = drawReducer(s, { type: "setTool", tool: "darrow" });
    expect(s.lineVariant).toBe("darrow");
    // Non-variant tools leave the memory untouched.
    s = drawReducer(s, { type: "setTool", tool: "text" });
    expect(s.shapeVariant).toBe("ellipse");
    expect(s.lineVariant).toBe("darrow");
  });

  it("arming a cluster clears the current selection", () => {
    let s = initialDrawState({ shapes: [box("r")], width: 400, height: 300 });
    s = drawReducer(s, { type: "select", ids: ["r"] });
    s = drawReducer(s, { type: "armCluster", cluster: "line" });
    expect(s.selectedIds).toEqual([]);
  });

  it("a double-arrow is an arrow shape with doubleHead, preserved through draw + clone + paste", () => {
    let s = fresh();
    s = drawReducer(s, { type: "beginDraw", shape: { id: "d1", type: "arrow", doubleHead: true, stroke: "#000", strokeWidth: 3, points: [0, 0, 0, 0] } });
    s = drawReducer(s, { type: "updateDraw", point: { x: 50, y: 0 } });
    s = drawReducer(s, { type: "endDraw" });
    const drawn = s.shapes.find((x) => x.id === "d1") as Shape & { doubleHead?: boolean };
    expect(drawn.type).toBe("arrow");
    expect(drawn.doubleHead).toBe(true);
    // offset (move) keeps the flag; paste-clone keeps it too.
    expect((offsetShape(drawn, 5, 5) as { doubleHead?: boolean }).doubleHead).toBe(true);
    const pasted = clonePastedShapes([drawn], 16, 16, (() => { let n = 0; return () => `p${n++}`; })());
    expect((pasted[0] as { doubleHead?: boolean }).doubleHead).toBe(true);
  });
});

describe("drawReducer — cluster tools retype a matching selection", () => {
  const ell = (id: string, over: Partial<BoxShape> = {}) => box(id, { type: "ellipse", ...over });
  const seg = (id: string, type: "line" | "arrow", over: Partial<Shape> = {}): Shape =>
    ({ id, type, stroke: "#000", strokeWidth: 3, points: [0, 0, 20, 0], ...over } as Shape);
  const pen = (id: string): Shape => ({ id, type: "pen", stroke: "#000", strokeWidth: 3, points: [0, 0, 5, 5] });
  const armed = (shapes: Shape[], ids: string[], cluster: "shape" | "line", pre?: (s: DrawState) => DrawState) => {
    let s = initialDrawState({ shapes, width: 400, height: 300 });
    if (pre) s = pre(s);
    s = drawReducer(s, { type: "select", ids });
    return drawReducer(s, { type: "armCluster", cluster });
  };
  const typeOf = (s: DrawState, id: string) => s.shapes.find((x) => x.id === id)!.type;

  it("a MIXED shape selection unifies to the cluster's current variant (rect)", () => {
    const s = armed([box("r"), ell("e")], ["r", "e"], "shape"); // current shapeVariant = rect
    expect(typeOf(s, "r")).toBe("rect");
    expect(typeOf(s, "e")).toBe("rect"); // ellipse coerced to current
    expect(s.selectedIds).toEqual(["r", "e"]); // selection kept
    expect(s.past.length).toBe(1); // undoable
    expect(s.tool).toBe("pen"); // tool UNCHANGED — retype does NOT arm a draw tool
  });

  it("a UNIFORM selection already matching the current variant cycles to the next", () => {
    const s = armed([box("a"), box("b")], ["a", "b"], "shape"); // both rect == current
    expect(typeOf(s, "a")).toBe("ellipse");
    expect(typeOf(s, "b")).toBe("ellipse");
    expect(s.shapeVariant).toBe("ellipse"); // memory advances too
  });

  it("a uniform selection differing from the current variant coerces to current (no cycle)", () => {
    const s = armed([ell("a"), ell("b")], ["a", "b"], "shape"); // both ellipse, current rect
    expect(typeOf(s, "a")).toBe("rect");
    expect(typeOf(s, "b")).toBe("rect");
  });

  it("connectors: unify → cycle through line/arrow/double-arrow, doubleHead tracked", () => {
    // default lineVariant = arrow. Mixed line+arrow → unify to arrow.
    let s = armed([seg("l", "line"), seg("a", "arrow")], ["l", "a"], "line");
    expect(s.shapes.every((x) => x.type === "arrow" && !(x as { doubleHead?: boolean }).doubleHead)).toBe(true);
    // all arrow == current → next = darrow (arrow + doubleHead).
    s = drawReducer(s, { type: "armCluster", cluster: "line" });
    expect(s.lineVariant).toBe("darrow");
    expect(s.shapes.every((x) => x.type === "arrow" && (x as { doubleHead?: boolean }).doubleHead === true)).toBe(true);
    // all darrow == current → next = line (doubleHead dropped).
    s = drawReducer(s, { type: "armCluster", cluster: "line" });
    expect(s.shapes.every((x) => x.type === "line" && !("doubleHead" in x))).toBe(true);
  });

  it("a single selected shape cycles its own type", () => {
    const s = armed([seg("a", "arrow")], ["a"], "line"); // arrow == current → darrow
    const a = s.shapes[0] as { type: string; doubleHead?: boolean };
    expect(a.type).toBe("arrow");
    expect(a.doubleHead).toBe(true);
  });

  it("retyping preserves geometry through the reducer (box coords survive)", () => {
    const s = armed([box("r", { x: 12, y: 34, width: 56, height: 78 })], ["r"], "shape");
    const r = s.shapes[0] as BoxShape;
    expect(r.type).toBe("ellipse"); // rect == current → cycled
    expect([r.x, r.y, r.width, r.height]).toEqual([12, 34, 56, 78]); // box untouched
  });

  it("toClusterVariant preserves points + bindings verbatim (rect↔ellipse, line↔arrow↔darrow)", () => {
    // Pure conversion — no reflow, so dangling binds are kept (reflow drops them,
    // which is tested via the reducer path elsewhere).
    const a = seg("a", "arrow", { points: [1, 2, 3, 4], bindStart: { id: "p", angle: 1, gap: 2 }, bindEnd: { id: "x", angle: 0, gap: 0 } });
    const dd = toClusterVariant(a, "darrow") as Shape & { points: number[]; doubleHead?: boolean; bindStart?: unknown; bindEnd?: unknown };
    expect(dd.type).toBe("arrow");
    expect(dd.doubleHead).toBe(true);
    expect(dd.points).toEqual([1, 2, 3, 4]);
    expect(dd.bindStart).toEqual({ id: "p", angle: 1, gap: 2 });
    expect(dd.bindEnd).toEqual({ id: "x", angle: 0, gap: 0 });
    // darrow → line drops the head flag but keeps points/binds.
    const ln = toClusterVariant(dd, "line") as Shape & { doubleHead?: boolean; points: number[] };
    expect(ln.type).toBe("line");
    expect("doubleHead" in ln).toBe(false);
    expect(ln.points).toEqual([1, 2, 3, 4]);
    // rect → ellipse keeps the box + any attach edge.
    const rr = box("r", { width: 40, height: 20, attach: { id: "q", kind: "box", ax: 1, ay: 0.5, dx: 0, dy: 0 } });
    const ee = toClusterVariant(rr, "ellipse") as BoxShape;
    expect(ee.type).toBe("ellipse");
    expect([ee.width, ee.height]).toEqual([40, 20]);
    expect(ee.attach).toEqual({ id: "q", kind: "box", ax: 1, ay: 0.5, dx: 0, dy: 0 });
  });

  it("a selection NOT wholly in the cluster falls back to arming the draw tool", () => {
    // rect + pen selected → not all shapes → normal arm (selection cleared, no retype).
    const s = armed([box("r"), pen("p")], ["r", "p"], "shape");
    expect(s.tool).toBe("rect"); // armed the draw tool
    expect(s.selectedIds).toEqual([]);
    expect(typeOf(s, "r")).toBe("rect"); // unchanged
    // rect + arrow (spans both clusters) → shape cluster arm falls back too.
    const s2 = armed([box("r"), seg("a", "arrow")], ["r", "a"], "shape");
    expect(s2.tool).toBe("rect");
    expect(s2.selectedIds).toEqual([]);
  });
});

describe("arrows/lines bind, never attach (rotation-drift regression)", () => {
  const arw = (id: string, pts: [number, number, number, number], over: Partial<Shape> = {}): Shape =>
    ({ id, type: "arrow", stroke: "#fff", strokeWidth: 3, points: pts, ...over } as Shape);

  it("attachAt returns undefined for a line/arrow child even edge-touching a container", () => {
    const rect = box("b", { x: 100, y: 100, width: 60, height: 60 });
    // arrow end sits right on the rect's left edge — a box tool WOULD attach here.
    expect(attachAt(arw("a", [10, 130, 98, 130]), [rect])).toBeUndefined();
    expect(attachAt({ id: "l", type: "line", stroke: "#000", strokeWidth: 3, points: [10, 130, 98, 130] } as Shape, [rect])).toBeUndefined();
  });

  it("moving a bound arrow (drop near a shape) never gives it an attach edge", () => {
    const rect = box("b", { x: 100, y: 100, width: 60, height: 60 });
    const bindEnd = bindAt({ x: 98, y: 130 }, { x: 10, y: 130 }, [rect], "a")!;
    let s = initialDrawState({ shapes: [rect, arw("a", [10, 130, 98, 130], { bindEnd })], width: 400, height: 300 });
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "translateShapes", ids: ["a"], dx: 0, dy: -8 });
    s = drawReducer(s, { type: "reattach", ids: ["a"] });
    s = drawReducer(s, { type: "endGesture" });
    const a = s.shapes.find((x) => x.id === "a") as Shape & { attach?: unknown; bindEnd?: unknown };
    expect(a.attach).toBeUndefined(); // NEVER attaches — it binds
    expect(a.bindEnd).toBeTruthy(); // bind survives
  });

  it("moving the target shape clings the bound end without dragging the free end (no drift)", () => {
    const rect = box("b", { x: 100, y: 100, width: 60, height: 60 }); // center (130,130)
    const bindEnd = bindAt({ x: 98, y: 130 }, { x: 10, y: 130 }, [rect], "a")!;
    let s = initialDrawState({ shapes: [rect, arw("a", [10, 130, 98, 130], { bindEnd })], width: 400, height: 300 });
    // Move ONLY the target (like dragging the shape, arrow not in the move set).
    for (let i = 0; i < 5; i++) {
      s = drawReducer(s, { type: "beginGesture" });
      s = drawReducer(s, { type: "translateShapes", ids: ["b"], dx: 5, dy: 0 });
      s = drawReducer(s, { type: "reattach", ids: ["b"] });
      s = drawReducer(s, { type: "endGesture" });
    }
    const a = s.shapes.find((x) => x.id === "a") as Shape & { points: number[]; attach?: unknown };
    expect(a.attach).toBeUndefined();
    expect(a.points[0]).toBeCloseTo(10); // free end pinned — no rotary drift pulling it
    expect(a.points[1]).toBeCloseTo(130);
    // Bound end clings 2px (gap) outside the rect's left edge: rect moved +25 → left edge 125 → 123.
    expect(a.points[2]).toBeCloseTo(123);
    expect(a.points[3]).toBeCloseTo(130);
  });
});

describe("drawReducer — viewport-scaled thresholds (minSize / distScale)", () => {
  it("cancelDraw aborts the draft, restores the pre-draw shapes, no history", () => {
    let s = seeded([box("keep")]);
    s = drawReducer(s, { type: "beginDraw", shape: box("draft", { x: 200, y: 200, width: 0, height: 0 }) });
    s = drawReducer(s, { type: "updateDraw", point: { x: 260, y: 240 } });
    s = drawReducer(s, { type: "cancelDraw" });
    expect(s.shapes.map((sh) => sh.id)).toEqual(["keep"]);
    expect(s.draftId).toBeNull();
    expect(s.gestureBase).toBeNull();
    expect(s.past).toHaveLength(0);
  });

  it("cancelDraw without a draft is a no-op", () => {
    const s = seeded([box("keep")]);
    expect(drawReducer(s, { type: "cancelDraw" })).toBe(s);
  });

  it("endDraw minSize drops a draft that would survive the default threshold", () => {
    // A 60×40 rect is a real shape at scale 1 — but at 0.05x zoom it's a 3-screen-px
    // accidental drag; the view passes minSize = 4/scale = 80 and it must be dropped.
    let s = seeded([]);
    s = drawReducer(s, { type: "beginDraw", shape: box("r1", { x: 0, y: 0, width: 0, height: 0 }) });
    s = drawReducer(s, { type: "updateDraw", point: { x: 60, y: 40 } });
    s = drawReducer(s, { type: "endDraw", minSize: 80 });
    expect(s.shapes).toHaveLength(0);
    expect(s.past).toHaveLength(0);
  });

  it("endDraw minSize judges a multi-point pen micro-scribble degenerate (bbox under threshold) → it collapses to a tap-dot", () => {
    let s = seeded([]);
    s = drawReducer(s, { type: "beginDraw", shape: { id: "p1", type: "pen", stroke: "#000", strokeWidth: 3, points: [0, 0] } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 3, y: 2 } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 5, y: 4 } });
    s = drawReducer(s, { type: "endDraw", minSize: 40 });
    const dot = s.shapes[0];
    expect(dot?.type === "pen" && dot.points).toEqual([0, 0, 0.001, 0]); // a dot, not the scribble (and not a drop)
    // …while the default threshold keeps the same stroke intact (legacy behavior).
    let k = seeded([]);
    k = drawReducer(k, { type: "beginDraw", shape: { id: "p1", type: "pen", stroke: "#000", strokeWidth: 3, points: [0, 0] } });
    k = drawReducer(k, { type: "extendFreehand", point: { x: 3, y: 2 } });
    k = drawReducer(k, { type: "endDraw" });
    const pen = k.shapes[0];
    expect(pen?.type === "pen" && pen.points).toEqual([0, 0, 3, 2]);
  });

  it("endDraw distScale widens line-endpoint binding at zoom-out", () => {
    // Endpoint 60 logical px from the rect: beyond BIND_DISTANCE (22) at scale 1,
    // but within it on SCREEN at 0.25x zoom (distScale 4 → 88 logical).
    const target = box("t", { x: 100, y: 100, width: 40, height: 30 });
    const drawLine = (distScale?: number) => {
      let s = seeded([target]);
      s = drawReducer(s, { type: "beginDraw", shape: { id: "l1", type: "line", stroke: "#000", strokeWidth: 3, points: [300, 115, 300, 115] } });
      s = drawReducer(s, { type: "updateDraw", point: { x: 200, y: 115 } });
      s = drawReducer(s, { type: "endDraw", distScale });
      return s.shapes.find((sh) => sh.id === "l1") as Shape & { bindEnd?: { id: string } };
    };
    expect(drawLine(undefined).bindEnd).toBeUndefined(); // 60px gap > 22 → no bind
    expect(drawLine(4).bindEnd?.id).toBe("t"); // 60px gap < 88 → binds
  });

  it("endDraw distScale widens box attach detection at zoom-out", () => {
    // A rect drawn 40 logical px right of the target: beyond ATTACH_DIST (16) at
    // scale 1, within it on screen at 0.25x (distScale 4 → 64 logical).
    const target = box("t", { x: 0, y: 0, width: 100, height: 100 });
    const drawRect = (distScale?: number) => {
      let s = seeded([target]);
      s = drawReducer(s, { type: "beginDraw", shape: box("r1", { x: 140, y: 20, width: 0, height: 0 }) });
      s = drawReducer(s, { type: "updateDraw", point: { x: 220, y: 80 } });
      s = drawReducer(s, { type: "endDraw", distScale });
      return s.shapes.find((sh) => sh.id === "r1")!;
    };
    expect(drawRect(undefined).attach).toBeUndefined();
    expect(drawRect(4).attach?.id).toBe("t");
  });

  it("reattach distScale glues a shape dropped near-but-not-touching at zoom-out", () => {
    const target = box("t", { x: 0, y: 0, width: 100, height: 100 });
    const mover = box("m", { x: 140, y: 20, width: 40, height: 40 });
    const run = (distScale?: number) => {
      let s = seeded([target, mover]);
      s = drawReducer(s, { type: "beginGesture" });
      s = drawReducer(s, { type: "reattach", ids: ["m"], distScale });
      return s.shapes.find((sh) => sh.id === "m")!;
    };
    expect(run(undefined).attach).toBeUndefined(); // 40px gap > 16
    expect(run(4).attach?.id).toBe("t"); // 40px gap < 64
  });

  it("addShapes distScale scales detectAttach the same way", () => {
    const target = box("t", { x: 0, y: 0, width: 100, height: 100 });
    const run = (distScale?: number) => {
      let s = seeded([target]);
      s = drawReducer(s, {
        type: "addShapes",
        detectAttach: true,
        distScale,
        shapes: [text("n", { x: 130, y: 40 })],
      });
      return s.shapes.find((sh) => sh.id === "n")!;
    };
    expect(run(undefined).attach).toBeUndefined();
    expect(run(4).attach?.id).toBe("t");
  });

  it("attachAt / bindAt / nearest* default distances are unchanged (legacy pins)", () => {
    const target = box("t", { x: 0, y: 0, width: 100, height: 100 });
    // 10px gap: inside every default range.
    expect(nearestBindableId({ x: 110, y: 50 }, [target], "")).toBe("t");
    expect(nearestEdgeBindableId({ x: 110, y: 50 }, [target], "")).toBe("t");
    // 30px gap: beyond BIND_DISTANCE(22)/EDGE_TOUCH(24) — undefined by default.
    expect(nearestBindableId({ x: 130, y: 50 }, [target], "")).toBeUndefined();
    expect(nearestEdgeBindableId({ x: 130, y: 50 }, [target], "")).toBeUndefined();
    // …but reachable with an explicit dist.
    expect(nearestBindableId({ x: 130, y: 50 }, [target], "", 40)).toBe("t");
    expect(nearestEdgeBindableId({ x: 130, y: 50 }, [target], "", 40)).toBe("t");
  });
});

describe("contentBounds", () => {
  it("unions all shape boxes and returns null when empty", async () => {
    const { contentBounds } = await import("./drawModel.ts");
    expect(contentBounds([])).toBeNull();
    const b = contentBounds([box("a", { x: -50, y: 10, width: 40, height: 30 }), box("b", { x: 100, y: -20, width: 10, height: 10 })]);
    expect(b).toEqual({ x: -50, y: -20, width: 160, height: 60 });
  });
});

describe("drawReducer — zoom-glued edges survive resize/crop (distScale on commitResize/cropImage)", () => {
  // An edge created at zoom-out (large logical gap, screen-adjacent) must not be
  // silently dropped when the shape is resized or cropped — the same screen-true
  // judgment reattach uses must apply.
  const glued = () => {
    const a = box("A", { x: 0, y: 0, width: 100, height: 100 });
    // 40px gap: valid glue at distScale 4 (ATTACH_DIST 16 → 64), invalid at 1.
    const b = box("B", { x: 140, y: 20, width: 40, height: 40, attach: { id: "A", kind: "box", ax: 1, ay: 0, dx: 60, dy: 20 } as Attach });
    return seeded([a, b]);
  };

  it("commitResize keeps a zoom-glued attach when given the creating distScale", () => {
    let s = glued();
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "commitResize", id: "B", patch: { width: 42 }, distScale: 4 });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.shapes.find((sh) => sh.id === "B")!.attach?.id).toBe("A");
  });

  it("commitResize at default distScale drops the same edge (screen-true at 1x)", () => {
    let s = glued();
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "commitResize", id: "B", patch: { width: 42 } });
    s = drawReducer(s, { type: "endGesture" });
    expect(s.shapes.find((sh) => sh.id === "B")!.attach).toBeUndefined();
  });

  it("cropImage keeps a zoom-glued attach when given the creating distScale", () => {
    const a = box("A", { x: 0, y: 0, width: 100, height: 100 });
    const img: Shape = { id: "I", type: "image", stroke: "#000", strokeWidth: 1, x: 140, y: 20, width: 40, height: 40, dataBase64: "", mediaType: "image/png", attach: { id: "A", kind: "box", ax: 1, ay: 0, dx: 60, dy: 20 } };
    let s = seeded([a, img]);
    s = drawReducer(s, { type: "cropImage", id: "I", box: { x: 140, y: 20, width: 38, height: 38 }, crop: { x: 1, y: 1, width: 30, height: 30 }, distScale: 4 });
    expect(s.shapes.find((sh) => sh.id === "I")!.attach?.id).toBe("A");
  });
});

describe("drawReducer — history is inert while a gesture/draft is in flight", () => {
  it("undo mid-draft is a no-op (no half-drawn draft can reach the redo stack)", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "beginDraw", shape: box("r1", { width: 0, height: 0 }) });
    s = drawReducer(s, { type: "updateDraw", point: { x: 60, y: 50 } });
    s = drawReducer(s, { type: "endDraw" }); // committed rect, past=1
    s = drawReducer(s, { type: "beginDraw", shape: { id: "p1", type: "pen", stroke: "#000", strokeWidth: 3, points: [0, 0] } });
    s = drawReducer(s, { type: "extendFreehand", point: { x: 30, y: 30 } });
    const held = s;
    expect(drawReducer(held, { type: "undo" })).toBe(held); // inert mid-draft
    // Release, then undo/redo behave normally and never resurrect a half-draft.
    s = drawReducer(s, { type: "endDraw" });
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes.map((sh) => sh.id)).toEqual(["r1"]);
    s = drawReducer(s, { type: "redo" });
    expect(s.shapes.map((sh) => sh.id)).toEqual(["r1", "p1"]);
  });

  it("undo/redo/deleteSelected are inert during a move gesture; endGesture still pushes once", () => {
    let s = seeded([box("A"), box("B", { x: 200, y: 200 })]);
    s = drawReducer(s, { type: "select", ids: ["A"] });
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "translateShapes", ids: ["A"], dx: 5, dy: 5 });
    const held = s;
    expect(drawReducer(held, { type: "undo" })).toBe(held);
    expect(drawReducer(held, { type: "redo" })).toBe(held);
    expect(drawReducer(held, { type: "deleteSelected" })).toBe(held);
    s = drawReducer(s, { type: "endGesture" });
    expect(s.past).toHaveLength(1); // the move committed exactly once
    expect(s.shapes.find((sh) => sh.id === "A")).toMatchObject({ x: 15, y: 15 });
  });

  it("an eraser drag (deleteShapes inside a gesture) is ONE history entry", () => {
    let s = seeded([box("A"), box("B", { x: 200, y: 200 }), box("C", { x: 300, y: 100 })]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "deleteShapes", ids: ["A"] });
    s = drawReducer(s, { type: "deleteShapes", ids: ["B"] });
    s = drawReducer(s, { type: "deleteShapes", ids: ["C"] });
    expect(s.past).toHaveLength(0); // riding the gesture, no per-hit commits
    s = drawReducer(s, { type: "endGesture" });
    expect(s.past).toHaveLength(1); // one entry for the whole swipe
    expect(s.shapes).toHaveLength(0);
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes.map((sh) => sh.id)).toEqual(["A", "B", "C"]); // one ⌘Z restores all
  });

  it("a lone deleteShapes (eraser CLICK, no gesture) still commits immediately", () => {
    let s = seeded([box("A")]);
    s = drawReducer(s, { type: "deleteShapes", ids: ["A"] });
    expect(s.shapes).toHaveLength(0);
    expect(s.past).toHaveLength(1);
  });
});

describe("stroke style (setStrokeStyle / dashFor)", () => {
  it("dashFor: solid → undefined; patterns scale with the width", () => {
    expect(dashFor(undefined, 3)).toBeUndefined();
    expect(dashFor("solid", 3)).toBeUndefined();
    expect(dashFor("dashed", 3)).toEqual([9, 6]);
    expect(dashFor("dashed", 10)).toEqual([30, 20]);
    expect(dashFor("dotted", 4)).toEqual([0.001, 10]);
  });

  it("nothing selected → just the pref, no history entry", () => {
    let s = initialDrawState();
    expect(s.strokeStyle).toBe("solid");
    s = drawReducer(s, { type: "setStrokeStyle", style: "dashed" });
    expect(s.strokeStyle).toBe("dashed");
    expect(s.past).toHaveLength(0);
  });

  it("restyles the selection (undoable); text is left alone", () => {
    let s = seeded([box("r1"), text("t1")]);
    s = drawReducer(s, { type: "select", ids: ["r1", "t1"] });
    s = drawReducer(s, { type: "setStrokeStyle", style: "dotted" });
    expect(s.shapes.find((sh) => sh.id === "r1")!.strokeStyle).toBe("dotted");
    expect(s.shapes.find((sh) => sh.id === "t1")!.strokeStyle).toBeUndefined();
    expect(s.strokeStyle).toBe("dotted");
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes.find((sh) => sh.id === "r1")!.strokeStyle).toBeUndefined();
  });

  it("live-restyles a draft mid-draw; the style survives the commit", () => {
    let s = initialDrawState();
    s = drawReducer(s, { type: "beginDraw", shape: box("d1", { width: 0, height: 0 }) });
    s = drawReducer(s, { type: "updateDraw", point: { x: 60, y: 50 } });
    s = drawReducer(s, { type: "setStrokeStyle", style: "dashed" });
    expect(s.shapes.find((sh) => sh.id === "d1")!.strokeStyle).toBe("dashed");
    s = drawReducer(s, { type: "endDraw" });
    expect(s.draftId).toBeNull();
    expect(s.shapes.find((sh) => sh.id === "d1")!.strokeStyle).toBe("dashed");
  });
});

describe("typography: text is a box (wrap width, containment anchors, box resizes)", () => {
  const tAt = (sh: Shape | undefined) => {
    const b = boundingBox(sh!);
    return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
  };

  it("bbox is wrap-aware: newlines stack lines, a boxed text is exactly its box wide", () => {
    const multi = boundingBox(text("t", { text: "aaa\nbbbbbb", fontSize: 10 }));
    expect(multi.height).toBe(20); // 2 lines × fontSize (Konva lineHeight 1)
    const boxed = boundingBox(text("t", { text: "aaa bbb ccc", fontSize: 10, width: 40 }));
    expect(boxed.width).toBe(40);
    expect(boxed.height).toBe(20); // wraps to ["aaa bbb", "ccc"]
  });

  it("text fully inside a container CENTER-anchors to it; edge-hugging text keeps the edge pin", () => {
    const r = box("r1", { x: 0, y: 0, width: 300, height: 200 });
    const centered = attachAt(text("t1", { x: 100, y: 80 }), [r]);
    expect(centered).toMatchObject({ id: "r1", kind: "box", ax: 0.5, ay: 0.5 });
    // Hugging the right edge (within EDGE_TOUCH) → the edge bond is preferred.
    const hugging = attachAt(text("t2", { x: 281, y: 90 }), [r]);
    expect(hugging).toMatchObject({ id: "r1", kind: "box", ax: 1 });
    // A rect centered inside stays plain containment — no weld for area shapes.
    expect(attachAt(box("inner", { x: 100, y: 80, width: 40, height: 30 }), [r])).toBeUndefined();
    // Nested containers: the INNERMOST wins.
    const outer = box("outer", { x: -50, y: -50, width: 500, height: 400 });
    expect(attachAt(text("t3", { x: 100, y: 80 }), [outer, r])).toMatchObject({ id: "r1" });
  });

  it("parent resize re-seats center-anchored text (offset from center preserved); edge-bonded rides its edge", () => {
    let s = seeded([box("r1", { x: 0, y: 0, width: 300, height: 200 })]);
    s = drawReducer(s, { type: "addShapes", detectAttach: true, shapes: [text("tc", { x: 100, y: 80 }), text("te", { x: 281, y: 90 })] });
    const cBefore = tAt(s.shapes.find((sh) => sh.id === "tc"));
    const eBefore = boundingBox(s.shapes.find((sh) => sh.id === "te")!);
    const edgeGap = 300 - (eBefore.x + eBefore.width); // its standoff from the right edge
    // Grow the rect 200px to the right.
    s = drawReducer(s, { type: "commitResize", id: "r1", patch: { x: 0, y: 0, width: 500, height: 200 } });
    const cAfter = tAt(s.shapes.find((sh) => sh.id === "tc"));
    expect(cAfter.cx - cBefore.cx).toBeCloseTo(100, 1); // new center moved +100
    expect(cAfter.cy - cBefore.cy).toBeCloseTo(0, 1);
    const eAfter = boundingBox(s.shapes.find((sh) => sh.id === "te")!);
    expect(500 - (eAfter.x + eAfter.width)).toBeCloseTo(edgeGap, 1); // same standoff from the NEW right edge
  });

  it("setText restamps the shape's own anchor from its new box — no jump on the next parent op", () => {
    let s = seeded([box("r1", { x: 0, y: 0, width: 300, height: 200 })]);
    s = drawReducer(s, { type: "addShapes", detectAttach: true, shapes: [text("t1", { x: 100, y: 80 })] });
    const before = tAt(s.shapes.find((sh) => sh.id === "t1"));
    s = drawReducer(s, { type: "setText", id: "t1", text: "longer caption" }); // grows, stays clear of the touch zone
    const t = s.shapes.find((sh) => sh.id === "t1") as TextShape;
    const c = tAt(t);
    // Center-bonded caption: the new box grows SYMMETRICALLY around the held
    // center (bond-aware growth) and the anchor restamps from the new box.
    expect(c.cx).toBeCloseTo(before.cx, 5);
    expect(c.cy).toBeCloseTo(before.cy, 5);
    expect(t.attach).toMatchObject({ ax: 0.5, ay: 0.5 });
    expect((t.attach as Attach & { dx: number }).dx).toBeCloseTo(c.cx - 150, 5); // dx refreshed to the NEW center
    // …and a text grown past its parent DETACHES (keep-or-drop).
    s = drawReducer(s, { type: "setText", id: "t1", text: "an enormously long caption that flows far past the right edge of the parent rectangle" });
    expect(s.shapes.find((sh) => sh.id === "t1")!.attach).toBeUndefined();
  });

  it("uniform unit scale scales the wrap box with the type; a side stretch reflows the box, glyphs unscaled", () => {
    let s = seeded([text("t1", { text: "aaa bbb ccc", fontSize: 10, width: 40 })]);
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "scaleUnit", ids: ["t1"], factor: 2, origin: { x: 0, y: 0 } });
    s = drawReducer(s, { type: "endGesture" });
    let t = s.shapes.find((sh) => sh.id === "t1") as TextShape;
    expect(t.fontSize).toBe(20);
    expect(t.width).toBe(80); // same lines, bigger type
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "stretchUnit", ids: ["t1"], fx: 1.5, fy: 1, origin: { x: 0, y: 0 } });
    s = drawReducer(s, { type: "endGesture" });
    t = s.shapes.find((sh) => sh.id === "t1") as TextShape;
    expect(t.fontSize).toBe(20); // glyphs untouched
    expect(t.width).toBe(120); // the box stretched — lines reflow
  });
});

describe("the lane — hue families, shades, cycling (setShade / cyclePaint / cycleShade)", () => {
  const sel = (s: DrawState, ids: string[]) => drawReducer(s, { type: "select", ids });

  it("SHADES integrity: 5 lowercase distinct rungs per family, classic ink at BASE_SHADE; familyOf/shadeIndexOf round-trip", () => {
    for (const f of HUE_FAMILIES) {
      const ramp = SHADES[f];
      expect(ramp).toHaveLength(5);
      expect(new Set(ramp).size).toBe(5);
      ramp.forEach((c, i) => {
        expect(c).toBe(c.toLowerCase());
        expect(familyOf(c)).toBe(f);
        expect(familyOf(c.toUpperCase())).toBe(f); // case-insensitive
        expect(shadeIndexOf(c)).toBe(i);
      });
      // Adaptive ink stays honest over the extremes used as FILLS: bright ink
      // on the darkest rung, dark ink on the lightest tint.
      expect(contrastSolidOver(ramp[4])).toBe(CONTRAST_BRIGHT);
      expect(contrastSolidOver(ramp[0])).toBe(CONTRAST_DARK);
      // The ramp darkens strictly rung by rung, and its bright pole stays a
      // clearly-colored pastel — never washed toward white (lum ceiling).
      for (let i = 1; i < ramp.length; i++) expect(hexLum(ramp[i])).toBeLessThan(hexLum(ramp[i - 1]));
      expect(hexLum(ramp[0])).toBeLessThan(0.8);
      expect(hexLum(ramp[0])).toBeGreaterThan(0.55);
    }
    // The classic toolbar inks ARE the base rung of each family.
    expect(HUE_FAMILIES.map((f) => SHADES[f][BASE_SHADE])).toEqual([...INK_COLORS]);
    expect(familyOf(CONTRAST_INK)).toBeNull();
    expect(familyOf("#ffffff")).toBeNull();
    expect(shadeIndexOf("#ffffff")).toBe(-1);
  });

  it("selecting pulls the selection's shades into the lane (durable sync, no history)", () => {
    const s0 = seeded([
      box("A", { stroke: "#7a1e22", fill: "#86b2f9" }), // darkest red stroke, lightest blue fill
      box("B", { stroke: CONTRAST_INK }),
    ]);
    expect(s0.strokeShades.red).toBe("#e5484d");
    const s1 = sel(s0, ["A", "B"]);
    expect(s1.strokeShades.red).toBe("#7a1e22"); // pulled by the selection
    expect(s1.fillShades.blue).toBe("#86b2f9"); // pulled at the OTHER level
    expect(s1.strokeShades.blue).toBe("#3b82f6"); // stroke blue untouched
    expect(s1.fillShades.red).toBe(SHADES.red[0]); // fill red untouched (the default pastel)
    expect(s1.past).toHaveLength(0); // sync is pref-like — no history entry
    const s2 = sel(s1, []);
    expect(s2.strokeShades.red).toBe("#7a1e22"); // durable past deselect
  });

  it("setShade retunes the lane; nothing selected → it just stays; ambient follows only within its family", () => {
    const s0 = seeded([]);
    const s1 = drawReducer(s0, { type: "setShade", level: "stroke", family: "red", shade: "#b02f35" });
    expect(s1.strokeShades.red).toBe("#b02f35");
    expect(s1.fillShades.red).toBe(SHADES.red[0]); // levels are independent
    expect(s1.color).toBe(CONTRAST_INK); // adaptive ambient does NOT follow
    expect(s1.past).toHaveLength(0);
    // Ambient inside the family follows the retune (the pen keeps painting red).
    const s2 = drawReducer(s1, { type: "setColor", color: "#b02f35" });
    const s3 = drawReducer(s2, { type: "setShade", level: "stroke", family: "red", shade: "#7a1e22" });
    expect(s3.color).toBe("#7a1e22");
    // No-op / invalid picks return the state untouched (no churn).
    expect(drawReducer(s3, { type: "setShade", level: "stroke", family: "red", shade: "#7a1e22" })).toBe(s3);
    expect(drawReducer(s3, { type: "setShade", level: "stroke", family: "blue", shade: "#7a1e22" })).toBe(s3); // shade ∉ family
  });

  it("setShade with a selection repaints that family's classes at that level — one undo step, other families/levels untouched", () => {
    const s0 = sel(
      seeded([
        box("A", { stroke: "#e5484d" }),
        box("B", { stroke: "#b02f35", fill: "#e5484d" }), // a second red rung + a red fill
        box("C", { stroke: "#3b82f6" }),
      ]),
      ["A", "B", "C"]
    );
    const strokes = (st: DrawState) => st.shapes.map((sh) => sh.stroke);
    const s1 = drawReducer(s0, { type: "setShade", level: "stroke", family: "red", shade: "#7a1e22" });
    expect(strokes(s1)).toEqual(["#7a1e22", "#7a1e22", "#3b82f6"]); // the whole family unifies
    expect((s1.shapes[1] as BoxShape).fill).toBe("#e5484d"); // fill level untouched
    expect(s1.past).toHaveLength(1);
    expect(s1.selectedIds).toEqual(["A", "B", "C"]);
    expect(strokes(drawReducer(s1, { type: "undo" }))).toEqual(["#e5484d", "#b02f35", "#3b82f6"]);
    // Fill level: retune red's FILL rung — only B's fill moves, strokes stay.
    const s2 = drawReducer(s0, { type: "setShade", level: "fill", family: "red", shade: "#eb7074" });
    expect((s2.shapes[1] as BoxShape).fill).toBe("#eb7074");
    expect(strokes(s2)).toEqual(["#e5484d", "#b02f35", "#3b82f6"]);
    expect(s2.fillShades.red).toBe("#eb7074");
  });

  it("cyclePaint walks the lane with the ARMED shades; wraps through the specials; selection repaints like a click", () => {
    let st = seeded([]);
    st = drawReducer(st, { type: "setShade", level: "stroke", family: "red", shade: "#7a1e22" });
    st = drawReducer(st, { type: "cyclePaint", level: "stroke" });
    expect(st.color).toBe("#7a1e22"); // adaptive → red's ARMED shade, not the base
    st = drawReducer(st, { type: "cyclePaint", level: "stroke" });
    expect(st.color).toBe("#f5a623");
    st = drawReducer(st, { type: "cyclePaint", level: "stroke" });
    st = drawReducer(st, { type: "cyclePaint", level: "stroke" });
    expect(st.color).toBe("#3b82f6");
    st = drawReducer(st, { type: "cyclePaint", level: "stroke" });
    expect(st.color).toBe(CONTRAST_INK); // wraps to adaptive
    // Fill lane: none → red → … → blue → none, each column contributing its
    // ARMED fill shade — out of the box that's the pastels, not the bases.
    st = drawReducer(st, { type: "cyclePaint", level: "fill" });
    expect(st.fill).toBe(SHADES.red[0]);
    for (let i = 0; i < 3; i++) st = drawReducer(st, { type: "cyclePaint", level: "fill" });
    expect(st.fill).toBe(SHADES.blue[0]);
    st = drawReducer(st, { type: "cyclePaint", level: "fill" });
    expect(st.fill).toBeNull();
    // With a selection it applies exactly like a toolbar click.
    const s0 = sel(seeded([box("A", { stroke: CONTRAST_INK })]), ["A"]);
    const s1 = drawReducer(s0, { type: "cyclePaint", level: "stroke" });
    expect(s1.shapes[0].stroke).toBe("#e5484d");
    expect(s1.past).toHaveLength(1);
  });

  it("cycleShade digs into the current column (ambient, or the selection's single column); mixed → no-op", () => {
    let st = seeded([]);
    st = drawReducer(st, { type: "setColor", color: "#30a46c" });
    st = drawReducer(st, { type: "cycleShade", level: "stroke" });
    expect(st.strokeShades.green).toBe("#1f7a4e"); // base → one rung darker
    expect(st.color).toBe("#1f7a4e"); // ambient followed
    st = drawReducer(st, { type: "cycleShade", level: "stroke" });
    st = drawReducer(st, { type: "cycleShade", level: "stroke" });
    expect(st.color).toBe(SHADES.green[0]); // wrapped past darkest to the lightest tint
    expect(st.fillShades.green).toBe(SHADES.green[0]); // fill level independent (still its default pastel)
    // A single-family selection digs THAT family even under adaptive ambient.
    const s0 = sel(seeded([box("A", { stroke: "#e5484d" })]), ["A"]);
    const s1 = drawReducer(s0, { type: "cycleShade", level: "stroke" });
    expect(s1.shapes[0].stroke).toBe("#b02f35");
    expect(s1.color).toBe(CONTRAST_INK); // adaptive ambient stays put
    // Mixed families → no guessing, identity no-op.
    const m0 = sel(seeded([box("A", { stroke: "#e5484d" }), box("B", { stroke: "#3b82f6" })]), ["A", "B"]);
    expect(drawReducer(m0, { type: "cycleShade", level: "stroke" })).toBe(m0);
  });
});

describe("the specials column — smart / none + the gray ramp", () => {
  const sel = (s: DrawState, ids: string[]) => drawReducer(s, { type: "select", ids });

  it("GRAYS integrity: 5 distinct lowercase rungs, poles ARE the adaptive resolutions, strictly darkening; no hue family claims them", () => {
    expect(GRAYS).toHaveLength(5);
    expect(new Set(GRAYS).size).toBe(5);
    expect(GRAYS[0]).toBe(CONTRAST_BRIGHT); // "basically white" — the bright adaptive ink
    expect(GRAYS[4]).toBe(CONTRAST_DARK); // "basically black" — the dark adaptive ink
    for (const g of GRAYS) {
      expect(g).toBe(g.toLowerCase());
      expect(familyOf(g)).toBeNull();
      expect(shadeIndexOf(g)).toBe(-1);
    }
    for (let i = 1; i < GRAYS.length; i++) expect(hexLum(GRAYS[i])).toBeLessThan(hexLum(GRAYS[i - 1]));
    // Adaptive ink stays honest over grays used as fills.
    expect(contrastSolidOver(GRAYS[0])).toBe(CONTRAST_DARK);
    expect(contrastSolidOver(GRAYS[4])).toBe(CONTRAST_BRIGHT);
  });

  it("defaults: strokes arm the bases, fills arm the PASTEL pole; specials arm smart / none", () => {
    const s = initialDrawState();
    for (const f of HUE_FAMILIES) {
      expect(s.strokeShades[f]).toBe(SHADES[f][BASE_SHADE]); // classic inks up top
      expect(s.fillShades[f]).toBe(SHADES[f][0]); // softer fills out of the box
      expect(hexLum(s.fillShades[f])).toBeGreaterThan(hexLum(s.strokeShades[f]));
    }
    expect(s.strokeSpecial).toBe(CONTRAST_INK);
    expect(s.fillSpecial).toBeNull();
  });

  it("setShade on the gray column retunes the specials slot; ambient follows only when it operates in the column", () => {
    const s0 = seeded([]);
    const s1 = drawReducer(s0, { type: "setShade", level: "stroke", family: "gray", shade: "#7d7d7d" });
    expect(s1.strokeSpecial).toBe("#7d7d7d");
    expect(s1.color).toBe("#7d7d7d"); // adaptive ambient IS a specials class — it follows
    expect(s1.past).toHaveLength(0);
    // Arm smart back: the ambient (now a gray — still in-column) follows home.
    const s2 = drawReducer(s1, { type: "setShade", level: "stroke", family: "gray", shade: CONTRAST_INK });
    expect(s2.strokeSpecial).toBe(CONTRAST_INK);
    expect(s2.color).toBe(CONTRAST_INK);
    // A hue ambient is NOT in the column: the lane retunes, the pen stays red.
    const r0 = drawReducer(seeded([]), { type: "setColor", color: "#e5484d" });
    const r1 = drawReducer(r0, { type: "setShade", level: "stroke", family: "gray", shade: "#111111" });
    expect(r1.strokeSpecial).toBe("#111111");
    expect(r1.color).toBe("#e5484d");
    // Fill level: none ambient follows into the gray, and back to none.
    const f1 = drawReducer(s0, { type: "setShade", level: "fill", family: "gray", shade: "#454545" });
    expect(f1.fillSpecial).toBe("#454545");
    expect(f1.fill).toBe("#454545");
    const f2 = drawReducer(f1, { type: "setShade", level: "fill", family: "gray", shade: null });
    expect(f2.fillSpecial).toBeNull();
    expect(f2.fill).toBeNull();
    // No-ops / invalid picks return the state untouched.
    expect(drawReducer(s2, { type: "setShade", level: "stroke", family: "gray", shade: CONTRAST_INK })).toBe(s2);
    expect(drawReducer(s0, { type: "setShade", level: "stroke", family: "gray", shade: "#e5484d" })).toBe(s0); // a hue is not a gray
    expect(drawReducer(s0, { type: "setShade", level: "stroke", family: "gray", shade: null })).toBe(s0); // strokes can't be none
    expect(drawReducer(s0, { type: "setShade", level: "fill", family: "gray", shade: CONTRAST_INK })).toBe(s0); // fills can't be smart
    expect(drawReducer(s0, { type: "setShade", level: "stroke", family: "red", shade: null })).toBe(s0); // hue rungs are never none
  });

  it("setShade gray with a selection unifies the column's classes at that level — smart + grays (+ none for fills), hues untouched", () => {
    const s0 = sel(
      seeded([
        box("A", { stroke: CONTRAST_INK }), // smart stroke, unfilled
        box("B", { stroke: "#111111", fill: "#b8b8b8" }), // gray stroke + gray fill
        box("C", { stroke: "#e5484d", fill: "#f19a9d" }), // red operates elsewhere
      ]),
      ["A", "B", "C"]
    );
    const strokes = (st: DrawState) => st.shapes.map((sh) => sh.stroke);
    const s1 = drawReducer(s0, { type: "setShade", level: "stroke", family: "gray", shade: "#7d7d7d" });
    expect(strokes(s1)).toEqual(["#7d7d7d", "#7d7d7d", "#e5484d"]); // smart + gray unify, red stays
    expect(s1.strokeSpecial).toBe("#7d7d7d");
    expect(s1.past).toHaveLength(1); // one undo step
    expect(strokes(drawReducer(s1, { type: "undo" }))).toEqual([CONTRAST_INK, "#111111", "#e5484d"]);
    // Fill level: none IS a class of this column — unfilled shapes gain the gray.
    const f1 = drawReducer(s0, { type: "setShade", level: "fill", family: "gray", shade: "#454545" });
    expect((f1.shapes[0] as BoxShape).fill).toBe("#454545"); // none → gray
    expect((f1.shapes[1] as BoxShape).fill).toBe("#454545"); // gray → gray
    expect((f1.shapes[2] as BoxShape).fill).toBe("#f19a9d"); // red fill stays
    // …and picking none strips exactly the column's fills.
    const f2 = drawReducer(f1, { type: "setShade", level: "fill", family: "gray", shade: null });
    expect((f2.shapes[0] as BoxShape).fill).toBeUndefined();
    expect((f2.shapes[1] as BoxShape).fill).toBeUndefined();
    expect((f2.shapes[2] as BoxShape).fill).toBe("#f19a9d");
    expect(f2.fillSpecial).toBeNull();
  });

  it("selecting pulls specials classes into the lane (smart / a gray / none), durably", () => {
    const s0 = seeded([box("A", { stroke: "#454545", fill: "#b8b8b8" }), box("B", { stroke: CONTRAST_INK })]);
    const s1 = sel(s0, ["A"]);
    expect(s1.strokeSpecial).toBe("#454545");
    expect(s1.fillSpecial).toBe("#b8b8b8");
    expect(s1.past).toHaveLength(0);
    const s2 = sel(s1, []);
    expect(s2.strokeSpecial).toBe("#454545"); // durable past deselect
    const s3 = sel(s2, ["B"]);
    expect(s3.strokeSpecial).toBe(CONTRAST_INK); // smart is a class too
    expect(s3.fillSpecial).toBeNull(); // B is unfilled — none pulls in
  });

  it("cycleShade digs the specials strip: smart → grays → wrap (fill: none → grays), ambient riding along", () => {
    let st = seeded([]);
    st = drawReducer(st, { type: "cycleShade", level: "stroke" });
    expect(st.strokeSpecial).toBe(GRAYS[0]); // smart digs into the brightest gray
    expect(st.color).toBe(GRAYS[0]);
    st = drawReducer(st, { type: "cycleShade", level: "stroke", dir: -1 });
    expect(st.color).toBe(CONTRAST_INK); // back up to smart
    st = drawReducer(st, { type: "cycleShade", level: "stroke", dir: -1 });
    expect(st.color).toBe(GRAYS[4]); // wraps to near-black
    st = drawReducer(st, { type: "cycleShade", level: "fill" });
    expect(st.fillSpecial).toBe(GRAYS[0]); // none digs the same ramp
    expect(st.fill).toBe(GRAYS[0]);
    st = drawReducer(st, { type: "cycleShade", level: "fill", dir: -1 });
    expect(st.fill).toBeNull();
    // An all-specials selection digs the strip even under a hue ambient…
    const s0 = sel(drawReducer(seeded([box("A", { stroke: CONTRAST_INK })]), { type: "setColor", color: "#e5484d" }), ["A"]);
    const s1 = drawReducer(s0, { type: "cycleShade", level: "stroke" });
    expect(s1.shapes[0].stroke).toBe(GRAYS[0]);
    expect(s1.color).toBe("#e5484d"); // the red pen is not in the column — stays
    // …and smart + hue is a MIXED selection now: no guessing, no-op.
    const m0 = sel(seeded([box("A", { stroke: CONTRAST_INK }), box("B", { stroke: "#e5484d" })]), ["A", "B"]);
    expect(drawReducer(m0, { type: "cycleShade", level: "stroke" })).toBe(m0);
  });

  it("cyclePaint's specials stop paints the ARMED special, both levels", () => {
    let st = drawReducer(seeded([]), { type: "setShade", level: "stroke", family: "gray", shade: "#111111" });
    st = drawReducer(st, { type: "setColor", color: "#e5484d" });
    st = drawReducer(st, { type: "cyclePaint", level: "stroke", dir: -1 }); // red → the specials stop
    expect(st.color).toBe("#111111"); // not smart — the armed gray
    st = drawReducer(st, { type: "cyclePaint", level: "stroke" });
    expect(st.color).toBe("#e5484d"); // a gray sits AT the specials stop — steps into red
    let sf = drawReducer(seeded([]), { type: "setShade", level: "fill", family: "gray", shade: "#b8b8b8" });
    sf = drawReducer(sf, { type: "setFill", fill: SHADES.red[0] });
    sf = drawReducer(sf, { type: "cyclePaint", level: "fill", dir: -1 });
    expect(sf.fill).toBe("#b8b8b8");
  });
});

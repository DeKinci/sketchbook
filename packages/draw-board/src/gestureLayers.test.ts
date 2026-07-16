import { describe, it, expect } from "vitest";
import { splitGestureLayers } from "./gestureLayers.ts";
import type { BoxShape, Shape } from "./drawModel.ts";

const box = (id: string): BoxShape => ({
  id,
  type: "rect",
  stroke: "#000",
  strokeWidth: 3,
  x: 10,
  y: 10,
  width: 40,
  height: 30,
});

describe("splitGestureLayers", () => {
  const a = box("a");
  const b = box("b");
  const shapes: Shape[] = [a, b];

  it("keeps an idle selection in the DYNAMIC layer (Transformer target must not jump layers on resize)", () => {
    // Regression: previously an idle selection stayed static, so grabbing a
    // resize handle → beginGesture → contentGesture moved the node to the
    // dynamic layer mid-drag, detaching the Transformer so nothing resized.
    const { stat, dyn } = splitGestureLayers(shapes, {
      contentGesture: false,
      baseSet: new Set(),
      selected: new Set(["a"]),
    });
    expect(dyn).toContain(a); // selected shape is dynamic while idle
    expect(stat).toEqual([b]);
  });

  it("keeps the selection dynamic once the gesture begins (no layer change)", () => {
    const { stat, dyn } = splitGestureLayers(shapes, {
      contentGesture: true,
      baseSet: new Set([a, b]),
      selected: new Set(["a"]),
    });
    expect(dyn).toContain(a);
    expect(stat).toEqual([b]);
  });

  it("puts everything in static when nothing is selected and idle", () => {
    const { stat, dyn } = splitGestureLayers(shapes, {
      contentGesture: false,
      baseSet: new Set(),
      selected: new Set(),
    });
    expect(stat).toEqual([a, b]);
    expect(dyn).toEqual([]);
  });
});

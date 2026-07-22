import { describe, it, expect } from "vitest";
import { splitGestureLayers } from "./gestureLayers.ts";
import { paintOrder, type BoxShape, type Shape } from "./drawModel.ts";

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

describe("splitGestureLayers — the dynamic layer is a contiguous TAIL of the paint order", () => {
  const a = box("a");
  const b = box("b");
  const c = box("c");
  const shapes: Shape[] = [a, b, c];

  it("keeps an idle selection in the DYNAMIC layer (Transformer target must not jump layers on resize)", () => {
    // Regression: previously an idle selection stayed static, so grabbing a
    // resize handle → beginGesture → contentGesture moved the node to the
    // dynamic layer mid-drag, detaching the Transformer so nothing resized.
    const { stat, dyn } = splitGestureLayers(shapes, {
      contentGesture: false,
      baseSet: new Set(),
      selected: new Set(["c"]),
    });
    expect(dyn).toEqual([c]);
    expect(stat).toEqual([a, b]);
  });

  it("selecting a LOW shape promotes everything above it too — selection must never change visual stacking", () => {
    // Regression: the dynamic layer paints above the static one wholesale, so
    // promoting ONLY the selected shape raised it — a selected filled box hid
    // the smaller shapes resting on it.
    const { stat, dyn } = splitGestureLayers(shapes, {
      contentGesture: false,
      baseSet: new Set(),
      selected: new Set(["a"]),
    });
    expect(stat).toEqual([]);
    expect(dyn).toEqual([a, b, c]); // relative order preserved — cross-layer z = paint order
  });

  it("mid-gesture: a restamped (new-identity) LOW shape promotes itself and the whole tail above it", () => {
    const a2 = { ...a, x: 20 }; // dragged → new identity, same paint position
    const { stat, dyn } = splitGestureLayers([a2, b, c], {
      contentGesture: true,
      baseSet: new Set([a, b, c]),
      selected: new Set(),
    });
    expect(stat).toEqual([]);
    expect(dyn).toEqual([a2, b, c]);
  });

  it("mid-gesture: an untouched prefix stays static (the bitmap cache keeps paying)", () => {
    const c2 = { ...c, x: 99 };
    const { stat, dyn } = splitGestureLayers([a, b, c2], {
      contentGesture: true,
      baseSet: new Set([a, b, c]),
      selected: new Set(),
    });
    expect(stat).toEqual([a, b]);
    expect(dyn).toEqual([c2]);
  });

  it("keeps the selection dynamic once the gesture begins (no layer change for the Transformer's target)", () => {
    const { stat, dyn } = splitGestureLayers(shapes, {
      contentGesture: true,
      baseSet: new Set([a, b, c]),
      selected: new Set(["b"]),
    });
    expect(stat).toEqual([a]);
    expect(dyn).toEqual([b, c]);
  });

  it("puts everything in static when nothing is selected and idle", () => {
    const { stat, dyn } = splitGestureLayers(shapes, {
      contentGesture: false,
      baseSet: new Set(),
      selected: new Set(),
    });
    expect(stat).toEqual([a, b, c]);
    expect(dyn).toEqual([]);
  });

  it("a selected image (paint-order FIRST) turns the board dynamic rather than rising above vector shapes", () => {
    const img = {
      id: "i",
      type: "image",
      stroke: "#000",
      strokeWidth: 1,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      dataBase64: "",
      mediaType: "image/png",
    } as Shape;
    const ordered = paintOrder([a, img, b]); // [img, a, b] — images are the background stratum
    const { stat, dyn } = splitGestureLayers(ordered, {
      contentGesture: false,
      baseSet: new Set(),
      selected: new Set(["i"]),
    });
    expect(stat).toEqual([]);
    expect(dyn).toEqual([img, a, b]); // the image stays BELOW a and b even while selected
  });
});

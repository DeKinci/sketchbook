import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  clampBounded,
  fitScale,
  fitView,
  logicalToScreen,
  padBox,
  panBy,
  screenToLogical,
  unionBox,
  visibleLogicalRect,
  zoomAt,
  type Viewport,
} from "./viewport.ts";

const v = (x: number, y: number, scale: number): Viewport => ({ x, y, scale });

describe("coordinate mapping", () => {
  it("screenToLogical inverts logicalToScreen", () => {
    const view = v(120, -40, 2.5);
    const pt = { x: 33, y: -7 };
    const round = screenToLogical(view, logicalToScreen(view, pt));
    expect(round.x).toBeCloseTo(pt.x);
    expect(round.y).toBeCloseTo(pt.y);
  });

  it("identity camera maps 1:1", () => {
    expect(logicalToScreen(v(0, 0, 1), { x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
  });
});

describe("zoomAt", () => {
  it("keeps the anchor point fixed on screen", () => {
    const view = v(50, 20, 1);
    const anchor = { x: 200, y: 150 };
    const before = screenToLogical(view, anchor);
    const zoomed = zoomAt(view, anchor, 2);
    const after = screenToLogical(zoomed, anchor);
    expect(zoomed.scale).toBe(2);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps to the scale range and returns the same object when saturated", () => {
    const atMax = v(0, 0, MAX_SCALE);
    expect(zoomAt(atMax, { x: 0, y: 0 }, 2)).toBe(atMax);
    const atMin = v(0, 0, MIN_SCALE);
    expect(zoomAt(atMin, { x: 0, y: 0 }, 0.5)).toBe(atMin);
  });

  it("honors custom clamp bounds", () => {
    const view = v(0, 0, 1);
    expect(zoomAt(view, { x: 0, y: 0 }, 0.1, 0.5).scale).toBe(0.5);
    expect(zoomAt(view, { x: 0, y: 0 }, 100, MIN_SCALE, 4).scale).toBe(4);
  });

  it("compounds: zoom in then out at the same anchor returns to start", () => {
    const view = v(-30, 80, 1.7);
    const anchor = { x: 111, y: 42 };
    const round = zoomAt(zoomAt(view, anchor, 3), anchor, 1 / 3);
    expect(round.scale).toBeCloseTo(view.scale);
    expect(round.x).toBeCloseTo(view.x);
    expect(round.y).toBeCloseTo(view.y);
  });
});

describe("panBy / visibleLogicalRect", () => {
  it("panning right moves the visible window left in logical space", () => {
    const view = v(0, 0, 2);
    const avail = { w: 400, h: 300 };
    const before = visibleLogicalRect(view, avail);
    const after = visibleLogicalRect(panBy(view, 100, 0), avail);
    expect(after.x).toBeCloseTo(before.x - 50); // 100 screen px = 50 logical at 2x
    expect(after.width).toBeCloseTo(200);
    expect(after.height).toBeCloseTo(150);
  });
});

describe("fitScale / fitView", () => {
  const avail = { w: 800, h: 600 };

  it("fits the constraining axis", () => {
    expect(fitScale({ x: 0, y: 0, width: 1600, height: 600 }, avail)).toBe(0.5);
    expect(fitScale({ x: 0, y: 0, width: 400, height: 1200 }, avail)).toBe(0.5);
  });

  it("respects maxScale (fit never zooms in past it)", () => {
    expect(fitScale({ x: 0, y: 0, width: 10, height: 10 }, avail, 1)).toBe(1);
  });

  it("centers the box, honoring a non-zero box origin", () => {
    const box = { x: 100, y: -50, width: 400, height: 300 };
    const view = fitView(box, avail, { maxScale: 2 });
    expect(view.scale).toBe(2);
    // Box center should land at container center.
    const c = logicalToScreen(view, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(c.x).toBeCloseTo(avail.w / 2);
    expect(c.y).toBeCloseTo(avail.h / 2);
  });

  it("degenerate box falls back to scale 1", () => {
    expect(fitScale({ x: 0, y: 0, width: 0, height: 10 }, avail)).toBe(1);
  });
});

describe("box helpers", () => {
  it("padBox grows every side", () => {
    expect(padBox({ x: 10, y: 20, width: 30, height: 40 }, 5)).toEqual({ x: 5, y: 15, width: 40, height: 50 });
  });

  it("unionBox covers both", () => {
    const u = unionBox({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: -5, width: 10, height: 10 });
    expect(u).toEqual({ x: 0, y: -5, width: 30, height: 15 });
  });
});

describe("clampBounded", () => {
  const doc = { x: 0, y: 0, width: 1000, height: 500 };
  const avail = { w: 500, h: 500 };
  // fitScale = min(500/1000, 500/500) = 0.5 → doc renders 500×250 at fit.

  it("floors the scale at fit (no zooming out past the doc)", () => {
    const clamped = clampBounded(v(0, 0, 0.1), doc, avail);
    expect(clamped.scale).toBe(0.5);
  });

  it("centers a letterboxed axis and pins a covered axis to its range", () => {
    const clamped = clampBounded(v(0, 0, 0.5), doc, avail);
    expect(clamped.x).toBe(0); // width covered exactly → clamp to [avail.w - w, 0] = [0,0]
    expect(clamped.y).toBe(125); // height letterboxed → centered
  });

  it("clamps pan so the doc edge never pulls inside the view when zoomed in", () => {
    // At 2x the doc is 2000×1000: x ∈ [-1500, 0], y ∈ [-500, 0].
    expect(clampBounded(v(50, 10, 2), doc, avail)).toMatchObject({ x: 0, y: 0 });
    expect(clampBounded(v(-9999, -9999, 2), doc, avail)).toMatchObject({ x: -1500, y: -500 });
    const inside = v(-700, -200, 2);
    expect(clampBounded(inside, doc, avail)).toBe(inside); // untouched → same object
  });

  it("accounts for a non-zero doc origin", () => {
    const off = { x: 100, y: 100, width: 1000, height: 500 };
    const clamped = clampBounded(v(0, 0, 2), off, avail);
    // Screen left of the box = x + 100*2 must be ≤ 0 → x ≤ -200.
    expect(clamped.x + off.x * 2).toBeLessThanOrEqual(0);
    expect(clamped.x + off.x * 2).toBeGreaterThanOrEqual(avail.w - off.width * 2);
  });
});

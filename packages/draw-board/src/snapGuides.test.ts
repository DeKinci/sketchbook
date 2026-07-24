import { describe, it, expect } from "vitest";
import { snapCenterlines, snapResize, type Box } from "./snapGuides.ts";

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });
const moving = box(100, 100, 40, 40); // center (120, 120)
const TH = 6;

describe("snapCenterlines — centerline alignment geometry", () => {
  it("no targets → no nudge, no guides", () => {
    expect(snapCenterlines(moving, [], TH)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("a target's vertical centerline within threshold pulls x and draws ONE vertical guide", () => {
    // target center cx = 124 (4 away from 120 ≤ 6); cy far → no y snap.
    const r = snapCenterlines(moving, [box(122, 300, 4, 4)], TH);
    expect(r.dx).toBe(4); // 124 - 120
    expect(r.dy).toBe(0);
    expect(r.guides).toHaveLength(1);
    expect(r.guides[0]).toMatchObject({ axis: "x", pos: 124 });
    // The line spans the snapped moving box (100..140) and the target (300..304).
    expect(r.guides[0].from).toBe(100);
    expect(r.guides[0].to).toBe(304);
  });

  it("a target's horizontal centerline within threshold pulls y and draws ONE horizontal guide", () => {
    const r = snapCenterlines(moving, [box(300, 118, 4, 4)], TH); // center (302, 120)
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0); // cy 120 == moving cy 120
    expect(r.guides).toHaveLength(1);
    expect(r.guides[0]).toMatchObject({ axis: "y", pos: 120 });
    expect(r.guides[0].from).toBe(100); // moving x 100
    expect(r.guides[0].to).toBe(304); // target right 304
  });

  it("dead-center landing snaps BOTH axes → a vertical and a horizontal guide", () => {
    const r = snapCenterlines(moving, [box(122, 122, 4, 4)], TH); // center (124, 124)
    expect(r.dx).toBe(4);
    expect(r.dy).toBe(4);
    expect(r.guides.map((g) => g.axis).sort()).toEqual(["x", "y"]);
    expect(r.guides.find((g) => g.axis === "x")!.pos).toBe(124);
    expect(r.guides.find((g) => g.axis === "y")!.pos).toBe(124);
  });

  it("beyond the threshold nothing snaps", () => {
    const r = snapCenterlines(moving, [box(126, 300, 4, 4)], TH); // cx 128, 8 away > 6
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("the NEAREST centerline wins when several are in range", () => {
    // t1 cx 123 (dist 3), t2 cx 118 (dist 2) → snap to t2.
    const r = snapCenterlines(moving, [box(121, 300, 4, 4), box(116, 300, 4, 4)], TH);
    expect(r.dx).toBe(-2); // 118 - 120
    expect(r.guides[0].pos).toBe(118);
  });

  it("a guide spans EVERY shape sharing the snapped centerline (connects them all)", () => {
    // Three shapes on cx = 120: the moving box already there, two targets far apart.
    const r = snapCenterlines(moving, [box(118, 300, 4, 4), box(118, 500, 4, 4)], TH);
    expect(r.dx).toBe(0);
    expect(r.guides).toHaveLength(1);
    expect(r.guides[0]).toMatchObject({ axis: "x", pos: 120, from: 100, to: 504 });
  });
});

describe("snapResize — centerline snapping while resizing (anchor-aware)", () => {
  const old = box(100, 100, 40, 40); // center (120, 120)
  const target = (lx: number) => box(lx - 2, 300, 4, 4); // a tiny box whose cx = lx

  it("dragging the RIGHT edge snaps the width so the center hits the target — left edge holds", () => {
    const next = box(100, 100, 46, 40); // right edge 140→146, left fixed; center 123
    const r = snapResize(next, old, [target(124)], TH);
    expect(r.box.x).toBe(100); // left anchor held
    expect(r.box.width).toBe(48); // widened so center = 124
    expect(r.box.x + r.box.width / 2).toBe(124);
    expect(r.guides).toHaveLength(1);
    expect(r.guides[0]).toMatchObject({ axis: "x", pos: 124 });
  });

  it("dragging the LEFT edge snaps by moving the left — right edge holds", () => {
    const next = box(94, 100, 46, 40); // left 100→94, right fixed at 140; center 117
    const r = snapResize(next, old, [target(114)], TH);
    expect(r.box.x + r.box.width).toBe(140); // right anchor held
    expect(r.box.x).toBe(88); // 2*114 - 140
    expect(r.box.x + r.box.width / 2).toBe(114);
  });

  it("a horizontal-only resize never snaps the vertical center (that axis didn't move)", () => {
    const next = box(100, 100, 46, 40); // only x edges moved
    const r = snapResize(next, old, [box(300, 118, 4, 4)], TH); // a target with cy = 120
    expect(r.box.y).toBe(100);
    expect(r.box.height).toBe(40); // untouched
    expect(r.guides.some((g) => g.axis === "y")).toBe(false);
  });

  it("beyond the threshold the resize passes through unchanged", () => {
    const next = box(100, 100, 70, 40); // center 135 — 11 away from 124 > 6
    const r = snapResize(next, old, [target(124)], TH);
    expect(r.box).toEqual(next);
    expect(r.guides).toEqual([]);
  });

  it("a corner drag can snap BOTH axes independently", () => {
    const next = box(100, 100, 46, 46); // right + bottom dragged; center (123, 123)
    const r = snapResize(next, old, [target(124), box(300, 122, 4, 4)], TH); // cx 124, cy 124
    expect(r.box.x + r.box.width / 2).toBe(124);
    expect(r.box.y + r.box.height / 2).toBe(124);
    expect(r.guides.map((g) => g.axis).sort()).toEqual(["x", "y"]);
  });
});

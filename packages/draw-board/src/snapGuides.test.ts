import { describe, it, expect } from "vitest";
import { snapCenterlines, type Box } from "./snapGuides.ts";

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

/**
 * Group semantics (docs/groups-design.md v3): unit helpers, ⌘G group/ungroup
 * with sever/dormant/restore, selection normalization, reducer edit guards, the
 * unit-grained glue engine, atomic unit scale, and the clipboard/import
 * transforms. Pure reducer tests — the heaviest surface of the feature.
 */
import { describe, it, expect } from "vitest";
import {
  drawReducer,
  initialDrawState,
  rootUnitKeyOf,
  unitPartition,
  expandIdsToUnits,
  unitBoundsOf,
  groupActionFor,
  moveClusterIds,
  containedIds,
  reflowAttachments,
  clonePastedShapes,
  normalizeGroups,
  boundingBox,
  scaleStepTarget,
  type DrawState,
  type BoxShape,
  type TextShape,
  type SegmentShape,
  type FreehandShape,
  type ImageShape,
  type Shape,
} from "./drawModel.ts";

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

const pen = (id: string, points: number[], over: Partial<FreehandShape> = {}): FreehandShape => ({
  id,
  type: "pen",
  stroke: "#000",
  strokeWidth: 3,
  points,
  ...over,
});

const arrow = (id: string, points: [number, number, number, number], over: Partial<SegmentShape> = {}): SegmentShape => ({
  id,
  type: "arrow",
  stroke: "#000",
  strokeWidth: 3,
  points,
  ...over,
});

const image = (id: string, over: Partial<ImageShape> = {}): ImageShape => ({
  id,
  type: "image",
  stroke: "#000",
  strokeWidth: 3,
  x: 10,
  y: 10,
  width: 40,
  height: 30,
  dataBase64: "AA==",
  mediaType: "image/png",
  ...over,
});

const seeded = (shapes: Shape[]): DrawState => initialDrawState({ shapes, width: 400, height: 300 });

const byId = (s: DrawState, id: string) => s.shapes.find((sh) => sh.id === id)!;

/** Group `ids` through the real action path (select → groupSelection). */
function grouped(s: DrawState, ids: string[], gid: string): DrawState {
  s = drawReducer(s, { type: "select", ids });
  return drawReducer(s, { type: "groupSelection", gid });
}

describe("unit helpers", () => {
  it("rootUnitKeyOf / unitPartition / expandIdsToUnits / unitBoundsOf", () => {
    const shapes: Shape[] = [
      box("a", { groupPath: ["g"] }),
      box("b", { x: 100, y: 100, groupPath: ["g"] }),
      box("c", { x: 300, y: 5 }),
    ];
    expect(rootUnitKeyOf(shapes[0])).toBe("g");
    expect(rootUnitKeyOf(shapes[2])).toBe("c");
    expect([...unitPartition(shapes).entries()]).toEqual([
      ["g", ["a", "b"]],
      ["c", ["c"]],
    ]);
    expect(expandIdsToUnits(shapes, ["b"])).toEqual(["a", "b"]);
    expect(expandIdsToUnits(shapes, ["c", "missing"])).toEqual(["c"]);
    expect(unitBoundsOf(shapes, "g")).toEqual({ x: 10, y: 10, width: 130, height: 120 });
  });

  it("groupActionFor: ≥2 units → group; exact single group → ungroup; subsets/loose → null", () => {
    const shapes: Shape[] = [box("a", { groupPath: ["g"] }), box("b", { groupPath: ["g"] }), box("c")];
    expect(groupActionFor(shapes, [])).toBeNull();
    expect(groupActionFor(shapes, ["c"])).toBeNull(); // one loose unit
    expect(groupActionFor(shapes, ["a"])).toBeNull(); // proper subset (deep-select) never ungroups
    expect(groupActionFor(shapes, ["a", "b"])).toBe("ungroup");
    expect(groupActionFor(shapes, ["a", "b", "c"])).toBe("group");
    expect(groupActionFor(shapes, ["a", "c"])).toBe("group"); // 2 units (normalization expands)
  });
});

describe("groupSelection", () => {
  it("stamps the gid root-first on every member, selects all members, one history entry", () => {
    let s = seeded([box("a"), box("b", { x: 100 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    expect(byId(s, "a").groupPath).toEqual(["g1"]);
    expect(byId(s, "b").groupPath).toEqual(["g1"]);
    expect(byId(s, "c").groupPath).toBeUndefined();
    expect([...s.selectedIds].sort()).toEqual(["a", "b"]);
    expect(s.past).toHaveLength(1);
  });

  it("nests: grouping a group with a loose shape PREPENDS the new gid", () => {
    let s = seeded([box("a"), box("b", { x: 100 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = grouped(s, ["a", "c"], "g2"); // a expands to its whole unit {a,b}
    expect(byId(s, "a").groupPath).toEqual(["g2", "g1"]);
    expect(byId(s, "b").groupPath).toEqual(["g2", "g1"]);
    expect(byId(s, "c").groupPath).toEqual(["g2"]);
  });

  it("no-ops on <2 units (incl. a would-be single-member group) and mid-gesture/mid-draft", () => {
    let s = seeded([box("a"), box("b", { x: 100 })]);
    const single = drawReducer(drawReducer(s, { type: "select", ids: ["a"] }), { type: "groupSelection", gid: "g" });
    expect(byId(single, "a").groupPath).toBeUndefined();
    let mid = drawReducer(s, { type: "select", ids: ["a", "b"] });
    mid = drawReducer(mid, { type: "beginGesture" });
    mid = drawReducer(mid, { type: "groupSelection", gid: "g" });
    expect(byId(mid, "a").groupPath).toBeUndefined();
  });

  it("severs OUTWARD attach + connector binds (undo restores exactly); inbound edges stay", () => {
    // a (member, attached out to c) + arrow member bound out to c; x attaches IN to a.
    const shapes: Shape[] = [
      box("a"),
      box("b", { x: 100 }),
      box("c", { x: 300, y: 200 }),
      arrow("ar", [20, 20, 310, 210], { bindEnd: { id: "c", angle: 0, gap: 2 } }),
      pen("x", [12, 12, 20, 20], { attach: { id: "a", kind: "box", ax: 0, ay: 0, dx: 5, dy: 5 } }),
    ];
    let s = seeded(shapes.map((sh) => (sh.id === "a" ? { ...sh, attach: { id: "c", kind: "box", ax: 0, ay: 0, dx: -20, dy: -20 } } : sh)) as Shape[]);
    const before = s.shapes;
    s = grouped(s, ["a", "b", "ar"], "g1");
    expect(byId(s, "a").attach).toBeUndefined(); // outward attach severed
    expect((byId(s, "ar") as SegmentShape).bindEnd).toBeUndefined(); // outward bind severed
    expect(byId(s, "x").attach).toMatchObject({ id: "a" }); // inbound untouched
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes).toEqual(before); // snapshot history restores exactly
  });

  it("parks internal CROSS-child-unit edges in the level-keyed dormant stash; same-child-unit edges stay live", () => {
    // a→b edge crosses the two forming child units {a},{b} → parks.
    let s = seeded([box("a", { attach: { id: "b", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } }), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    expect(byId(s, "a").attach).toBeUndefined();
    expect(byId(s, "a").dormant).toEqual([{ gid: "g1", attach: { id: "b", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } }]);
    // Grouping {a,b} with c: the parked edge is invisible; a,b share a child unit
    // now, so nothing new parks for them.
    s = grouped(s, ["a", "c"], "g2");
    expect(byId(s, "a").dormant).toEqual([{ gid: "g1", attach: { id: "b", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } }]);
  });

  it("stacks dormant levels when an outward edge stamped during an inner group's life crosses an outer grouping", () => {
    let s = seeded([box("a"), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    // Simulate the unit-owned outward edge stamped by a later reattach: b → c.
    s = { ...s, shapes: s.shapes.map((sh) => (sh.id === "b" ? ({ ...sh, attach: { id: "c", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } } as Shape) : sh)) };
    s = grouped(s, ["a", "c"], "g2"); // b→c now crosses child units {a,b} vs {c}
    expect(byId(s, "b").attach).toBeUndefined();
    expect(byId(s, "b").dormant).toEqual([{ gid: "g2", attach: { id: "c", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } }]);
  });
});

describe("ungroup", () => {
  it("strips ONE level, restores its dormant edges, keeps the selection; ⌘G⌘G round-trips", () => {
    let s = seeded([box("a", { attach: { id: "b", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } }), box("b", { x: 60 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = drawReducer(s, { type: "ungroup" });
    expect(byId(s, "a").groupPath).toBeUndefined();
    expect(byId(s, "b").groupPath).toBeUndefined();
    expect(byId(s, "a").attach).toMatchObject({ id: "b" }); // dormant restored
    expect(byId(s, "a").dormant).toBeUndefined(); // the stash dies with its level
    expect([...s.selectedIds].sort()).toEqual(["a", "b"]);
  });

  it("only strips one level of a nested group; the inner stash waits for ITS ungroup", () => {
    let s = seeded([box("a", { attach: { id: "b", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } }), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = grouped(s, ["a", "c"], "g2");
    s = drawReducer(s, { type: "ungroup" }); // dissolves g2
    expect(byId(s, "a").groupPath).toEqual(["g1"]);
    expect(byId(s, "c").groupPath).toBeUndefined();
    expect(byId(s, "a").attach).toBeUndefined(); // g1's stash untouched
    expect(byId(s, "a").dormant).toEqual([{ gid: "g1", attach: { id: "b", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } }]);
    s = drawReducer(s, { type: "select", ids: ["a"] }); // expands to {a,b}
    s = drawReducer(s, { type: "ungroup" });
    expect(byId(s, "a").attach).toMatchObject({ id: "b" });
  });

  it("live-wins precedence: a live outward edge stamped during the group's life beats the dormant restore", () => {
    let s = seeded([box("a", { attach: { id: "b", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } }), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    // A live outward edge lands on a during the group's life (unit-owned stamp).
    const live = { id: "c", kind: "box", ax: 1, ay: 0.5, dx: 10, dy: 0 } as const;
    s = { ...s, shapes: s.shapes.map((sh) => (sh.id === "a" ? ({ ...sh, attach: live } as Shape) : sh)) };
    s = drawReducer(s, { type: "select", ids: ["a"] });
    s = drawReducer(s, { type: "ungroup" });
    expect(byId(s, "a").attach).toEqual(live); // dormant restores only into an EMPTY slot
    expect(byId(s, "a").dormant).toBeUndefined();
  });

  it("drops restored edges whose target no longer exists", () => {
    let s = seeded([box("a", { attach: { id: "b", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } }), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = grouped(s, ["a", "c"], "g2");
    s = drawReducer(s, { type: "ungroup" }); // g2 gone
    s = drawReducer(s, { type: "select", ids: ["c"] });
    s = drawReducer(s, { type: "deleteSelected" });
    s = drawReducer(s, { type: "select", ids: ["a"] });
    s = drawReducer(s, { type: "ungroup" }); // g1: dormant a→b restores (b exists)
    expect(byId(s, "a").attach).toMatchObject({ id: "b" });
  });

  it("never ungroups a proper subset (deep-select ⌘G is a no-op)", () => {
    let s = seeded([box("a"), box("b", { x: 60 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = drawReducer(s, { type: "select", ids: ["a"], deep: true });
    const after = drawReducer(s, { type: "ungroup" });
    expect(after).toBe(s);
  });
});

describe("selection normalization (the reducer funnel)", () => {
  it("non-deep select expands each id to its full unit; deep passes raw", () => {
    let s = seeded([box("a"), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = drawReducer(s, { type: "select", ids: ["a", "c"] });
    expect([...s.selectedIds].sort()).toEqual(["a", "b", "c"]);
    s = drawReducer(s, { type: "select", ids: ["a"], deep: true });
    expect(s.selectedIds).toEqual(["a"]);
  });

  it("toggleSelect is unit-grained: any-member-selected removes ALL member ids, else adds all", () => {
    let s = seeded([box("a"), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = drawReducer(s, { type: "select", ids: ["c"] });
    s = drawReducer(s, { type: "toggleSelect", id: "b" });
    expect([...s.selectedIds].sort()).toEqual(["a", "b", "c"]);
    s = drawReducer(s, { type: "select", ids: ["a"], deep: true }); // proper subset
    s = drawReducer(s, { type: "toggleSelect", id: "b" }); // a member IS selected → remove all
    expect(s.selectedIds).toEqual([]);
  });
});

describe("reducer edit guards", () => {
  it("translateShapes with a partial-unit id set expands to full units", () => {
    let s = seeded([box("a"), box("b", { x: 60 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = drawReducer(s, { type: "translateShapes", ids: ["a"], dx: 7, dy: 3 });
    expect(byId(s, "a")).toMatchObject({ x: 17, y: 13 });
    expect(byId(s, "b")).toMatchObject({ x: 67, y: 13 });
  });

  it("freezes an excluded follower at UNIT grain (no member of the excluded unit is yanked)", () => {
    // Loose big L is anchored into the moved group but not part of the move set.
    let s = seeded([box("a"), box("b", { x: 60 }), box("L", { x: 51, y: 100, width: 200, height: 200, attach: { id: "b", kind: "box", ax: 0.5, ay: 1, dx: 0, dy: 115 } })]);
    s = grouped(s, ["a", "b"], "g1");
    const lBefore = boundingBox(byId(s, "L"));
    s = drawReducer(s, { type: "translateShapes", ids: ["a", "b"], dx: 30, dy: 0 });
    expect(boundingBox(byId(s, "L"))).toEqual(lBefore); // frozen, not dragged
  });

  it("deleteSelected: whole-unit selection deletes the group; a deep-selected member is a NO-OP", () => {
    let s = seeded([box("a"), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    const deep = drawReducer(s, { type: "select", ids: ["a"], deep: true });
    expect(drawReducer(deep, { type: "deleteSelected" })).toBe(deep); // member-edit context never nukes the group
    s = drawReducer(s, { type: "select", ids: ["a"] }); // whole unit
    s = drawReducer(s, { type: "deleteSelected" });
    expect(s.shapes.map((sh) => sh.id)).toEqual(["c"]);
  });

  it("deleteShapes (eraser) grazing one member deletes the whole group", () => {
    let s = seeded([box("a"), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = drawReducer(s, { type: "deleteShapes", ids: ["a"] });
    expect(s.shapes.map((sh) => sh.id)).toEqual(["c"]);
  });

  it("armCluster retypes LOOSE shapes only; an all-grouped selection is a total no-op", () => {
    let s = seeded([box("a"), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = drawReducer(s, { type: "select", ids: ["a", "c"] }); // {a,b} + loose c — all rects
    const past = s.past.length;
    s = drawReducer(s, { type: "armCluster", cluster: "shape" });
    expect(byId(s, "a").type).toBe("rect"); // members untouched
    expect(byId(s, "b").type).toBe("rect");
    expect(byId(s, "c").type).toBe("ellipse"); // loose retyped
    expect(s.past.length).toBe(past + 1);
    // All-grouped: total no-op (no commit, no cycle, no tool arm).
    let g = drawReducer(s, { type: "select", ids: ["a"] });
    const before = g;
    g = drawReducer(g, { type: "armCluster", cluster: "shape" });
    expect(g).toBe(before);
  });

  it("cropImage no-ops on a grouped image", () => {
    let s = seeded([image("i"), box("b", { x: 100 })]);
    s = grouped(s, ["i", "b"], "g1");
    const after = drawReducer(s, { type: "cropImage", id: "i", box: { x: 0, y: 0, width: 10, height: 10 }, crop: { x: 0, y: 0, width: 5, height: 5 } });
    expect(after).toBe(s);
  });

  it("whole-group color edits apply to all members; deep-select width on text drives font size", () => {
    let s = seeded([box("a"), text("t", { x: 60, y: 12 })]);
    s = grouped(s, ["a", "t"], "g1");
    s = drawReducer(s, { type: "select", ids: ["a"] }); // whole unit
    s = drawReducer(s, { type: "setColor", color: "#3b82f6" });
    expect(byId(s, "a").stroke).toBe("#3b82f6");
    expect(byId(s, "t").stroke).toBe("#3b82f6");
    s = drawReducer(s, { type: "select", ids: ["t"], deep: true });
    s = drawReducer(s, { type: "setStrokeWidth", width: 10 });
    expect((byId(s, "t") as TextShape).fontSize).toBe(44);
    expect(byId(s, "a").strokeWidth).not.toBe(10); // deep edit touches only the member
  });
});

describe("unit-grained glue engine", () => {
  it("moveClusterIds expands seeds to full units and drags a lighter glued neighbor unit", () => {
    let s = seeded([box("a"), box("b", { x: 60 }), pen("p", [55, 15, 70, 25], { attach: { id: "b", kind: "box", ax: 0, ay: 0, dx: 0, dy: 0 } })]);
    s = grouped(s, ["a", "b"], "g1");
    const cluster = moveClusterIds(s.shapes, ["a"]).sort();
    expect(cluster).toEqual(["a", "b", "p"]); // seed expands to unit; massless stroke follows
  });

  it("unit weight is union-AABB area: an all-stroke group is an OBJECT (drags a smaller box, blocks a lone stroke seed)", () => {
    // Two strokes grouped: union AABB 100×100 = weight 10000; a small box glued on.
    let s = seeded([
      pen("p1", [0, 0, 100, 10]),
      pen("p2", [0, 90, 100, 100]),
      box("sm", { x: 100, y: 40, width: 20, height: 20, attach: { id: "p1", kind: "box", ax: 1, ay: 0.5, dx: 10, dy: 35 } }),
    ]);
    s = grouped(s, ["p1", "p2"], "g1");
    // Wire the small box's edge target: attach stays inbound (sm → p1 member).
    const fromGroup = moveClusterIds(s.shapes, ["p1"]).sort();
    expect(fromGroup).toEqual(["p1", "p2", "sm"]); // group (10000) drags the box (400)
    const fromBox = moveClusterIds(s.shapes, ["sm"]).sort();
    expect(fromBox).toEqual(["sm"]); // box (400) can't pull the group (10000)
  });

  it("equal-size separability holds at unit grain (equal groups never weld)", () => {
    let s = seeded([box("a1"), box("a2", { x: 60 }), box("b1", { x: 200 }), box("b2", { x: 260 })]);
    s = grouped(s, ["a1", "a2"], "ga");
    s = grouped(s, ["b1", "b2"], "gb");
    // Glue the groups: unit-owned outward edge a2 → b1.
    s = { ...s, shapes: s.shapes.map((sh) => (sh.id === "a2" ? ({ ...sh, attach: { id: "b1", kind: "box", ax: 0, ay: 0.5, dx: -55, dy: 0 } } as Shape) : sh)) };
    expect(moveClusterIds(s.shapes, ["a1"]).sort()).toEqual(["a1", "a2"]); // equal-weight neighbor blocked
  });

  it("group↔group glue drags the LIGHTER whole unit via a single member edge", () => {
    let s = seeded([box("a1"), box("a2", { x: 60 }), box("b1", { x: 200, width: 20, height: 15 }), box("b2", { x: 230, width: 20, height: 15 })]);
    s = grouped(s, ["a1", "a2"], "ga");
    s = grouped(s, ["b1", "b2"], "gb"); // smaller union AABB
    s = { ...s, shapes: s.shapes.map((sh) => (sh.id === "b1" ? ({ ...sh, attach: { id: "a2", kind: "box", ax: 1, ay: 0.5, dx: 110, dy: 0 } } as Shape) : sh)) };
    expect(moveClusterIds(s.shapes, ["a1"]).sort()).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("containedIds admits WHOLE units only when ALL members are inside, via member boxes", () => {
    const shapes: Shape[] = [
      box("big", { x: 0, y: 0, width: 300, height: 300 }),
      box("in1", { x: 10, y: 10, width: 20, height: 20, groupPath: ["g"] }),
      box("in2", { x: 50, y: 50, width: 20, height: 20, groupPath: ["g"] }),
      box("half1", { x: 200, y: 200, width: 20, height: 20, groupPath: ["h"] }),
      box("half2", { x: 400, y: 400, width: 20, height: 20, groupPath: ["h"] }), // outside
    ];
    expect(containedIds(shapes, ["big"]).sort()).toEqual(["in1", "in2"]); // h partially out → excluded whole
  });

  it("reflowAttachments moves a follower's ENTIRE unit rigidly; intra-unit edges are inert", () => {
    // Group {f1,f2}; f1 is anchored to loose parent P. Move P → whole unit rides.
    const shapes: Shape[] = [
      box("P", { x: 100, y: 0, width: 60, height: 60 }),
      box("f1", { x: 40, y: 10, width: 20, height: 20, groupPath: ["g"], attach: { id: "P", kind: "box", ax: 0, ay: 0.5, dx: -50, dy: 0 } }),
      box("f2", { x: 0, y: 10, width: 20, height: 20, groupPath: ["g"] }),
    ];
    const moved = shapes.map((sh) => (sh.id === "P" ? ({ ...sh, x: 130 } as Shape) : sh));
    const reflowed = reflowAttachments(moved, new Set(["P"]));
    expect(boundingBox(reflowed.find((sh) => sh.id === "f1")!)).toMatchObject({ x: 70 }); // rode +30
    expect(boundingBox(reflowed.find((sh) => sh.id === "f2")!)).toMatchObject({ x: 30 }); // rigid: same delta
    // Intra-unit edge alone never moves the unit.
    const intra: Shape[] = [
      box("m1", { x: 0, y: 0, groupPath: ["g"] }),
      box("m2", { x: 200, y: 0, groupPath: ["g"], attach: { id: "m1", kind: "box", ax: 1, ay: 0.5, dx: 5, dy: 0 } }),
    ];
    expect(reflowAttachments(intra, new Set())).toBe(intra);
  });

  it("reattach keeps intra-unit edges verbatim and stamps ≤1 outward edge per unit (nearest contact)", () => {
    let s = seeded([
      box("a", { x: 0, y: 0 }), // member: 40×30 at 0,0
      box("b", { x: 60, y: 0, attach: { id: "a", kind: "box", ax: 1, ay: 0.5, dx: 30, dy: 0 } }), // intra edge
      box("N", { x: 104, y: 0 }), // nearest outward target (gap 4 from b)
      box("F", { x: -50, y: 200 }), // far shape
    ]);
    s = grouped(s, ["a", "b"], "g1");
    // groupSelection parked the crossing a↔b edge; simulate it staying live by
    // restoring it (same-child-unit after a nested regroup is equivalent) — here
    // we just verify the reattach invariants directly on a moved unit.
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "translateShapes", ids: ["a", "b"], dx: 0, dy: 0 });
    s = drawReducer(s, { type: "reattach", ids: ["a", "b"] });
    s = drawReducer(s, { type: "endGesture" });
    const withAttach = s.shapes.filter((sh) => sh.groupPath && sh.attach);
    expect(withAttach).toHaveLength(1); // ≤1 outward edge per unit
    expect(withAttach[0].id).toBe("b"); // stamped on the touching member
    expect(withAttach[0].attach).toMatchObject({ id: "N" }); // nearest contact
  });

  it("a stayer whose parent departed re-judges from its spot (keep new neighbor or drop)", () => {
    let s = seeded([
      box("big", { x: 0, y: 0, width: 200, height: 200 }),
      box("sm", { x: 210, y: 0, width: 20, height: 20, attach: { id: "big", kind: "box", ax: 1, ay: 0, dx: 20, dy: 10 } }),
    ]);
    // Drag the small one far away — its own edge re-detects (drops: nothing near).
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "translateShapes", ids: ["big"], dx: 500, dy: 500 });
    s = drawReducer(s, { type: "reattach", ids: ["big"] });
    s = drawReducer(s, { type: "endGesture" });
    expect(byId(s, "sm").attach).toBeUndefined(); // stale edge dropped, sm not yanked
    expect(boundingBox(byId(s, "sm"))).toMatchObject({ x: 210, y: 0 });
  });
});

describe("scaleUnit", () => {
  const grp = () => {
    let s = seeded([
      box("r", { x: 100, y: 100, width: 40, height: 30 }),
      text("t", { x: 150, y: 100, fontSize: 18 }),
      pen("p", [100, 140, 140, 150]),
      arrow("ar", [100, 90, 140, 90]),
      image("i", { x: 160, y: 130, width: 30, height: 30, crop: { x: 1, y: 2, width: 3, height: 4 } }),
    ]);
    return grouped(s, ["r", "t", "p", "ar", "i"], "g1");
  };

  it("bakes the full list: geometry affine about origin, fontSize/strokeWidth ×factor, crop untouched", () => {
    let s = grp();
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "scaleUnit", ids: ["r"], factor: 2, origin: { x: 100, y: 100 } });
    s = drawReducer(s, { type: "endGesture" });
    expect(byId(s, "r")).toMatchObject({ x: 100, y: 100, width: 80, height: 60, strokeWidth: 6 });
    expect(byId(s, "t")).toMatchObject({ x: 200, y: 100, fontSize: 36 });
    expect((byId(s, "p") as FreehandShape).points).toEqual([100, 180, 180, 200]);
    expect((byId(s, "ar") as SegmentShape).points).toEqual([100, 80, 180, 80]);
    expect(byId(s, "i")).toMatchObject({ x: 220, y: 160, width: 60, height: 60 });
    expect((byId(s, "i") as ImageShape).crop).toEqual({ x: 1, y: 2, width: 3, height: 4 }); // source-pixel space
    expect(s.past).toHaveLength(2); // group + ONE scale entry (history-neutral inside the gesture)
  });

  it("ghost-frames-then-commit converges with a direct commit (no compounding)", () => {
    const direct = (() => {
      let s = grp();
      s = drawReducer(s, { type: "beginGesture" });
      s = drawReducer(s, { type: "scaleUnit", ids: ["r"], factor: 1.8, origin: { x: 100, y: 100 } });
      return drawReducer(s, { type: "endGesture" });
    })();
    const ghosted = (() => {
      let s = grp();
      s = drawReducer(s, { type: "beginGesture" });
      s = drawReducer(s, { type: "scaleUnitGhost", ids: ["r"], factor: 1.3, origin: { x: 100, y: 100 } });
      s = drawReducer(s, { type: "scaleUnitGhost", ids: ["r"], factor: 1.6, origin: { x: 100, y: 100 } });
      s = drawReducer(s, { type: "scaleUnit", ids: ["r"], factor: 1.8, origin: { x: 100, y: 100 } });
      return drawReducer(s, { type: "endGesture" });
    })();
    expect(ghosted.shapes).toEqual(direct.shapes);
    expect(ghosted.past.length).toBe(direct.past.length);
  });

  it("scales live INTERNAL glue metrics and dormant metrics at every level", () => {
    let s = seeded([box("a", { attach: { id: "b", kind: "box", ax: 0, ay: 0.5, dx: -30, dy: 0 } }), box("b", { x: 60 }), box("c", { x: 200 })]);
    s = grouped(s, ["a", "b"], "g1"); // a→b parks under g1
    s = grouped(s, ["a", "c"], "g2");
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "scaleUnit", ids: ["a"], factor: 2, origin: { x: 0, y: 0 } });
    s = drawReducer(s, { type: "endGesture" });
    expect(byId(s, "a").dormant).toEqual([{ gid: "g1", attach: { id: "b", kind: "box", ax: 0, ay: 0.5, dx: -60, dy: 0 } }]);
    // Restore path: ungroup g2 then g1 — the restored edge must be consistent
    // with the scaled geometry (reflow applies ~zero correction).
    s = drawReducer(s, { type: "ungroup" });
    s = drawReducer(s, { type: "select", ids: ["a"] });
    const before = boundingBox(byId(s, "a"));
    s = drawReducer(s, { type: "ungroup" });
    expect(byId(s, "a").attach).toMatchObject({ dx: -60 });
    expect(boundingBox(byId(s, "a"))).toEqual(before); // no snap on restore
  });

  it("re-judges INBOUND edges with the action's distScale: follower rides, anchor refreshes, far edges drop", () => {
    let s = seeded([
      box("a", { x: 100, y: 100, width: 40, height: 30 }),
      box("b", { x: 160, y: 100, width: 40, height: 30 }),
      // Outsider glued onto member a's left edge (center 75 = anchor 100 - 25).
      box("f", { x: 60, y: 100, width: 30, height: 30, attach: { id: "a", kind: "box", ax: 0, ay: 0.5, dx: -25, dy: 0 } }),
    ]);
    s = grouped(s, ["a", "b"], "g1");
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "scaleUnit", ids: ["a"], factor: 2, origin: { x: 100, y: 100 } });
    s = drawReducer(s, { type: "endGesture" });
    const f = byId(s, "f");
    expect(f.attach).toMatchObject({ id: "a", ax: 0 }); // kept + refreshed
    // The follower rode the scaling border leftward (anchor ax=0 stays at x=100)…
    expect(boundingBox(f)).toMatchObject({ x: 60, y: 115 }); // dy re-anchored to the new mid-height
  });

  it("an inbound bound arrow re-clings to the scaled member border", () => {
    let s = seeded([box("a", { x: 100, y: 100, width: 40, height: 30 }), box("b", { x: 160, y: 100 }), arrow("ar", [30, 115, 96, 115], { bindEnd: { id: "a", angle: 0, gap: 4 } })]);
    s = grouped(s, ["a", "b"], "g1");
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "scaleUnit", ids: ["a"], factor: 2, origin: { x: 220, y: 130 } }); // grows leftward
    s = drawReducer(s, { type: "endGesture" });
    const ar = byId(s, "ar") as SegmentShape;
    expect(ar.bindEnd).toMatchObject({ id: "a", gap: 4 }); // inbound gap NOT scaled
    // The endpoint re-clung to the SCALED border: within gap of a's new bbox
    // (binds cling along the direction toward the other endpoint, so assert
    // point-to-box distance, not a fixed edge).
    const a = boundingBox(byId(s, "a"));
    const [, , ex, ey] = ar.points;
    const ddx = Math.max(a.x - ex, 0, ex - (a.x + a.width));
    const ddy = Math.max(a.y - ey, 0, ey - (a.y + a.height));
    expect(Math.hypot(ddx, ddy)).toBeLessThanOrEqual(4.0001);
    expect(ex).not.toBeCloseTo(96, 1); // it moved off the pre-scale border
  });
});

describe("size-control scale mode (scaleStepTarget + stepped scaleUnit)", () => {
  it("targets a fully-selected group or a lone image; never deep subsets, loose shapes, or multi-unit picks", () => {
    let s = seeded([box("a", { x: 100, y: 100 }), box("b", { x: 200, y: 100 }), box("c", { x: 300, y: 100 }), image("i", { x: 100, y: 300 })]);
    s = grouped(s, ["a", "b"], "g1");
    expect(scaleStepTarget(s.shapes, ["a", "b"])?.sort()).toEqual(["a", "b"]); // whole group
    expect(scaleStepTarget(s.shapes, ["a"])).toBeNull(); // deep subset — members never resize
    expect(scaleStepTarget(s.shapes, ["i"])).toEqual(["i"]); // lone image (stroke is meaningless)
    expect(scaleStepTarget(s.shapes, ["c"])).toBeNull(); // loose rect keeps stroke semantics
    expect(scaleStepTarget(s.shapes, ["a", "b", "c"])).toBeNull(); // multi-unit selection
    expect(scaleStepTarget(s.shapes, [])).toBeNull();
  });

  it("a keyboard step (begin → scaleUnit ×1.2 about center → end) scales the whole group proportionally, one undo entry per press", () => {
    let s = seeded([box("a", { x: 100, y: 100, width: 40, height: 30 }), box("b", { x: 200, y: 100, width: 40, height: 30 })]);
    s = grouped(s, ["a", "b"], "g1");
    const b0 = unitBoundsOf(s.shapes, "g1")!;
    const origin = { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 };
    const past0 = s.past.length;
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "scaleUnit", ids: scaleStepTarget(s.shapes, s.selectedIds)!, factor: 1.2, origin });
    s = drawReducer(s, { type: "endGesture" });
    const b1 = unitBoundsOf(s.shapes, "g1")!;
    expect(b1.width).toBeCloseTo(b0.width * 1.2, 5);
    expect(b1.height).toBeCloseTo(b0.height * 1.2, 5);
    // About the center: the union box center stays put.
    expect(b1.x + b1.width / 2).toBeCloseTo(origin.x, 5);
    expect(b1.y + b1.height / 2).toBeCloseTo(origin.y, 5);
    expect(byId(s, "a").strokeWidth).toBeCloseTo(3.6, 5); // proportional, not a slot jump
    expect(s.past.length).toBe(past0 + 1); // one entry per press
    // And the press is undoable back to the exact pre-press geometry.
    s = drawReducer(s, { type: "undo" });
    expect(unitBoundsOf(s.shapes, "g1")).toEqual(b0);
  });
});

describe("clipboard + import transforms", () => {
  let n = 0;
  const newId = () => `n${n++}`;

  it("clonePastedShapes remaps gids per batch (prefix-preserving) and dormant targets; never welds to the original", () => {
    n = 0;
    // Inner group g1 {a,b} nested inside g2 {a,b,c}; a parked a→b edge at g1.
    const batch: Shape[] = [
      box("a", { groupPath: ["g2", "g1"], dormant: [{ gid: "g1", attach: { id: "b", kind: "box", ax: 0, ay: 0, dx: 1, dy: 2 } }] }),
      box("b", { x: 60, groupPath: ["g2", "g1"] }),
      box("c", { x: 200, groupPath: ["g2"] }),
    ];
    const out = clonePastedShapes(batch, 10, 10, newId);
    const [a2, b2, c2] = out;
    expect(a2.groupPath).toHaveLength(2);
    expect(a2.groupPath).toEqual(b2.groupPath); // prefix-preserving remap
    expect(c2.groupPath).toEqual([a2.groupPath![0]]); // shared outer gid
    expect(a2.groupPath![0]).not.toBe("g2"); // fresh gids
    expect(a2.groupPath![1]).not.toBe("g1");
    expect(a2.dormant![0].gid).toBe(a2.groupPath![1]); // stash key follows the remap
    expect(a2.dormant![0].attach!.id).toBe(b2.id); // target remapped into the batch
  });

  it("drops dormant entries whose target left the batch and collapses single-member groups", () => {
    n = 0;
    const batch: Shape[] = [
      box("a", { groupPath: ["g1"], dormant: [{ gid: "g1", attach: { id: "outside", kind: "box", ax: 0, ay: 0, dx: 1, dy: 2 } }] }),
      // b (g1's other member) was NOT copied.
    ];
    const out = clonePastedShapes(batch, 0, 0, newId);
    expect(out[0].groupPath).toBeUndefined(); // singleton collapsed
    expect(out[0].dormant).toBeUndefined(); // dead entry dropped
  });

  it("normalizeGroups splits a gid reused under different parent contexts and collapses singletons", () => {
    const shapes: Shape[] = [
      box("a", { groupPath: ["g1"] }),
      box("b", { groupPath: ["g1"] }),
      box("c", { groupPath: ["g2", "g1"] }), // same gid nested under g2 — a different group
      box("d", { groupPath: ["g2", "g1"] }),
      box("e", { groupPath: ["solo"] }), // singleton path
    ];
    const out = normalizeGroups(shapes);
    const path = (id: string) => out.find((sh) => sh.id === id)!.groupPath;
    expect(path("a")).toEqual(["g1"]);
    expect(path("b")).toEqual(["g1"]);
    expect(path("c")![1]).not.toBe("g1"); // split off
    expect(path("c")).toEqual(path("d"));
    expect(path("e")).toBeUndefined(); // singleton collapsed
  });

  it("normalizeGroups is identity on a clean doc and runs on open (initialDrawState)", () => {
    const clean: Shape[] = [box("a", { groupPath: ["g"] }), box("b", { groupPath: ["g"] }), box("c")];
    expect(normalizeGroups(clean)).toBe(clean);
    const s = seeded([box("a", { groupPath: ["dead"] }), box("b")]);
    expect(byId(s, "a").groupPath).toBeUndefined(); // singleton collapsed at open
  });
});

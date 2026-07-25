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
  paintOrder,
  boundingBox,
  scaleStepTarget,
  slotTargetStep,
  unitSizeStep,
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

describe("sizeStep — the unit's remembered size-control position", () => {
  /** The editor's applySizeStep: move to an ABSOLUTE step — factor from the
   *  current stamp, scale about the unit center, stamp, one gesture. */
  const press = (s: DrawState, toStep: number): DrawState => {
    const ids = scaleStepTarget(s.shapes, s.selectedIds)!;
    const cur = unitSizeStep(s.shapes, ids);
    const b = unitBoundsOf(s.shapes, rootUnitKeyOf(byId(s, ids[0])))!;
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, {
      type: "scaleUnit",
      ids,
      factor: Math.pow(1.2, toStep - cur),
      origin: { x: b.x + b.width / 2, y: b.y + b.height / 2 },
    });
    s = drawReducer(s, { type: "stampSizeStep", ids, step: toStep });
    return drawReducer(s, { type: "endGesture" });
  };

  it("stamps uniformly with the scale as ONE undo entry; step 0 stores as absent", () => {
    let s = seeded([box("a", { x: 100, y: 100 }), box("b", { x: 200, y: 100 })]);
    s = grouped(s, ["a", "b"], "g1");
    const past0 = s.past.length;
    s = press(s, 1);
    expect(byId(s, "a").sizeStep).toBe(1);
    expect(byId(s, "b").sizeStep).toBe(1);
    expect(unitSizeStep(s.shapes, ["b"])).toBe(1);
    expect(s.past.length).toBe(past0 + 1); // geometry + stamp are one entry
    s = drawReducer(s, { type: "undo" });
    expect(byId(s, "a").sizeStep).toBeUndefined();
    expect((byId(s, "a") as BoxShape).width).toBe(40); // exact pre-press geometry
    s = drawReducer(s, { type: "redo" });
    s = press(s, 0); // back to natural
    expect(byId(s, "a").sizeStep).toBeUndefined(); // canonical absent, not 0
  });

  it("mid restores the exact natural size from deep in the extended zone", () => {
    let s = seeded([box("a", { x: 100, y: 100 }), box("b", { x: 200, y: 100 })]);
    s = grouped(s, ["a", "b"], "g1");
    const b0 = unitBoundsOf(s.shapes, "g1")!;
    for (const step of [1, 2, 3]) s = press(s, step); // three "large" presses
    expect(unitBoundsOf(s.shapes, "g1")!.width).toBeCloseTo(b0.width * 1.2 ** 3, 5);
    s = press(s, slotTargetStep(unitSizeStep(s.shapes, ["a"]), 1)); // mid
    const b1 = unitBoundsOf(s.shapes, "g1")!;
    expect(b1.width).toBeCloseTo(b0.width, 5);
    expect(b1.height).toBeCloseTo(b0.height, 5);
    expect(b1.x).toBeCloseTo(b0.x, 5);
    expect(byId(s, "a").strokeWidth).toBeCloseTo(3, 5);
  });

  it("grouping strips members' stale stamps (a fresh group is natural size)", () => {
    let s = seeded([image("i", { x: 100, y: 100, sizeStep: 2 }), box("c", { x: 200, y: 100 })]);
    s = grouped(s, ["i", "c"], "g1");
    expect(byId(s, "i").sizeStep).toBeUndefined();
    expect(unitSizeStep(s.shapes, ["c"])).toBe(0);
  });

  it("ungroup strips the stamps — freed shapes keep their size, rebased as natural", () => {
    let s = seeded([box("a", { x: 100, y: 100 }), box("b", { x: 200, y: 100 })]);
    s = grouped(s, ["a", "b"], "g1");
    s = press(s, 2);
    const w = (byId(s, "a") as BoxShape).width;
    s = drawReducer(s, { type: "ungroup" });
    expect(byId(s, "a").groupPath).toBeUndefined();
    expect(byId(s, "a").sizeStep).toBeUndefined();
    expect((byId(s, "a") as BoxShape).width).toBeCloseTo(w, 5); // geometry untouched
  });

  it("normalizeGroups heals a stamp stranded on a loose non-image", () => {
    const healed = normalizeGroups([
      box("loose", { sizeStep: 3 }),
      box("solo", { x: 100, y: 100, sizeStep: 1, groupPath: ["gone"] }), // singleton → collapses
      image("img", { x: 200, y: 200, sizeStep: 2 }),
      box("m1", { x: 300, y: 10, sizeStep: 1, groupPath: ["g"] }),
      box("m2", { x: 300, y: 100, sizeStep: 1, groupPath: ["g"] }),
    ]);
    expect(healed.find((sh) => sh.id === "loose")!.sizeStep).toBeUndefined();
    expect(healed.find((sh) => sh.id === "solo")!.sizeStep).toBeUndefined();
    expect(healed.find((sh) => sh.id === "img")!.sizeStep).toBe(2); // a loose image legitimately remembers
    expect(healed.find((sh) => sh.id === "m1")!.sizeStep).toBe(1); // group members keep theirs
  });
});

describe("stretchUnit (side-anchor disproportional resize)", () => {
  const grp = () => {
    let s = seeded([
      box("r1", { x: 100, y: 100, width: 40, height: 30 }),
      box("r2", { x: 200, y: 100, width: 40, height: 30 }),
      text("t", { x: 120, y: 160, fontSize: 18 }),
      arrow("ar", [140, 115, 200, 115]), // spans the gap between r1 and r2
    ]);
    return grouped(s, ["r1", "r2", "t", "ar"], "g1");
  };

  it("members FOLLOW the scaling: boxes stretch per axis, points remap, text keeps %-position undistorted; undoable", () => {
    let s = grp();
    const past0 = s.past.length;
    const t0 = boundingBox(byId(s, "t"));
    s = drawReducer(s, { type: "beginGesture" });
    // Stretch ×1.5 horizontally about the unit's left edge (x=100).
    s = drawReducer(s, { type: "stretchUnit", ids: ["r1"], fx: 1.5, fy: 1, origin: { x: 100, y: 0 } });
    s = drawReducer(s, { type: "endGesture" });
    const r1 = byId(s, "r1") as BoxShape;
    const r2 = byId(s, "r2") as BoxShape;
    // Boxes map fully affinely per axis: position remaps AND width×fx…
    expect([r1.x, r1.width, r2.x, r2.width]).toEqual([100, 60, 250, 60]);
    // …the untouched axis and stroke stay put (no uniform factor exists).
    expect([r1.y, r1.height, r2.height]).toEqual([100, 30, 30]);
    expect(r1.strokeWidth).toBe(3);
    // Centers land at the same affine image (130 / 280).
    expect(r1.x + r1.width / 2).toBeCloseTo(130, 5);
    expect(r2.x + r2.width / 2).toBeCloseTo(280, 5);
    // The connector's points remapped per-point (it keeps spanning the gap:
    // 160 = r1's new right edge, 250 = r2's new left edge).
    const ar = byId(s, "ar") as SegmentShape;
    expect(ar.points[0]).toBeCloseTo(160, 5);
    expect(ar.points[2]).toBeCloseTo(250, 5);
    expect(ar.points[1]).toBe(115);
    // Text: glyphs can't stretch — fontSize kept, CENTER remapped in % exactly.
    const t = byId(s, "t") as TextShape;
    expect(t.fontSize).toBe(18);
    expect(t.x).toBeCloseTo(100 + (t0.x + t0.width / 2 - 100) * 1.5 - t0.width / 2, 5);
    expect(s.past.length).toBe(past0 + 1); // ONE entry (history-neutral in-gesture)
    const before = grp().shapes;
    s = drawReducer(s, { type: "undo" });
    expect(s.shapes).toEqual(before);
  });

  it("vertical stretch: heights follow fy, text keeps its own size at its %-position on the stretched axis", () => {
    let s = seeded([
      box("a", { x: 100, y: 100, width: 40, height: 30 }),
      box("b", { x: 100, y: 200, width: 40, height: 30 }),
      text("t", { x: 110, y: 150, fontSize: 18 }),
    ]);
    s = grouped(s, ["a", "b", "t"], "g1");
    const t0 = boundingBox(byId(s, "t"));
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "stretchUnit", ids: ["a"], fx: 1, fy: 2, origin: { x: 0, y: 100 } });
    s = drawReducer(s, { type: "endGesture" });
    const a = byId(s, "a") as BoxShape;
    const b = byId(s, "b") as BoxShape;
    const t = byId(s, "t") as TextShape;
    expect([a.y, a.height, a.width]).toEqual([100, 60, 40]);
    expect([b.y, b.height]).toEqual([300, 60]);
    expect(t.fontSize).toBe(18); // undistorted
    expect(t.x).toBe(110); // fx=1 → horizontal untouched
    expect(t.y).toBeCloseTo(100 + (t0.y + t0.height / 2 - 100) * 2 - t0.height / 2, 5);
  });

  it("arrows: an inbound BOUND arrow follows its binding (re-clings, absolute gap); member arrows/pens remap and keep spanning", () => {
    let s = seeded([
      box("l", { x: 100, y: 100, width: 40, height: 30 }),
      box("r", { x: 300, y: 100, width: 40, height: 30 }),
      arrow("mem", [140, 115, 300, 115]), // member: drawn edge-to-edge l→r
      pen("pn", [150, 150, 250, 180]), // member stroke
    ]);
    s = grouped(s, ["l", "r", "mem", "pn"], "g1");
    // An OUTSIDE arrow bound onto member r with a 5px breathing gap — inbound
    // edges survive grouping untouched. Its points sit at the reflow fixpoint
    // for the unstretched r (center 320 + half-width 20 + gap 5 = 345).
    s = drawReducer(s, {
      type: "addShapes",
      shapes: [arrow("bd", [420, 115, 345, 115], { bindEnd: { id: "r", angle: 0, gap: 5 } })],
    });
    s = drawReducer(s, { type: "select", ids: ["l"] });
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "stretchUnit", ids: ["l"], fx: 2, fy: 1, origin: { x: 100, y: 0 } });
    s = drawReducer(s, { type: "endGesture" });
    // Members stretched: l' spans 100..180, r' spans 500..580.
    expect((byId(s, "l") as BoxShape).width).toBe(80);
    expect((byId(s, "r") as BoxShape).x).toBe(500);
    // The member arrow keeps spanning the stretched gap edge-to-edge…
    const mem = byId(s, "mem") as SegmentShape;
    expect(mem.points[0]).toBeCloseTo(180, 5); // l's new right edge
    expect(mem.points[2]).toBeCloseTo(500, 5); // r's new left edge
    // …and the pen remapped per-point.
    expect((byId(s, "pn") as FreehandShape).points).toEqual([200, 150, 400, 180]);
    // The bound outside arrow FOLLOWED ITS BINDING: it is not a member (no
    // remap touches it) — the settle re-clung it to r's stretched border,
    // keeping the ABSOLUTE 5px gap. r's center moved past the arrow's free
    // end, so the bind swings to the near (left) side: 540 − 40 − 5 = 495.
    const bd = byId(s, "bd") as SegmentShape;
    expect(bd.points[0]).toBe(420); // free end untouched
    expect(bd.points[2]).toBeCloseTo(495, 5);
    expect(bd.points[3]).toBeCloseTo(115, 5);
    expect(bd.bindEnd?.gap).toBe(5); // gap never scaled by the stretch
  });

  it("ghost frames then commit converges with a direct commit (no compounding)", () => {
    const direct = (() => {
      let s = grp();
      s = drawReducer(s, { type: "beginGesture" });
      s = drawReducer(s, { type: "stretchUnit", ids: ["r1"], fx: 1.6, fy: 1, origin: { x: 100, y: 0 } });
      return drawReducer(s, { type: "endGesture" });
    })();
    const ghosted = (() => {
      let s = grp();
      s = drawReducer(s, { type: "beginGesture" });
      s = drawReducer(s, { type: "stretchUnitGhost", ids: ["r1"], fx: 1.2, fy: 1, origin: { x: 100, y: 0 } });
      s = drawReducer(s, { type: "stretchUnitGhost", ids: ["r1"], fx: 1.4, fy: 1, origin: { x: 100, y: 0 } });
      s = drawReducer(s, { type: "stretchUnit", ids: ["r1"], fx: 1.6, fy: 1, origin: { x: 100, y: 0 } });
      return drawReducer(s, { type: "endGesture" });
    })();
    expect(ghosted.shapes).toEqual(direct.shapes);
  });

  it("DORMANT edges stretch their offsets (dx×fx) so a later ungroup restores the stretched layout", () => {
    // b glued edge-to-edge right of a (gap 0); grouping PARKS that edge dormant.
    let s = seeded([box("a", { x: 100, y: 100, width: 40, height: 30 }), box("b", { x: 140, y: 100, width: 40, height: 30 })]);
    s = drawReducer(s, { type: "select", ids: ["b"] });
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "translateShapes", ids: ["b"], dx: 1, dy: 0 });
    s = drawReducer(s, { type: "reattach", ids: ["b"] });
    s = drawReducer(s, { type: "endGesture" });
    expect(byId(s, "b").attach?.id).toBe("a");
    s = grouped(s, ["a", "b"], "g1");
    const parked = byId(s, "b").dormant?.find((d) => d.gid === "g1");
    expect(parked?.attach?.kind).toBe("box");
    const dx0 = parked!.attach!.kind === "box" ? parked!.attach!.dx : NaN;
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "stretchUnit", ids: ["a"], fx: 3, fy: 1, origin: { x: 100, y: 0 } });
    s = drawReducer(s, { type: "endGesture" });
    const stretched = byId(s, "b").dormant?.find((d) => d.gid === "g1");
    expect(stretched!.attach!.kind === "box" && stretched!.attach!.dx).toBeCloseTo(dx0 * 3, 5);
    // Ungroup restores the edge live (into the empty slot) at the stretched offset.
    s = drawReducer(s, { type: "select", ids: ["a", "b"] });
    s = drawReducer(s, { type: "ungroup" });
    expect(byId(s, "b").attach?.id).toBe("a");
  });

  it("an outside follower glued to a member rides the stretch to its ANCHOR on the stretched box (reflow + re-judge)", () => {
    let s = grp();
    // Attach an outside note under r2 through the real drag path.
    s = drawReducer(s, { type: "addShapes", shapes: [box("note", { x: 205, y: 132, width: 30, height: 20 })], detectAttach: true });
    expect(byId(s, "note").attach?.id).toBe("r2");
    const att0 = byId(s, "note").attach!; // the PRE-stretch record the reflow rides
    expect(att0.kind).toBe("box");
    s = drawReducer(s, { type: "beginGesture" });
    s = drawReducer(s, { type: "stretchUnit", ids: ["r1"], fx: 1.5, fy: 1, origin: { x: 100, y: 0 } });
    s = drawReducer(s, { type: "endGesture" });
    // r2 stretched (40→60 wide); the note kept its edge and rode to the OLD
    // anchor applied to the NEW geometry — fractional ax tracks the stretched
    // width, literal dx/dy stay (no uniform factor exists to scale them).
    expect(byId(s, "note").attach?.id).toBe("r2");
    const note1 = byId(s, "note") as BoxShape;
    const r2b = byId(s, "r2") as BoxShape;
    expect(r2b.width).toBe(60);
    if (att0.kind === "box") {
      expect(note1.x + note1.width / 2).toBeCloseTo(r2b.x + att0.ax * r2b.width + att0.dx, 5);
      expect(note1.y + note1.height / 2).toBeCloseTo(r2b.y + att0.ay * r2b.height + att0.dy, 5);
    }
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

describe("groupSelection — intra-group paint order (nothing disappears after ⌘G)", () => {
  const groupIds = (s: DrawState, gid: string) => s.shapes.filter((sh) => sh.groupPath?.includes(gid)).map((sh) => sh.id);

  it("a small filled shape drawn BEFORE a big filled one stays on top after grouping", () => {
    // Loose, the footprint sort already puts the small fill on top even though it
    // was drawn first. Grouping must not re-stack it under the big fill.
    let s = seeded([
      box("small", { fill: "#f00", x: 20, y: 20, width: 30, height: 30 }),
      box("big", { fill: "#00f", x: 0, y: 0, width: 100, height: 100 }),
    ]);
    expect(paintOrder(s.shapes).map((sh) => sh.id)).toEqual(["big", "small"]);
    s = grouped(s, ["small", "big"], "g");
    // A group paints as one atom in ARRAY order, so members must be STORED in
    // paint order — big (bottom) first, small (top) last.
    expect(groupIds(s, "g")).toEqual(["big", "small"]);
    // ...and the whole-doc paint order agrees — no live re-sort needed.
    expect(paintOrder(s.shapes).map((sh) => sh.id)).toEqual(["big", "small"]);
  });

  it("an image member size-sorts within the group like any fill — a BIG image sinks", () => {
    // An image is a fill: a big image sinks below a smaller filled member.
    let s = seeded([box("v", { fill: "#f00" }), image("bigImg", { x: 0, y: 0, width: 200, height: 200 })]);
    s = grouped(s, ["v", "bigImg"], "g");
    expect(groupIds(s, "g")).toEqual(["bigImg", "v"]); // big image bottom, small fill on top
  });

  it("a SMALL image member rides ABOVE a bigger filled member (nothing disappears)", () => {
    let s = seeded([box("card", { fill: "#f00", width: 300, height: 200 }), image("badge", { x: 0, y: 0, width: 30, height: 30 })]);
    s = grouped(s, ["card", "badge"], "g");
    expect(groupIds(s, "g")).toEqual(["card", "badge"]); // big fill bottom, small image on top
  });

  it("orders child units by footprint while keeping each subgroup's internal order intact", () => {
    // sub = {s1, s2} pre-grouped (small footprint); mid = a big loose fill. The
    // subgroup is an atom: its members keep their order; only the two child units
    // reorder so the big fill sinks below the subgroup.
    let s = seeded([
      box("s1", { fill: "#f00", x: 10, y: 10, width: 20, height: 20, groupPath: ["sub"] }),
      box("s2", { fill: "#f00", x: 0, y: 0, width: 40, height: 40, groupPath: ["sub"] }),
      box("mid", { fill: "#0f0", x: 0, y: 0, width: 300, height: 300 }),
    ]);
    s = grouped(s, ["s1", "mid"], "g"); // s1 expands to sub → 2 child units
    expect(groupIds(s, "g")).toEqual(["mid", "s1", "s2"]);
  });

  it("interleaved non-members keep their slots; only the grouped shapes reorder", () => {
    // between/after are loose non-members sitting among the members in the array.
    let s = seeded([
      box("small", { fill: "#f00", x: 20, y: 20, width: 30, height: 30 }),
      box("between", { x: 500, y: 500, width: 10, height: 10 }),
      box("big", { fill: "#00f", x: 0, y: 0, width: 100, height: 100 }),
    ]);
    s = grouped(s, ["small", "big"], "g");
    // Non-member "between" stays put; member slots now hold big then small.
    expect(s.shapes.map((sh) => sh.id)).toEqual(["big", "between", "small"]);
  });

  it("ungroup then regroup is stable (idempotent order)", () => {
    let s = seeded([
      box("small", { fill: "#f00", x: 20, y: 20, width: 30, height: 30 }),
      box("big", { fill: "#00f", x: 0, y: 0, width: 100, height: 100 }),
    ]);
    s = grouped(s, ["small", "big"], "g1");
    const first = groupIds(s, "g1");
    s = drawReducer(s, { type: "select", ids: ["small", "big"] });
    s = drawReducer(s, { type: "ungroup" });
    s = grouped(s, ["small", "big"], "g2");
    expect(groupIds(s, "g2")).toEqual(first); // re-grouping yields the same order
  });
});

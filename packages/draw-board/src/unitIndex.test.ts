import { describe, it, expect } from "vitest";
import { UnitIndex } from "./unitIndex.ts";
import type { BoxShape, Shape } from "./drawModel.ts";

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

describe("UnitIndex", () => {
  it("maps members to root units and caches union bounds", () => {
    const idx = new UnitIndex();
    const shapes: Shape[] = [
      box("a", { groupPath: ["g"] }),
      box("b", { x: 100, y: 100, groupPath: ["g"] }),
      box("c", { x: 300 }),
    ];
    idx.update(shapes);
    expect(idx.rootOf("a")).toBe("g");
    expect(idx.rootOf("c")).toBe("c");
    expect([...idx.membersOf("g")].sort()).toEqual(["a", "b"]);
    expect(idx.isGroupedMember("a")).toBe(true);
    expect(idx.isGroupedMember("c")).toBe(false);
    expect(idx.boundsOf("g")).toEqual({ x: 10, y: 10, width: 130, height: 120 });
    expect(idx.boundsOf("c")).toEqual({ x: 300, y: 10, width: 40, height: 30 });
  });

  it("identity-diffs updates: a moved member refreshes its unit's bounds; regroup/removal rehomes it", () => {
    const idx = new UnitIndex();
    const a = box("a", { groupPath: ["g"] });
    const b = box("b", { x: 100, y: 100, groupPath: ["g"] });
    const v1: Shape[] = [a, b];
    idx.update(v1);
    expect(idx.boundsOf("g")!.width).toBe(130);
    // Same array → free, same answers.
    idx.update(v1);
    // Move b (new identity, same unit).
    const v2: Shape[] = [a, { ...b, x: 200 }];
    idx.update(v2);
    expect(idx.boundsOf("g")!.width).toBe(230);
    // Ungroup b (identity + rootKey change).
    const v3: Shape[] = [a, { ...b, x: 200, groupPath: undefined }];
    idx.update(v3);
    expect([...idx.membersOf("g")]).toEqual(["a"]);
    expect(idx.rootOf("b")).toBe("b");
    // Delete b.
    idx.update([a]);
    expect(idx.rootOf("b")).toBeUndefined();
    expect(idx.membersOf("b").size).toBe(0);
  });
});

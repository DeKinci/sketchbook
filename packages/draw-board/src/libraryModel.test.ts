import { describe, it, expect } from "vitest";
import {
  elementFromShapes,
  placeElement,
  elementPreviewUrl,
  removeEntry,
  addSeparatorAfter,
  renameSeparator,
  type LibraryEntry,
} from "./libraryModel.ts";
import { contentBounds, type BoxShape, type Shape } from "./drawModel.ts";

let n = 0;
const newId = () => `n${++n}`;

const rect = (id: string, over: Partial<BoxShape> = {}): Shape => ({
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

describe("elementFromShapes", () => {
  it("normalizes the capture to the origin with fresh ids, leaving the originals untouched", () => {
    const orig = [rect("a", { x: 100, y: 50, width: 80, height: 40 }), rect("b", { x: 200, y: 120, width: 30, height: 30 })];
    const b = contentBounds(orig)!;
    const el = elementFromShapes(orig, newId)!;
    expect(el.kind).toBe("element");
    expect(el.width).toBe(b.width);
    expect(el.height).toBe(b.height);
    // Content bbox sits at (0,0) — the element is position-free.
    const nb = contentBounds(el.shapes)!;
    expect(nb.x).toBeCloseTo(0);
    expect(nb.y).toBeCloseTo(0);
    // Fresh ids; source shapes not mutated.
    expect(el.shapes.map((s) => s.id)).not.toContain("a");
    expect(orig[0]).toMatchObject({ id: "a", x: 100, y: 50 });
  });

  it("keeps internal grouping under a REMINTED gid (a captured group is its own group)", () => {
    const orig = [rect("a", { groupPath: ["g1"] }), rect("b", { x: 80, groupPath: ["g1"] })];
    const el = elementFromShapes(orig, newId)!;
    const paths = el.shapes.map((s) => s.groupPath);
    expect(paths[0]).toHaveLength(1);
    expect(paths[0]).toEqual(paths[1]); // still ONE group…
    expect(paths[0]![0]).not.toBe("g1"); // …but not welded to the source's
  });

  it("returns null for an empty capture", () => {
    expect(elementFromShapes([], newId)).toBeNull();
  });
});

describe("placeElement", () => {
  it("centers fresh-id clones on the drop point", () => {
    const el = elementFromShapes([rect("a", { x: 100, y: 50, width: 40, height: 30 })], newId)!;
    const placed = placeElement(el, { x: 200, y: 100 }, newId);
    const b = contentBounds(placed)!;
    expect(b.x + b.width / 2).toBeCloseTo(200);
    expect(b.y + b.height / 2).toBeCloseTo(100);
    // Every placement is an independent copy — ids differ from the element's.
    expect(placed[0].id).not.toBe(el.shapes[0].id);
  });
});

describe("elementPreviewUrl", () => {
  it("returns an SVG data URL", () => {
    const el = elementFromShapes([rect("a")], newId)!;
    const url = elementPreviewUrl(el);
    expect(url.startsWith("data:image/svg+xml")).toBe(true);
    expect(decodeURIComponent(url)).toContain("<svg");
  });
});

describe("library entry ops", () => {
  const el = (id: string): LibraryEntry => ({ kind: "element", id, shapes: [rect(`s-${id}`)], width: 40, height: 30 });
  const sep = (id: string, label?: string): LibraryEntry => ({ kind: "separator", id, label });

  it("removeEntry drops one entry by id (element or separator)", () => {
    const entries = [el("e1"), sep("s1"), el("e2")];
    expect(removeEntry(entries, "s1").map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(removeEntry(entries, "e2").map((e) => e.id)).toEqual(["e1", "s1"]);
    expect(removeEntry(entries, "ghost")).toHaveLength(3);
  });

  it("addSeparatorAfter inserts right after the anchor, appends when the anchor is gone", () => {
    const entries = [el("e1"), el("e2")];
    expect(addSeparatorAfter(entries, "e1", "s1").map((e) => e.id)).toEqual(["e1", "s1", "e2"]);
    expect(addSeparatorAfter(entries, "ghost", "s1").map((e) => e.id)).toEqual(["e1", "e2", "s1"]);
  });

  it("renameSeparator sets a label, trims blanks away, and never touches elements", () => {
    const entries = [el("e1"), sep("s1")];
    const named = renameSeparator(entries, "s1", "  Icons  ");
    expect(named[1]).toMatchObject({ id: "s1", label: "Icons" });
    const cleared = renameSeparator(named, "s1", "   ");
    expect((cleared[1] as { label?: string }).label).toBeUndefined();
    expect(renameSeparator(entries, "e1", "nope")[0]).toMatchObject({ id: "e1", kind: "element" });
  });
});

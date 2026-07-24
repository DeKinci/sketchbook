import { describe, it, expect } from "vitest";
import {
  elementFromShapes,
  placeElement,
  elementPreviewUrl,
  removeEntry,
  addSeparatorAfter,
  renameSeparator,
  insertElementAt,
  moveEntry,
  elementSignature,
  findDuplicateId,
  serializeLibrary,
  parseLibraryFile,
  mergeLibrary,
  sanitizeEntries,
  isLibraryFileName,
  LIBRARY_FILE_EXT,
  type LibraryElement,
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

  it("insertElementAt drops the element at the slot, clamping out-of-range indices", () => {
    const entries = [el("e1"), el("e2")];
    const fresh = { kind: "element", id: "new", shapes: [rect("x")], width: 40, height: 30 } as LibraryElement;
    expect(insertElementAt(entries, fresh, 1).map((e) => e.id)).toEqual(["e1", "new", "e2"]);
    expect(insertElementAt(entries, fresh, 0).map((e) => e.id)).toEqual(["new", "e1", "e2"]);
    expect(insertElementAt(entries, fresh, 99).map((e) => e.id)).toEqual(["e1", "e2", "new"]);
  });

  it("moveEntry pulls one out and reinserts at the target slot (index is over the OTHERS)", () => {
    const entries = [el("a"), el("b"), el("c")];
    expect(moveEntry(entries, "a", 2).map((e) => e.id)).toEqual(["b", "c", "a"]); // a → end
    expect(moveEntry(entries, "c", 0).map((e) => e.id)).toEqual(["c", "a", "b"]); // c → front
    expect(moveEntry(entries, "b", 1).map((e) => e.id)).toEqual(["a", "b", "c"]); // stays put
    expect(moveEntry(entries, "ghost", 0)).toBe(entries); // unknown id → identity
  });
});

describe("dedup by signature", () => {
  it("two captures of the same arrangement (fresh ids each, different board positions) share a signature", () => {
    const a = elementFromShapes([rect("a1", { x: 100, y: 50 }), rect("a2", { x: 170, y: 90, width: 20, height: 20 })], newId)!;
    const b = elementFromShapes([rect("b1", { x: 300, y: 210 }), rect("b2", { x: 370, y: 250, width: 20, height: 20 })], newId)!;
    expect(elementSignature(a.shapes)).toBe(elementSignature(b.shapes));
  });

  it("a different arrangement gets a different signature", () => {
    const a = elementFromShapes([rect("a1", { width: 40, height: 30 })], newId)!;
    const b = elementFromShapes([rect("b1", { width: 80, height: 30 })], newId)!;
    expect(elementSignature(a.shapes)).not.toBe(elementSignature(b.shapes));
  });

  it("grouping is part of the signature but the reminted gid is NOT", () => {
    const grouped = elementFromShapes([rect("a", { groupPath: ["g1"] }), rect("b", { x: 80, groupPath: ["g1"] })], newId)!;
    const grouped2 = elementFromShapes([rect("a", { groupPath: ["gZZ"] }), rect("b", { x: 80, groupPath: ["gZZ"] })], newId)!;
    const loose = elementFromShapes([rect("a"), rect("b", { x: 80 })], newId)!;
    expect(elementSignature(grouped.shapes)).toBe(elementSignature(grouped2.shapes)); // gid name irrelevant
    expect(elementSignature(grouped.shapes)).not.toBe(elementSignature(loose.shapes)); // but grouped ≠ ungrouped
  });

  it("findDuplicateId spots an existing match and clears a novel element; separators never match", () => {
    const first = elementFromShapes([rect("a1", { x: 10, y: 10 })], newId)!;
    const same = elementFromShapes([rect("z9", { x: 400, y: 400 })], newId)!; // same 40×30 rect elsewhere
    const other = elementFromShapes([rect("b1", { width: 120, height: 90 })], newId)!;
    const entries: LibraryEntry[] = [{ kind: "separator", id: "s" }, first];
    expect(findDuplicateId(entries, same)).toBe(first.id);
    expect(findDuplicateId(entries, other)).toBeNull();
  });
});

describe("library bundle (serialize / parse / merge)", () => {
  const el = (id: string): LibraryEntry => ({ kind: "element", id, shapes: [rect(`s-${id}`)], width: 40, height: 30 });
  const sep = (id: string, label?: string): LibraryEntry => ({ kind: "separator", id, label });

  it("round-trips through serialize → parse", () => {
    const entries = [el("e1"), sep("s1", "grp"), el("e2")];
    const parsed = parseLibraryFile(serializeLibrary(entries));
    expect(parsed).toEqual(entries);
  });

  it("parseLibraryFile rejects non-bundles (wrong kind, junk, plain array)", () => {
    expect(parseLibraryFile("not json")).toBeNull();
    expect(parseLibraryFile(JSON.stringify({ kind: "something-else", entries: [] }))).toBeNull();
    expect(parseLibraryFile(JSON.stringify([el("e1")]))).toBeNull(); // bare array, no envelope
  });

  it("sanitizeEntries drops malformed entries (missing id, bad kind, element without shapes)", () => {
    const raw = [el("ok"), { kind: "element", id: "no-shapes" }, { kind: "bogus", id: "x" }, { id: "no-kind" }, sep("s")];
    expect(sanitizeEntries(raw).map((e) => e.id)).toEqual(["ok", "s"]);
    expect(sanitizeEntries("nope")).toEqual([]);
  });

  it("mergeLibrary appends new ids and replaces matching ones in place (update), preserving order", () => {
    const existing = [el("a"), sep("s"), el("b")];
    const updatedB: LibraryEntry = { kind: "element", id: "b", shapes: [rect("s-b", { width: 99 })], width: 99, height: 30 };
    const merged = mergeLibrary(existing, [updatedB, el("c")]);
    expect(merged.map((e) => e.id)).toEqual(["a", "s", "b", "c"]); // order kept, c appended
    expect((merged[2] as LibraryElement).width).toBe(99); // b replaced with the newer copy
  });

  it("isLibraryFileName matches the extension case-insensitively", () => {
    expect(isLibraryFileName(`my library${LIBRARY_FILE_EXT}`)).toBe(true);
    expect(isLibraryFileName("MY-LIB.DRAWLIB")).toBe(true);
    expect(isLibraryFileName("photo.png")).toBe(false);
  });
});

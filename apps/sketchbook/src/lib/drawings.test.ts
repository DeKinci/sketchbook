import { beforeEach, describe, expect, it } from "vitest";
import { createDrawing, loadDrawings, nextName, renameDrawing, saveDrawings, updateDoc, type Drawing } from "./drawings.ts";

const d = (id: string, name: string): Drawing => ({ id, name, doc: { shapes: [], width: 720, height: 460 }, createdAt: 1 });

describe("pure list ops", () => {
  it("nextName picks the first free Untitled slot", () => {
    expect(nextName([])).toBe("Untitled");
    expect(nextName([d("a", "Untitled")])).toBe("Untitled 2");
    expect(nextName([d("a", "Untitled"), d("b", "Untitled 2")])).toBe("Untitled 3");
    expect(nextName([d("a", "Untitled 2")])).toBe("Untitled"); // gap reuse
  });

  it("createDrawing appends with a fresh id and empty doc", () => {
    const { list, created } = createDrawing([d("a", "Untitled")], 42);
    expect(list).toHaveLength(2);
    expect(created.name).toBe("Untitled 2");
    expect(created.createdAt).toBe(42);
    expect(created.doc.shapes).toEqual([]);
  });

  it("renameDrawing trims; an empty result is a cancel (list untouched)", () => {
    const list = [d("a", "Untitled")];
    expect(renameDrawing(list, "a", "  Plan B  ")[0].name).toBe("Plan B");
    expect(renameDrawing(list, "a", "   ")).toBe(list);
  });

  it("updateDoc swaps only the target's doc", () => {
    const list = [d("a", "One"), d("b", "Two")];
    const doc = { shapes: [], width: 1, height: 1 };
    const next = updateDoc(list, "b", doc);
    expect(next[1].doc).toBe(doc);
    expect(next[0]).toBe(list[0]);
  });
});

describe("localStorage round-trip", () => {
  // window.localStorage explicitly — Node's bare-global stub shadows jsdom's.
  beforeEach(() => window.localStorage.clear());

  it("save → load preserves the list; corrupt/absent storage loads empty", () => {
    expect(loadDrawings()).toEqual([]);
    const list = [d("a", "One")];
    saveDrawings(list);
    expect(loadDrawings()).toEqual(list);
    window.localStorage.setItem("sketchbook:drawings", "{not json");
    expect(loadDrawings()).toEqual([]);
    window.localStorage.setItem("sketchbook:drawings", JSON.stringify([{ bogus: true }]));
    expect(loadDrawings()).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { lineWidth, textBlockSize, wrapLines } from "./textMetrics.ts";

describe("textMetrics", () => {
  it("lineWidth uses real Arial advances (i is narrow, W is wide), beyond the tables falls back to 0.6em", () => {
    expect(lineWidth("i", 10)).toBeCloseTo(2.22, 2);
    expect(lineWidth("W", 10)).toBeCloseTo(9.44, 2);
    expect(lineWidth("Hi", 10)).toBeCloseTo(7.22 + 2.22, 2);
    expect(lineWidth("→", 10)).toBeCloseTo(6, 2);
    expect(lineWidth("", 10)).toBe(0);
  });

  it("Cyrillic uses REAL advances from the embedded face — not a flat guess (wrap points must match the rendered glyphs)", () => {
    expect(lineWidth("а", 10)).toBeCloseTo(5.56, 2); // metric twin of latin 'a' (Arial-compatible)
    expect(lineWidth("ы", 10)).toBeCloseTo(7.19, 2); // wide — a flat 0.6em underprices it
    expect(lineWidth("г", 10)).toBeCloseTo(3.65, 2); // narrow — a flat 0.6em overprices it
    expect(lineWidth("№", 10)).toBeCloseTo(10.73, 2); // subset straggler outside U+0400-045F
    // A wrap decision flips with real advances: "ыдвлаподлва" is 6.323em real
    // vs 6.6em guessed — a 6.5em box keeps the real word whole, while the flat
    // guess would hard-break it mid-word.
    expect(wrapLines("ыы ыдвлаподлва", 10, 65)).toEqual(["ыы", "ыдвлаподлва"]);
  });

  it("no maxWidth: lines break ONLY at explicit newlines", () => {
    expect(wrapLines("one two three", 16)).toEqual(["one two three"]);
    expect(wrapLines("a\nb\n\nc", 16)).toEqual(["a", "b", "", "c"]);
  });

  it("greedy word wrap at maxWidth; spaces at the boundary die; explicit newlines still break", () => {
    // "aaa bbb ccc" at 10px: each word ≈ 16.68 wide, word+space ≈ 19.46.
    expect(wrapLines("aaa bbb ccc", 10, 40)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapLines("aaa bbb ccc", 10, 20)).toEqual(["aaa", "bbb", "ccc"]);
    expect(wrapLines("aaa\nbbb ccc", 10, 40)).toEqual(["aaa", "bbb ccc"]);
    // Trailing spaces never mint a blank line…
    expect(wrapLines("aaa bbb   ", 10, 20)).toEqual(["aaa", "bbb"]);
    // …but an explicit empty paragraph stays.
    expect(wrapLines("aaa\n\nbbb", 10, 40)).toEqual(["aaa", "", "bbb"]);
  });

  it("a word wider than the box hard-breaks mid-word (the box wins)", () => {
    const lines = wrapLines("abcdefghij", 10, 20); // ~55.6 wide vs 20 box
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join("")).toBe("abcdefghij"); // nothing lost
    for (const ln of lines.slice(0, -1)) expect(lineWidth(ln, 10)).toBeLessThanOrEqual(20);
    // A box narrower than one glyph keeps one char per line (no infinite loop).
    expect(wrapLines("WW", 10, 5)).toEqual(["W", "W"]);
  });

  it("textBlockSize: auto width = widest line; boxed width = the box; height = lines × fontSize", () => {
    const auto = textBlockSize("aaa\nbbbbbb", 10);
    expect(auto.width).toBeCloseTo(lineWidth("bbbbbb", 10), 5);
    expect(auto.height).toBe(20);
    const boxed = textBlockSize("aaa bbb ccc", 10, 40);
    expect(boxed.width).toBe(40);
    expect(boxed.height).toBe(20); // ["aaa bbb", "ccc"]
    expect(textBlockSize("", 16).height).toBe(16); // never a zero-height box
  });
});

import { describe, it, expect } from "vitest";
import { normalizeColor, svgPalette, recolorSvg, decodeSvg, svgDataUrl, discoverSvgPaint, SVG_NONE } from "./svgRecolor.ts";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

describe("normalizeColor — canonicalize any CSS color to #rrggbb", () => {
  it("hex: short/long/upper/alpha all fold to lowercase #rrggbb", () => {
    expect(normalizeColor("#f00")).toBe("#ff0000");
    expect(normalizeColor("#ff0000")).toBe("#ff0000");
    expect(normalizeColor("#FF0000")).toBe("#ff0000");
    expect(normalizeColor("#ff000080")).toBe("#ff0000"); // 8-digit: alpha dropped
    expect(normalizeColor("#f008")).toBe("#ff0000"); // 4-digit: alpha dropped
    expect(normalizeColor("  #0a0b0c  ")).toBe("#0a0b0c"); // trimmed
  });

  it("rgb()/rgba() — ints and percentages, alpha ignored", () => {
    expect(normalizeColor("rgb(255,0,0)")).toBe("#ff0000");
    expect(normalizeColor("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(normalizeColor("rgba(0,0,255,0.5)")).toBe("#0000ff");
    expect(normalizeColor("rgb(100%,0%,0%)")).toBe("#ff0000");
  });

  it("hsl()/hsla() → rgb hex", () => {
    expect(normalizeColor("hsl(0,100%,50%)")).toBe("#ff0000");
    expect(normalizeColor("hsl(120, 100%, 50%)")).toBe("#00ff00");
    expect(normalizeColor("hsl(240,100%,50%)")).toBe("#0000ff");
    expect(normalizeColor("hsla(0,0%,0%,0.3)")).toBe("#000000");
  });

  it("named colors (case-insensitive, incl. rebeccapurple)", () => {
    expect(normalizeColor("red")).toBe("#ff0000");
    expect(normalizeColor("RED")).toBe("#ff0000");
    expect(normalizeColor("black")).toBe("#000000");
    expect(normalizeColor("white")).toBe("#ffffff");
    expect(normalizeColor("rebeccapurple")).toBe("#663399");
  });

  it("currentColor resolves to black", () => {
    expect(normalizeColor("currentColor")).toBe("#000000");
    expect(normalizeColor("currentcolor")).toBe("#000000");
  });

  it("non-paints and unknowns → null", () => {
    expect(normalizeColor("none")).toBeNull();
    expect(normalizeColor("transparent")).toBeNull();
    expect(normalizeColor("inherit")).toBeNull();
    expect(normalizeColor("url(#grad)")).toBeNull();
    expect(normalizeColor("notacolor")).toBeNull();
    expect(normalizeColor("#12")).toBeNull(); // malformed hex length
    expect(normalizeColor("#gggggg")).toBeNull(); // non-hex digits
  });
});

describe("svgPalette — the two-channel color set of an SVG", () => {
  it("reads presentation attributes per channel", () => {
    const p = svgPalette(`<svg><rect fill="#f00" stroke="blue"/></svg>`);
    expect(p.fills).toEqual(["#ff0000"]);
    expect(p.strokes).toEqual(["#0000ff"]);
  });

  it("reads inline style declarations", () => {
    const p = svgPalette(`<svg><rect style="fill:#00ff00;stroke:red"/></svg>`);
    expect(p.fills).toEqual(["#00ff00"]);
    expect(p.strokes).toEqual(["#ff0000"]);
  });

  it("reads <style> CSS rules (Illustrator/Figma exports)", () => {
    const p = svgPalette(`<svg><style>.a{fill:#123456}.b{stroke:#654321}</style><path class="a"/><path class="b"/></svg>`);
    expect(p.fills).toEqual(["#123456"]);
    expect(p.strokes).toEqual(["#654321"]);
  });

  it("dedupes and keeps first-encounter order", () => {
    const p = svgPalette(`<svg><rect fill="#f00"/><rect fill="#00f"/><rect fill="#ff0000"/></svg>`);
    expect(p.fills).toEqual(["#ff0000", "#0000ff"]);
  });

  it("ignores none, gradients (url), and non-color paint props", () => {
    const p = svgPalette(`<svg><rect fill="none" stroke="url(#g)" fill-opacity="0.5" stroke-width="2"/><rect fill="#abcdef"/></svg>`);
    expect(p.fills).toEqual(["#abcdef"]);
    expect(p.strokes).toEqual([]);
  });

  it("currentColor is captured as black", () => {
    const p = svgPalette(`<svg><path fill="currentColor"/></svg>`);
    expect(p.fills).toEqual(["#000000"]);
  });

  it("does NOT confuse fill-opacity / stroke-width for a paint", () => {
    const p = svgPalette(`<svg><rect fill-opacity="0.5" stroke-width="2" fill="#abcdef"/></svg>`);
    expect(p.fills).toEqual(["#abcdef"]);
    expect(p.strokes).toEqual([]);
  });
});

describe("recolorSvg — bake per-channel maps into the SVG text", () => {
  it("remaps a fill presentation attribute, preserving markup", () => {
    expect(recolorSvg(`<rect fill="#ff0000" x="1"/>`, { "#ff0000": "#0000ff" })).toBe(`<rect fill="#0000ff" x="1"/>`);
  });

  it("channels are independent — a fill map never touches a same-colored stroke", () => {
    const out = recolorSvg(`<rect fill="#f00" stroke="#f00"/>`, { "#ff0000": "#00ff00" });
    expect(out).toBe(`<rect fill="#00ff00" stroke="#f00"/>`);
  });

  it("remaps a stroke via strokeMap only", () => {
    const out = recolorSvg(`<rect fill="#f00" stroke="#f00"/>`, undefined, { "#ff0000": "#00ff00" });
    expect(out).toBe(`<rect fill="#f00" stroke="#00ff00"/>`);
  });

  it("remaps inside inline style and <style> CSS", () => {
    expect(recolorSvg(`<rect style="fill:#ff0000;stroke-width:2"/>`, { "#ff0000": "#0000ff" })).toBe(
      `<rect style="fill:#0000ff;stroke-width:2"/>`
    );
    expect(recolorSvg(`<style>.a{fill:#ff0000}</style>`, { "#ff0000": "#0000ff" })).toBe(`<style>.a{fill:#0000ff}</style>`);
  });

  it("normalizes the source token before matching — named/rgb/currentColor all map", () => {
    expect(recolorSvg(`<rect fill="red"/>`, { "#ff0000": "#0000ff" })).toBe(`<rect fill="#0000ff"/>`);
    expect(recolorSvg(`<rect fill="rgb(255,0,0)"/>`, { "#ff0000": "#0000ff" })).toBe(`<rect fill="#0000ff"/>`);
    expect(recolorSvg(`<path fill="currentColor"/>`, { "#000000": "#ff0000" })).toBe(`<path fill="#ff0000"/>`);
  });

  it("maps a fill to none (transparent)", () => {
    expect(recolorSvg(`<rect fill="#ff0000"/>`, { "#ff0000": SVG_NONE })).toBe(`<rect fill="none"/>`);
  });

  it("leaves unmapped colors and non-paint markup untouched", () => {
    const src = `<rect fill="#123456" stroke="#abcdef" stroke-width="3"/>`;
    expect(recolorSvg(src, { "#ff0000": "#000000" })).toBe(src);
  });

  it("empty / absent maps are identity", () => {
    const src = `<rect fill="#ff0000"/>`;
    expect(recolorSvg(src)).toBe(src);
    expect(recolorSvg(src, {}, {})).toBe(src);
  });
});

describe("discoverSvgPaint — the palette stamped on a freshly-added image", () => {
  it("returns an SVG's discovered fill/stroke palette", () => {
    const paint = discoverSvgPaint(b64(`<svg><rect fill="#e5484d" stroke="#0000ff"/></svg>`), "image/svg+xml");
    expect(paint).toEqual({ fills: ["#e5484d"], strokes: ["#0000ff"] });
  });

  it("is undefined for a raster image (an opaque blob)", () => {
    expect(discoverSvgPaint(b64("not-an-svg"), "image/png")).toBeUndefined();
  });

  it("is undefined for an SVG with no flat colors (nothing to recolor)", () => {
    expect(discoverSvgPaint(b64(`<svg><rect fill="url(#g)" stroke="none"/></svg>`), "image/svg+xml")).toBeUndefined();
  });
});

describe("decodeSvg / svgDataUrl", () => {
  it("decodes base64 SVG bytes back to text", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#f00"/></svg>`;
    const b64 = Buffer.from(svg, "utf-8").toString("base64");
    expect(decodeSvg(b64)).toBe(svg);
  });

  it("builds an XML-safe inline data URL (no raw quote/amp/lt)", () => {
    const url = svgDataUrl(`<svg><rect fill="#f00" opacity=".5"/></svg>`);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    const body = url.slice("data:image/svg+xml;charset=utf-8,".length);
    expect(body).not.toMatch(/["<&]/);
    expect(decodeURIComponent(body)).toContain(`fill="#f00"`);
  });
});

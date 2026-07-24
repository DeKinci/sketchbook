/**
 * SVG recoloring — the pure geometry-free core behind treating an SVG image's
 * own colors as a two-channel palette (fills + strokes), the same way a vector
 * shape has a fill and a stroke.
 *
 * An SVG carries flat colors in three places, all of the form
 * `fill <sep> <color>` / `stroke <sep> <color>` where `<sep>` is `=` (a
 * presentation attribute: `fill="#f00"`) or `:` (an inline `style="…"` or a
 * `<style>` CSS rule: `fill:#f00`). This module scans that one shape uniformly:
 *
 *   • {@link svgPalette}   — the distinct fill / stroke colors an SVG uses.
 *   • {@link recolorSvg}   — rewrite those colors through per-channel maps.
 *   • {@link normalizeColor} — canonicalize any CSS color token to `#rrggbb`.
 *
 * It is pure and DOM-free (a plain string in, a plain string out) so it runs in
 * the node test suite, in the browser render path, and in SVG export alike. The
 * model stores the ORIGINAL palette + original→replacement maps on the image and
 * this module bakes them on demand — the source bytes are never mutated.
 *
 * v1 scope: flat colors only. Gradient/pattern paints (`url(#…)`), `none`, and
 * `transparent` are left untouched (not part of the palette); hex alpha is
 * dropped (the board palette is opaque). Colors reached purely by inheritance
 * with no explicit `fill`/`stroke` token aren't discoverable.
 */

/** The sentinel a fill maps to for "no paint" — mirrors a local shape's `null`
 *  (unfilled) fill. Emitted verbatim as `fill="none"`. */
export const SVG_NONE = "none";

const CSS_NAMED: Record<string, string> = {
  aliceblue: "#f0f8ff", antiquewhite: "#faebd7", aqua: "#00ffff", aquamarine: "#7fffd4",
  azure: "#f0ffff", beige: "#f5f5dc", bisque: "#ffe4c4", black: "#000000",
  blanchedalmond: "#ffebcd", blue: "#0000ff", blueviolet: "#8a2be2", brown: "#a52a2a",
  burlywood: "#deb887", cadetblue: "#5f9ea0", chartreuse: "#7fff00", chocolate: "#d2691e",
  coral: "#ff7f50", cornflowerblue: "#6495ed", cornsilk: "#fff8dc", crimson: "#dc143c",
  cyan: "#00ffff", darkblue: "#00008b", darkcyan: "#008b8b", darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9", darkgreen: "#006400", darkgrey: "#a9a9a9", darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b", darkolivegreen: "#556b2f", darkorange: "#ff8c00", darkorchid: "#9932cc",
  darkred: "#8b0000", darksalmon: "#e9967a", darkseagreen: "#8fbc8f", darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f", darkslategrey: "#2f4f4f", darkturquoise: "#00ced1", darkviolet: "#9400d3",
  deeppink: "#ff1493", deepskyblue: "#00bfff", dimgray: "#696969", dimgrey: "#696969",
  dodgerblue: "#1e90ff", firebrick: "#b22222", floralwhite: "#fffaf0", forestgreen: "#228b22",
  fuchsia: "#ff00ff", gainsboro: "#dcdcdc", ghostwhite: "#f8f8ff", gold: "#ffd700",
  goldenrod: "#daa520", gray: "#808080", green: "#008000", greenyellow: "#adff2f",
  grey: "#808080", honeydew: "#f0fff0", hotpink: "#ff69b4", indianred: "#cd5c5c",
  indigo: "#4b0082", ivory: "#fffff0", khaki: "#f0e68c", lavender: "#e6e6fa",
  lavenderblush: "#fff0f5", lawngreen: "#7cfc00", lemonchiffon: "#fffacd", lightblue: "#add8e6",
  lightcoral: "#f08080", lightcyan: "#e0ffff", lightgoldenrodyellow: "#fafad2", lightgray: "#d3d3d3",
  lightgreen: "#90ee90", lightgrey: "#d3d3d3", lightpink: "#ffb6c1", lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa", lightskyblue: "#87cefa", lightslategray: "#778899", lightslategrey: "#778899",
  lightsteelblue: "#b0c4de", lightyellow: "#ffffe0", lime: "#00ff00", limegreen: "#32cd32",
  linen: "#faf0e6", magenta: "#ff00ff", maroon: "#800000", mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd", mediumorchid: "#ba55d3", mediumpurple: "#9370db", mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee", mediumspringgreen: "#00fa9a", mediumturquoise: "#48d1cc", mediumvioletred: "#c71585",
  midnightblue: "#191970", mintcream: "#f5fffa", mistyrose: "#ffe4e1", moccasin: "#ffe4b5",
  navajowhite: "#ffdead", navy: "#000080", oldlace: "#fdf5e6", olive: "#808000",
  olivedrab: "#6b8e23", orange: "#ffa500", orangered: "#ff4500", orchid: "#da70d6",
  palegoldenrod: "#eee8aa", palegreen: "#98fb98", paleturquoise: "#afeeee", palevioletred: "#db7093",
  papayawhip: "#ffefd5", peachpuff: "#ffdab9", peru: "#cd853f", pink: "#ffc0cb",
  plum: "#dda0dd", powderblue: "#b0e0e6", purple: "#800080", rebeccapurple: "#663399",
  red: "#ff0000", rosybrown: "#bc8f8f", royalblue: "#4169e1", saddlebrown: "#8b4513",
  salmon: "#fa8072", sandybrown: "#f4a460", seagreen: "#2e8b57", seashell: "#fff5ee",
  sienna: "#a0522d", silver: "#c0c0c0", skyblue: "#87ceeb", slateblue: "#6a5acd",
  slategray: "#708090", slategrey: "#708090", snow: "#fffafa", springgreen: "#00ff7f",
  steelblue: "#4682b4", tan: "#d2b48c", teal: "#008080", thistle: "#d8bfd8",
  tomato: "#ff6347", turquoise: "#40e0d0", violet: "#ee82ee", wheat: "#f5deb3",
  white: "#ffffff", whitesmoke: "#f5f5f5", yellow: "#ffff00", yellowgreen: "#9acd32",
};

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** A CSS number that may be a percentage (of `whole`) or a bare value. */
function chan(tok: string, whole: number): number {
  tok = tok.trim();
  return tok.endsWith("%") ? (parseFloat(tok) / 100) * whole : parseFloat(tok);
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/**
 * Canonicalize a CSS color token to a lowercase `#rrggbb`, or null if it is not
 * a flat paint we recolor. `currentColor` resolves to black (an isolated SVG's
 * default `color`); `none`/`transparent`/`url(…)`/`inherit`/unknown → null.
 * Alpha (hex 4/8-digit, rgba/hsla) is dropped — the board palette is opaque.
 */
export function normalizeColor(token: string): string | null {
  const t = token.trim().toLowerCase();
  if (!t || t === "none" || t === "transparent" || t === "inherit" || t.startsWith("url(")) return null;
  if (t === "currentcolor") return "#000000";
  if (t[0] === "#") {
    const h = t.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`;
    return null;
  }
  const fn = t.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    if (fn[1].startsWith("rgb")) return toHex(chan(parts[0], 255), chan(parts[1], 255), chan(parts[2], 255));
    // hsl: h is an angle (deg), s/l are percentages.
    return hslToHex(parseFloat(parts[0]), chan(parts[1], 1), chan(parts[2], 1));
  }
  return CSS_NAMED[t] ?? null;
}

// One color token: a hex, an rgb()/rgba()/hsl()/hsla() function, or a bareword
// (named color / currentColor). Ordered so functions match whole, not truncated.
const COLOR_TOKEN = String.raw`#[0-9a-fA-F]+|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+`;
// `fill`/`stroke` (whole word — never `fill-opacity`/`stroke-width`) then `:`/`=`
// then an optional quote then the color. Captures: kw, sep(incl. quote), value.
const PAINT_RE = new RegExp(String.raw`\b(fill|stroke)(\s*[:=]\s*['"]?)(${COLOR_TOKEN})`, "gi");

/**
 * The distinct flat colors an SVG uses for fill and for stroke, each as a
 * normalized `#rrggbb` in first-encounter order — the image's two-channel
 * palette. Presentation attributes, inline `style`, and `<style>` CSS rules are
 * all scanned uniformly; `none`/gradients are ignored.
 */
export function svgPalette(svgText: string): { fills: string[]; strokes: string[] } {
  const fills: string[] = [];
  const strokes: string[] = [];
  for (const m of svgText.matchAll(PAINT_RE)) {
    const norm = normalizeColor(m[3]);
    if (!norm) continue;
    const bucket = m[1].toLowerCase() === "fill" ? fills : strokes;
    if (!bucket.includes(norm)) bucket.push(norm);
  }
  return { fills, strokes };
}

/**
 * Rewrite an SVG's flat colors through per-channel maps. Every `fill`/`stroke`
 * occurrence whose normalized color is a key of the matching map is replaced by
 * that map's value (a `#rrggbb`, or {@link SVG_NONE}); everything else — markup,
 * unmapped colors, the untouched channel — is preserved byte-for-byte. Empty /
 * absent maps return the source unchanged.
 */
export function recolorSvg(
  svgText: string,
  fillMap?: Record<string, string>,
  strokeMap?: Record<string, string>
): string {
  if (!fillMap && !strokeMap) return svgText;
  return svgText.replace(PAINT_RE, (whole, kw: string, sep: string, value: string) => {
    const norm = normalizeColor(value);
    if (!norm) return whole;
    const map = kw.toLowerCase() === "fill" ? fillMap : strokeMap;
    const to = map?.[norm];
    return to === undefined ? whole : `${kw}${sep}${to}`;
  });
}

/** Decode base64 SVG bytes to text (UTF-8 safe). Works in node and the browser. */
export function decodeSvg(dataBase64: string): string {
  const bin = atob(dataBase64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** An `image/svg+xml` data URL for inline SVG text — no base64 (UTF-8 clean via
 *  percent-encoding), safe to drop into an XML `href="…"` (no raw `"`/`&`/`<`). */
export function svgDataUrl(svgText: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}

import { describe, expect, it } from "vitest";
import { exportSvg, readSvgDoc } from "./svgExport.ts";
import { seedNodes } from "./drawModel.ts";
import type { BoxShape, DrawDoc, Shape } from "./drawModel.ts";

const doc = (shapes: Shape[], over: Partial<DrawDoc> = {}): DrawDoc => ({ shapes, width: 400, height: 300, ...over });
const rect = (id: string, x = 100, y = 100): Shape => ({ id, type: "rect", stroke: "#3b82f6", strokeWidth: 3, x, y, width: 60, height: 40 });

describe("exportSvg", () => {
  it("renders every shape kind with exact geometry", () => {
    const shapes: Shape[] = [
      rect("r"),
      { id: "e", type: "ellipse", stroke: "contrast", strokeWidth: 3, x: 200, y: 100, width: 80, height: 40 },
      { id: "l", type: "line", stroke: "#e5484d", strokeWidth: 6, points: [10, 10, 90, 60] },
      { id: "a", type: "arrow", stroke: "#30a46c", strokeWidth: 3, points: [10, 100, 90, 100], doubleHead: true },
      { id: "p", type: "pen", stroke: "#f5a623", strokeWidth: 3, points: [0, 0, 20, 10, 40, 5, 60, 20] },
      { id: "t", type: "text", stroke: "#f5a623", strokeWidth: 3, x: 5, y: 200, text: "hi <there>", fontSize: 18 },
    ];
    const svg = exportSvg(doc(shapes));
    expect(svg).toContain('<rect x="100" y="100" width="60" height="40"');
    expect(svg).toContain('<ellipse cx="240" cy="120" rx="40" ry="20"');
    expect(svg).toContain('stroke="#f5f5f5"'); // contrast ink → bright on the dark ground
    expect(svg).toContain('<line x1="10" y1="10" x2="90" y2="60"');
    expect((svg.match(/<path d="M 90 100 L|<path d="M 10 100 L/g) ?? []).length).toBe(2); // both arrowheads
    expect(svg).toContain("Q 20 10"); // pen smoothing control point
    expect(svg).toContain("hi &lt;there&gt;"); // escaping
  });

  it("exports a distorted box as its vector <path> (absolute coords; straight rect, cubic ellipse)", () => {
    const rectShape = { id: "dr", type: "rect", stroke: "#3b82f6", strokeWidth: 3, x: 100, y: 100, width: 60, height: 40 } as BoxShape;
    const svgRect = exportSvg(doc([{ ...rectShape, nodes: seedNodes(rectShape) } as Shape]));
    expect(svgRect).toContain('<path d="M 100 100 L 160 100 L 160 140 L 100 140 Z"'); // absolute, all-straight
    expect(svgRect).toContain('fill-rule="evenodd"'); // matches the even-odd hit test
    expect(svgRect).not.toContain('<rect x="100" y="100"'); // never the parametric primitive

    const ellShape = { id: "de", type: "ellipse", stroke: "#3b82f6", strokeWidth: 3, x: 10, y: 20, width: 80, height: 80 } as BoxShape;
    const svgEll = exportSvg(doc([{ ...ellShape, nodes: seedNodes(ellShape) } as Shape]));
    expect(svgEll).toContain('<path d="M 50 20 C'); // top anchor abs (10+40, 20+0), cubic segments
    expect(svgEll).not.toContain("<ellipse");
  });

  it("blank sketch viewBox trims to content (+30 pad), unclamped on the plane", () => {
    const svg = exportSvg(doc([rect("far", -500, 2000)]));
    expect(svg).toContain('viewBox="-530 1970 120 100"');
    expect(svg).toContain('fill="#1a1a1e"'); // opaque board ground behind the trim
  });

  it("annotation exports the doc box with the background image", () => {
    const svg = exportSvg(doc([rect("r")], { background: { dataBase64: "QUJD", mediaType: "image/png", width: 400, height: 300 } }));
    expect(svg).toContain('viewBox="0 0 400 300"');
    expect(svg).toContain('href="data:image/png;base64,QUJD"');
  });

  it("a placed image embeds its raw bytes; a recolored SVG bakes the maps into an inline href", () => {
    const src = `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ff0000"/></svg>`;
    const b64 = Buffer.from(src, "utf-8").toString("base64");
    const img = (over: object = {}): Shape =>
      ({ id: "im", type: "image", stroke: "#000", strokeWidth: 1, x: 0, y: 0, width: 50, height: 50, dataBase64: b64, mediaType: "image/svg+xml", ...over }) as Shape;
    // No maps → raw base64 passthrough (unchanged behavior).
    expect(exportSvg(doc([img()]))).toContain(`href="data:image/svg+xml;base64,${b64}"`);
    // A fill recolor → an inline percent-encoded href carrying the NEW color.
    const svg = exportSvg(doc([img({ svg: { fills: ["#ff0000"], strokes: [], fillMap: { "#ff0000": "#0000ff" } } })]));
    const m = svg.match(/href="(data:image\/svg\+xml;charset=utf-8,[^"]*)"/);
    expect(m).toBeTruthy();
    const decoded = decodeURIComponent(m![1].slice("data:image/svg+xml;charset=utf-8,".length));
    expect(decoded).toContain(`fill="#0000ff"`);
    expect(decoded).not.toContain(`#ff0000`);
  });

  it("stroke styles: dasharray scales with the width; dotted boxes gain round caps; solid emits none", () => {
    const svg = exportSvg(
      doc([
        { ...rect("d"), strokeStyle: "dashed" },
        { id: "o", type: "ellipse", stroke: "#e5484d", strokeWidth: 4, x: 200, y: 100, width: 80, height: 40, strokeStyle: "dotted" },
        rect("s", 300, 100),
      ])
    );
    expect(svg).toContain('stroke-dasharray="9 6"'); // dashed at width 3
    expect(svg).toContain('stroke-dasharray="0.00 10"'); // dotted at width 4 (zero-length dash + round cap = dots)
    expect(svg.match(/<ellipse[^>]*stroke-linecap="round"/)).toBeTruthy();
    expect(svg.match(/<rect[^>]*x="300"[^>]*stroke-dasharray/)).toBeNull(); // solid: no dash attr
  });

  it("boxed text exports per wrapped line — the model's own wrap, one <text> per line", () => {
    const svg = exportSvg(
      doc([{ id: "t", type: "text", stroke: "#f5a623", strokeWidth: 3, x: 20, y: 50, text: "aaa bbb ccc", fontSize: 10, width: 40 } as Shape])
    );
    expect(svg).toMatch(/y="60"[^>]*>aaa bbb<\/text>/); // line 1 at y + fontSize
    expect(svg).toMatch(/y="70"[^>]*>ccc<\/text>/); // line 2 one line-height below
    // Explicit newlines stack the same way without a box.
    const free = exportSvg(doc([{ id: "t", type: "text", stroke: "#f5a623", strokeWidth: 3, x: 20, y: 50, text: "one\ntwo", fontSize: 10 } as Shape]));
    expect(free).toMatch(/y="60"[^>]*>one<\/text>/);
    expect(free).toMatch(/y="70"[^>]*>two<\/text>/);
  });

  it("centered caption anchors every line at the block mid-x (text-anchor middle)", () => {
    const svg = exportSvg(
      doc([{ id: "t", type: "text", stroke: "#f5a623", strokeWidth: 3, x: 20, y: 50, text: "aaa bbb ccc", fontSize: 10, width: 40, align: "center" } as Shape])
    );
    // Block mid-x = x + width/2 = 40 — every wrapped line centered there.
    expect(svg).toMatch(/<text x="40"[^>]*text-anchor="middle"[^>]*>aaa bbb<\/text>/);
    expect(svg).toMatch(/<text x="40"[^>]*text-anchor="middle"[^>]*>ccc<\/text>/);
    // A left-aligned text (no align) stays anchored at x with no text-anchor.
    const left = exportSvg(doc([{ id: "t", type: "text", stroke: "#f5a623", strokeWidth: 3, x: 20, y: 50, text: "aaa", fontSize: 10 } as Shape]));
    expect(left).not.toMatch(/text-anchor/);
  });

  it("fills: interior on boxes, closed twin under an enclosed doodle, padded bg chip behind text", () => {
    const shapes: Shape[] = [
      { ...rect("rf"), fill: "#f5a623" } as Shape,
      { id: "e", type: "ellipse", stroke: "#3b82f6", strokeWidth: 3, x: 200, y: 100, width: 80, height: 40, fill: "#30a46c" },
      // Enclosed loop with fill → a strokeless closed fill path + the open stroke path.
      { id: "p", type: "pen", stroke: "#e5484d", strokeWidth: 3, points: [0, 0, 100, 0, 100, 100, 0, 100, 2, 6], fill: "#8267c1" },
      // Open scribble with a stored fill → NO fill path (not enclosed).
      { id: "po", type: "pen", stroke: "#e5484d", strokeWidth: 3, points: [0, 200, 80, 210], fill: "#8267c1" },
      { id: "t", type: "text", stroke: "#3b82f6", strokeWidth: 3, x: 5, y: 200, text: "hi", fontSize: 20, fill: "#e5484d" },
    ];
    const svg = exportSvg(doc(shapes));
    expect(svg).toContain('width="60" height="40" fill="#f5a623"');
    expect(svg).toContain('rx="40" ry="20" fill="#30a46c"');
    expect((svg.match(/fill="#8267c1"/g) ?? []).length).toBe(1); // the enclosed loop only
    expect(svg).toContain('Z" fill="#8267c1" stroke="none"'); // closed twin, strokeless
    // Text bg: padded block (pad = fontSize * 0.15 = 3) with matching corner radius.
    expect(svg).toContain('<rect x="2" y="197"');
    expect(svg).toContain('rx="3" fill="#e5484d"');
  });

  it("contrast ink resolves against the fill beneath: dark on a light fill, bright elsewhere", () => {
    const shapes: Shape[] = [
      { ...rect("bg", 0, 0), width: 200, height: 200, fill: "#f5a623" } as Shape, // light amber ground
      { id: "s1", type: "pen", stroke: "contrast", strokeWidth: 3, points: [50, 50, 150, 150] }, // over the amber
      { id: "s2", type: "pen", stroke: "contrast", strokeWidth: 3, points: [500, 500, 600, 600] }, // bare paper
    ];
    const svg = exportSvg(doc(shapes));
    expect(svg).toContain('d="M 50 50 L 150 150" fill="none" stroke="#111111"');
    expect(svg).toContain('d="M 500 500 L 600 600" fill="none" stroke="#f5f5f5"');
  });

  it("no-stroke exports a literal stroke none — the fill still paints", () => {
    const svg = exportSvg(doc([{ ...rect("r"), stroke: "none", fill: "#f19a9d" } as Shape]));
    expect(svg).toContain('<rect x="100" y="100" width="60" height="40"');
    expect(svg).toMatch(/<rect[^>]*fill="#f19a9d"[^>]*stroke="none"/);
  });

  it("smart ink ignores the shape's OWN backfill — the outline contrasts the surroundings; text keeps its chip", () => {
    // A light-filled box alone on the dark board: ink resolves BRIGHT (the
    // board beneath), not dark against its own amber.
    const own = exportSvg(doc([{ ...rect("r"), stroke: "contrast", fill: "#f5a623" } as Shape]));
    expect(own).toMatch(/<rect[^>]*fill="#f5a623"[^>]*stroke="#f5f5f5"/);
    // The same box sitting on ANOTHER light fill: what's beneath decides → dark.
    const over = exportSvg(
      doc([
        { ...rect("bg", 60, 80), width: 200, height: 120, fill: "#f5a623" } as Shape,
        { ...rect("r"), stroke: "contrast", fill: "#8267c1" } as Shape,
      ])
    );
    expect(over).toMatch(/<rect[^>]*x="100"[^>]*stroke="#111111"/);
    // A big fill drawn LATER can no longer bury the outline — paintOrder sinks
    // filled units beneath unfilled marks — so the amber now really is the
    // outline's backdrop, and its adaptive ink flips DARK to stay readable.
    const covered = exportSvg(
      doc([
        { ...rect("r"), stroke: "contrast" } as Shape,
        { ...rect("lid", 60, 80), width: 200, height: 120, fill: "#f5a623" } as Shape,
      ])
    );
    expect(covered).toMatch(/<rect[^>]*x="100"[^>]*stroke="#111111"/);
    // Text is the carve-out: its fill is the chip BEHIND the glyphs, so the
    // glyphs must keep contrasting with their own chip.
    const t = exportSvg(doc([{ id: "t", type: "text", stroke: "contrast", strokeWidth: 3, x: 5, y: 200, text: "hi", fontSize: 18, fill: "#f5a623" } as Shape]));
    expect(t).toMatch(/<text[^>]*fill="#111111"/);
  });

  it("diamond exports a polygon on the box's edge midpoints; fill/dash ride like any box", () => {
    const svg = exportSvg(
      doc([
        { id: "d", type: "diamond", stroke: "#3b82f6", strokeWidth: 3, x: 100, y: 100, width: 60, height: 40, fill: "#f5a623" } as Shape,
        { id: "dd", type: "diamond", stroke: "#e5484d", strokeWidth: 3, x: 300, y: 100, width: 40, height: 40, strokeStyle: "dashed" } as Shape,
      ])
    );
    expect(svg).toContain('<polygon points="130,100 160,120 130,140 100,120"'); // top→right→bottom→left midpoints
    expect(svg).toMatch(/<polygon[^>]*fill="#f5a623"[^>]*stroke="#3b82f6"/);
    expect(svg).toMatch(/<polygon points="320,100[^>]*stroke-dasharray="9 6"/); // styling applies
  });

  it("rich round-trip: readSvgDoc returns the exact doc; slim has no metadata", () => {
    const d = doc([
      rect("r"),
      { id: "dm", type: "diamond", stroke: "#30a46c", strokeWidth: 3, x: 5, y: 6, width: 30, height: 20 } as Shape,
      { id: "t", type: "text", stroke: "contrast", strokeWidth: 3, x: 1, y: 2, text: 'q"uote', fontSize: 18 } as Shape,
    ]);
    expect(readSvgDoc(exportSvg(d))).toEqual(d);
    const slim = exportSvg(d, { rich: false });
    expect(slim).not.toContain("<metadata");
    expect(readSvgDoc(slim)).toBeNull();
    expect(readSvgDoc("<svg></svg>")).toBeNull();
    expect(readSvgDoc("junk")).toBeNull();
  });
});

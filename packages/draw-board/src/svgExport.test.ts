import { describe, expect, it } from "vitest";
import { exportSvg, readSvgDoc } from "./svgExport.ts";
import type { DrawDoc, Shape } from "./drawModel.ts";

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

  it("labels render: chip on strokes, centered text on areas", () => {
    const shapes: Shape[] = [
      { ...rect("r"), label: "box label" } as Shape,
      { id: "l", type: "line", stroke: "#e5484d", strokeWidth: 3, points: [0, 0, 100, 0], label: "wire" } as Shape,
    ];
    const svg = exportSvg(doc(shapes));
    expect(svg).toContain(">box label</text>");
    expect(svg).toContain(">wire</text>");
    expect(svg).toContain('rx="5" fill="rgba(20,20,24,0.85)"'); // the stroke chip
  });

  it("rich round-trip: readSvgDoc returns the exact doc; slim has no metadata", () => {
    const d = doc([rect("r"), { id: "p", type: "pen", stroke: "contrast", strokeWidth: 3, points: [1, 2, 3, 4], label: 'q"uote' } as Shape]);
    expect(readSvgDoc(exportSvg(d))).toEqual(d);
    const slim = exportSvg(d, { rich: false });
    expect(slim).not.toContain("<metadata");
    expect(readSvgDoc(slim)).toBeNull();
    expect(readSvgDoc("<svg></svg>")).toBeNull();
    expect(readSvgDoc("junk")).toBeNull();
  });
});

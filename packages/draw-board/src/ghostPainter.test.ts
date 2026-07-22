import { describe, it, expect } from "vitest";
import { paintShapeGhosts } from "./ghostPainter.ts";
import type { Shape } from "./drawModel.ts";

/** Recording stub of CanvasRenderingContext2D — logs the painter's draw calls. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = [];
  const target: Record<string | symbol, unknown> = { globalAlpha: 1, strokeStyle: "", fillStyle: "" };
  const ctx = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      return (...args: unknown[]) => {
        calls.push(`${String(key)}(${args.map((a) => (typeof a === "number" ? Math.round(a) : String(a))).join(",")})`);
      };
    },
    set(t, key, v) {
      t[key] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("paintShapeGhosts", () => {
  it("stacks like the board: an image ghost paints FIRST (background) even when drawn last", () => {
    const rect: Shape = { id: "r", type: "rect", stroke: "#e5484d", strokeWidth: 3, x: 10, y: 10, width: 40, height: 30 };
    const image = {
      id: "i",
      type: "image",
      stroke: "#000",
      strokeWidth: 1,
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      dataBase64: "",
      mediaType: "image/png",
    } as Shape;
    const { ctx, calls } = recordingCtx();
    paintShapeGhosts(ctx, [rect, image]); // image drawn AFTER the rect…
    const imageWash = calls.indexOf("fillRect(0,0,100,80)");
    const rectStroke = calls.indexOf("strokeRect(10,10,40,30)");
    expect(imageWash).toBeGreaterThanOrEqual(0);
    expect(rectStroke).toBeGreaterThan(imageWash); // …but ghosts below it, like the canvas and the SVG export
  });
});

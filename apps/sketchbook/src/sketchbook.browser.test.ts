/**
 * Real-browser e2e for the Sketchbook app — the whole user story against the
 * actual vite-served app (real DrawEditor, real localStorage):
 *  - opens with one auto-created "Untitled" drawing and a live board;
 *  - + creates a drawing already in rename mode; typing a name commits it;
 *  - double-click renames an existing drawing (Enter commits, Esc cancels);
 *  - strokes persist per drawing through the board's debounced onChange and
 *    survive a full page reload;
 *  - switching drawings remounts the board on the right doc.
 *
 * Same vite-in-playwright pattern as apps/web's drawViewport suite (see the
 * four setup laws documented there: inline tailwind, no watch/HMR, dep warmup,
 * and the board theme fed explicitly so ink/accent utilities exist).
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { readBoardDocFromPngBytes, readSvgDoc } from "@operator/draw-board";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardColors } from "@operator/draw-board/theme";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_SRC = path.resolve(APP_ROOT, "../../packages/draw-board/src");
const PORT = 25200 + (process.pid % 1000);

let server: ViteDevServer;

test.beforeAll(async ({ browser }) => {
  server = await createServer({
    root: APP_ROOT,
    configFile: false,
    plugins: [react()],
    logLevel: "silent",
    css: {
      postcss: {
        plugins: [
          tailwindcss({
            content: [`${APP_ROOT}/index.html`, `${APP_ROOT}/src/**/*.{ts,tsx}`, `${PKG_SRC}/**/*.{ts,tsx}`],
            theme: { extend: { colors: boardColors } },
          }),
        ],
      },
    },
    optimizeDeps: { include: ["react", "react-dom/client", "konva", "react-konva", "lucide-react"] },
    server: { host: "127.0.0.1", port: PORT, strictPort: true, watch: null, hmr: false },
  });
  await server.listen();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".konvajs-content canvas", { timeout: 60_000 });
  await page.waitForTimeout(2000); // let dep discovery + its reload settle here
  await page.close();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page) {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".konvajs-content canvas");
}

/** The persisted drawings list, straight from the app's localStorage. */
const stored = (page: Page) =>
  page.evaluate(() => JSON.parse(window.localStorage.getItem("sketchbook:drawings") ?? "[]") as { name: string; doc: { shapes: unknown[] } }[]);

async function drawStroke(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const box = (await page.locator(".konvajs-content canvas").first().boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 5 });
  await page.mouse.up();
}

type SeedShape = Record<string, unknown>;
const rect = (id: string, x: number, y: number, width = 80, height = 60, over: SeedShape = {}): SeedShape => ({
  id,
  type: "rect",
  stroke: "#e5484d",
  strokeWidth: 3,
  x,
  y,
  width,
  height,
  ...over,
});

/** Boot the app on a seeded single-drawing store (precise geometry beats
 *  fragile mouse-drawing for glue/scale assertions). */
async function openSeeded(page: Page, shapes: SeedShape[]) {
  await page.addInitScript((list: SeedShape[]) => {
    window.localStorage.setItem(
      "sketchbook:drawings",
      JSON.stringify([{ id: "seeded", name: "Seeded", doc: { shapes: list, width: 800, height: 600 }, createdAt: 1 }])
    );
  }, shapes);
  await open(page);
  // Select tool (the board opens in pen — a stray drag must not ink).
  await page.getByRole("button", { name: "Cursor — select / move (Tab)" }).click();
}

test("the full story: open → create+name → rename → draw → reload persists → switch isolates docs", async ({ page }) => {
  await open(page);

  // Fresh storage: one auto-created page, and the board is live.
  await expect(page.getByRole("button", { name: "Untitled", exact: true })).toBeVisible();

  // + creates a drawing already in rename mode; typing commits the name.
  await page.getByRole("button", { name: "New drawing" }).click();
  const renameInput = page.getByRole("textbox", { name: /Rename Untitled 2/ });
  await expect(renameInput).toBeFocused();
  await renameInput.fill("My Plan");
  await renameInput.press("Enter");
  await expect(page.getByRole("button", { name: "My Plan" })).toBeVisible();

  // Double-click renames an existing drawing; Escape cancels, Enter commits.
  await page.getByRole("button", { name: "Untitled", exact: true }).dblclick();
  const rename2 = page.getByRole("textbox", { name: /Rename Untitled/ });
  await rename2.fill("Scrapped");
  await rename2.press("Escape");
  await expect(page.getByRole("button", { name: "Untitled", exact: true })).toBeVisible(); // cancel kept the old name
  await page.getByRole("button", { name: "Untitled", exact: true }).dblclick();
  const rename3 = page.getByRole("textbox", { name: /Rename Untitled/ });
  await rename3.fill("First");
  await rename3.press("Enter");
  await expect(page.getByRole("button", { name: "First" })).toBeVisible();

  // Select My Plan (the dblclick-rename above also single-click-selected First)
  // and draw; the debounced persist lands in ITS doc.
  await page.getByRole("button", { name: "My Plan" }).click();
  await drawStroke(page, { x: 150, y: 150 }, { x: 320, y: 260 });
  await expect
    .poll(async () => (await stored(page)).find((d) => d.name === "My Plan")?.doc.shapes.length ?? 0)
    .toBeGreaterThan(0);

  // Reload: names and ink survive.
  await page.reload();
  await page.waitForSelector(".konvajs-content canvas");
  await expect(page.getByRole("button", { name: "First" })).toBeVisible();
  await expect(page.getByRole("button", { name: "My Plan" })).toBeVisible();
  const persisted = await stored(page);
  expect(persisted.find((d) => d.name === "My Plan")!.doc.shapes.length).toBeGreaterThan(0);
  expect(persisted.find((d) => d.name === "First")!.doc.shapes.length).toBe(0);

  // Switch to First and draw — the stroke lands in ITS doc, not My Plan's.
  await page.getByRole("button", { name: "First" }).click();
  await drawStroke(page, { x: 100, y: 100 }, { x: 200, y: 180 });
  await expect
    .poll(async () => (await stored(page)).find((d) => d.name === "First")?.doc.shapes.length ?? 0)
    .toBeGreaterThan(0);
  const final = await stored(page);
  expect(final.find((d) => d.name === "My Plan")!.doc.shapes.length).toBe(1); // untouched
});

test("stroke styles: 4 cycles solid→dashed→dotted, ink carries the style to persistence, selection restyles via the toolbar, SVG export emits the dash", async ({ page }) => {
  await open(page);
  // Focus lands inside the board root via a toolbar click (no stray ink).
  await page.getByRole("button", { name: "Cursor — select / move (Tab)" }).click();

  // 4 → dashed (from the default solid); the swatch well follows.
  await page.keyboard.press("4");
  await expect(page.getByRole("button", { name: "Dashed stroke (4)" })).toHaveAttribute("aria-pressed", "true");

  // Ink drawn now carries the armed style.
  await page.getByRole("button", { name: "Pen — draw freehand (Tab)" }).click();
  await drawStroke(page, { x: 150, y: 150 }, { x: 300, y: 240 });
  await expect.poll(async () => (await stored(page))[0]?.doc.shapes.length ?? 0).toBe(1);
  expect(((await stored(page))[0].doc.shapes[0] as { strokeStyle?: string }).strokeStyle).toBe("dashed");

  // Select the stroke; a toolbar swatch restyles the SELECTION (undoably).
  await page.getByRole("button", { name: "Cursor — select / move (Tab)" }).click();
  await page.locator(".konvajs-content").click({ position: { x: 225, y: 195 } });
  await page.getByRole("button", { name: "Dotted stroke (4)" }).click();
  await expect
    .poll(async () => ((await stored(page))[0].doc.shapes[0] as { strokeStyle?: string }).strokeStyle)
    .toBe("dotted");

  // …and the style flows through the SVG export (zero-length dash = dots).
  await page.getByRole("button", { name: "More export options" }).click();
  const downloadP = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download as SVG" }).click();
  const text = fs.readFileSync((await (await downloadP).path())!, "utf8");
  expect(text).toContain("stroke-dasharray");
});

test("a pen TAP (no drag) leaves a visible dot: committed, persisted, inked in the export", async ({ page }) => {
  await open(page);
  // The board opens in pen — this bare click IS the tap under test.
  await page.locator(".konvajs-content").click({ position: { x: 300, y: 220 } });
  await expect.poll(async () => (await stored(page))[0]?.doc.shapes.length ?? 0).toBe(1);
  const dot = (await stored(page))[0].doc.shapes[0] as { type: string; points: number[] };
  expect(dot.type).toBe("pen");
  // Committed as the epsilon segment (round caps inflate it to a stroke-width dot).
  expect(dot.points).toHaveLength(4);
  expect(Math.abs(dot.points[2] - dot.points[0])).toBeLessThan(0.01);

  // And it actually MARKS: the export (content +30 pad at 2× → the dot sits at
  // the raster's center) carries bright ink there, dark board at the corner.
  const downloadP = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download as PNG" }).click();
  const bytes = fs.readFileSync((await (await downloadP).path())!);
  const px = await page.evaluate(async (b64: string) => {
    const im = new Image();
    await new Promise((res, rej) => {
      im.onload = res;
      im.onerror = rej;
      im.src = `data:image/png;base64,${b64}`;
    });
    const c = document.createElement("canvas");
    c.width = im.width;
    c.height = im.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(im, 0, 0);
    const mid = ctx.getImageData(Math.round(im.width / 2), Math.round(im.height / 2), 1, 1).data;
    const corner = ctx.getImageData(2, 2, 1, 1).data;
    return { mid: Math.max(mid[0], mid[1], mid[2]), corner: Math.max(corner[0], corner[1], corner[2]) };
  }, bytes.toString("base64"));
  expect(px.mid).toBeGreaterThan(150); // the dot's ink (contrast ink → bright on the dark ground)
  expect(px.corner).toBeLessThan(60); // board background, not ink
});

test("typography: text typed in a shape wraps at its edge (stored as a box), center-anchors, and rides the parent's resize", async ({ page }) => {
  await openSeeded(page, [rect("r1", 100, 100, 360, 220)]); // right edge 460, bottom 320
  const box = (await page.locator(".konvajs-content").boundingBox())!;
  const toScreen = async (pt: { x: number; y: number }) => {
    const cam = await page.evaluate(() => {
      const s = (window as unknown as { Konva: { stages: { x(): number; y(): number; scaleX(): number }[] } }).Konva.stages.at(-1)!;
      return { x: s.x(), y: s.y(), scale: s.scaleX() };
    });
    return { x: box.x + cam.x + pt.x * cam.scale, y: box.y + cam.y + pt.y * cam.scale };
  };

  // Text tool → click well inside the rect (clear of every edge) → type a
  // sentence far wider than the room to the rect's right edge.
  await page.getByRole("button", { name: "Text (3)" }).click();
  const at = await toScreen({ x: 150, y: 160 });
  await page.mouse.click(at.x, at.y);
  const source = "the quick brown fox jumps over the lazy dog near the fence";
  await page.keyboard.type(source);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await stored(page))[0]?.doc.shapes.length ?? 0).toBe(2);
  type StoredText = { type: string; x: number; y: number; text: string; width?: number; attach?: { id: string; ax: number; ay: number } };
  const before = ((await stored(page))[0].doc.shapes as StoredText[]).find((sh) => sh.type === "text")!;
  expect(before.text).toBe(source); // the SOURCE stays unwrapped — lines derive
  expect(before.width).toBeCloseTo(460 - 150 - 6, 0); // wrap box = room to the parent's right edge (minus inset)
  expect(before.attach).toMatchObject({ id: "r1", ax: 0.5, ay: 0.5 }); // placed mid-shape → center bond

  // A selected text offers ONLY the horizontal side handles — they resize the
  // wrap box; type size lives in the size control, so corners/verticals are gone.
  const onText = await toScreen({ x: 160, y: 170 });
  await page.mouse.click(onText.x, onText.y);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as { Konva: { stages: { find(sel: string): { enabledAnchors(): string[] }[] }[] } }).Konva.stages.at(-1)!;
        return s.find("Transformer")[0]?.enabledAnchors() ?? [];
      })
    )
    .toEqual(["middle-left", "middle-right"]);

  // Stretch the rect 100px wider by its middle-right anchor: the caption keeps
  // its offset from the parent's CENTER → it slides +50 with it.
  const inRect = await toScreen({ x: 120, y: 300 }); // inside the rect, clear of the text block
  await page.mouse.click(inRect.x, inRect.y);
  const handle = await toScreen({ x: 460, y: 210 });
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 8, handle.y); // arm the transform
  const target = await toScreen({ x: 560, y: 210 });
  await page.mouse.move(target.x, target.y);
  await page.mouse.up();
  await expect
    .poll(async () => (((await stored(page))[0].doc.shapes as StoredText[]).find((sh) => sh.type === "text")!.x - before.x))
    .toBeCloseTo(50, 0);

  // The SVG export carries the wrap: one <text> per rendered line.
  await page.getByRole("button", { name: "More export options" }).click();
  const downloadP = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download as SVG" }).click();
  const svg = fs.readFileSync((await (await downloadP).path())!, "utf8");
  const lines = [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  expect(lines.length).toBeGreaterThan(1); // it wrapped
  expect(lines.join(" ").replace(/\s+/g, " ")).toContain("lazy dog"); // …into the source's words
});

test("text editing is WYSIWYG: the field always contains every line it commits (no clip, no scroll window)", async ({ page }) => {
  const source = "the quick brown fox jumps over the lazy dog near the fence";
  await openSeeded(page, [
    { id: "tb", type: "text", stroke: "#e5484d", strokeWidth: 3, x: 60, y: 80, text: source, fontSize: 18, width: 150 },
    { id: "tf", type: "text", stroke: "#3b82f6", strokeWidth: 3, x: 60, y: 400, text: source, fontSize: 18 },
  ]);
  const box = (await page.locator(".konvajs-content").boundingBox())!;
  const toScreen = async (pt: { x: number; y: number }) => {
    const cam = await page.evaluate(() => {
      const s = (window as unknown as { Konva: { stages: { x(): number; y(): number; scaleX(): number }[] } }).Konva.stages.at(-1)!;
      return { x: s.x(), y: s.y(), scale: s.scaleX() };
    });
    return { x: box.x + cam.x + pt.x * cam.scale, y: box.y + cam.y + pt.y * cam.scale };
  };
  const fits = () =>
    page.evaluate(() => {
      const ta = document.querySelector(".draw-text-input") as HTMLTextAreaElement;
      return { w: ta.scrollWidth - ta.clientWidth, h: ta.scrollHeight - ta.clientHeight, cw: ta.clientWidth };
    });
  // A boxed text wrapping to several lines: the field is the WHOLE block —
  // not a browser-default 2-row window scrolled to the caret.
  const onBoxed = await toScreen({ x: 70, y: 88 });
  await page.mouse.dblclick(onBoxed.x, onBoxed.y);
  await page.waitForSelector(".draw-text-input");
  let m = await fits();
  expect(m.h).toBeLessThanOrEqual(1); // every wrapped line visible
  expect(m.cw).toBe(150); // capped: the wrap box IS the field width
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700); // outlive the far-apart dblclick suppression
  // A free one-line text: the field spans the whole line (no horizontal
  // clipping) and keeps growing as more is typed.
  const onFree = await toScreen({ x: 70, y: 408 });
  await page.mouse.dblclick(onFree.x, onFree.y);
  await page.waitForSelector(".draw-text-input");
  m = await fits();
  expect(m.w).toBeLessThanOrEqual(1);
  expect(m.h).toBeLessThanOrEqual(1);
  await page.keyboard.press("End");
  await page.keyboard.type(" and then some more words");
  m = await fits();
  expect(m.w).toBeLessThanOrEqual(1); // grew with the typing
});

test("text width-resize reflows LIVE (glyphs unscaled), and the side-handle pair survives re-renders", async ({ page }) => {
  const source = "the quick brown fox jumps over the lazy dog near the fence";
  await openSeeded(page, [{ id: "t1", type: "text", stroke: "#e5484d", strokeWidth: 3, x: 100, y: 100, text: source, fontSize: 18, width: 150 }]);
  const box = (await page.locator(".konvajs-content").boundingBox())!;
  const cam = await page.evaluate(() => {
    const s = (window as unknown as { Konva: { stages: { x(): number; y(): number; scaleX(): number }[] } }).Konva.stages.at(-1)!;
    return { x: s.x(), y: s.y(), scale: s.scaleX() };
  });
  const toScreen = (pt: { x: number; y: number }) => ({ x: box.x + cam.x + pt.x * cam.scale, y: box.y + cam.y + pt.y * cam.scale });
  const anchors = () =>
    page.evaluate(() => {
      const s = (window as unknown as { Konva: { stages: { find(sel: string): { enabledAnchors(): string[] }[] }[] } }).Konva.stages.at(-1)!;
      return s.find("Transformer")[0]?.enabledAnchors() ?? [];
    });
  const textNode = () =>
    page.evaluate(() => {
      const s = (window as unknown as { Konva: { stages: { findOne(sel: string): { scaleX(): number; text(): string; width(): number } }[] } }).Konva.stages.at(-1)!;
      const n = s.findOne("#t1");
      return { scaleX: n.scaleX(), lines: n.text().split("\n").length, width: n.width() };
    });

  // Select the text — the side-handle pair appears.
  const on = toScreen({ x: 110, y: 110 });
  await page.mouse.click(on.x, on.y);
  await expect.poll(anchors).toEqual(["middle-left", "middle-right"]);
  const before = await textNode();
  expect(before.lines).toBeGreaterThan(2); // wrapped tight at 150 — room to unwrap

  // Grab the middle-right handle where the Transformer actually drew it and
  // drag +130. DURING the drag the glyphs must stay unscaled and the model's
  // wrap must re-run at the dragged width — not stretch-until-release.
  const grab = await page.evaluate(() => {
    const s = (window as unknown as { Konva: { stages: { findOne(sel: string): { getAbsolutePosition(): { x: number; y: number } } }[] } }).Konva.stages.at(-1)!;
    return s.findOne(".middle-right").getAbsolutePosition();
  });
  await page.mouse.move(box.x + grab.x, box.y + grab.y);
  await page.mouse.down();
  await page.mouse.move(box.x + grab.x + 30, box.y + grab.y); // arm the transform
  await page.mouse.move(box.x + grab.x + 130, box.y + grab.y, { steps: 4 });
  const mid = await textNode();
  await page.mouse.up();
  expect(mid.scaleX).toBeCloseTo(1, 2); // never a stretched frame
  expect(mid.lines).toBeLessThan(before.lines); // the wrap re-ran live — wider box, fewer lines
  const expected = before.width + 130 / cam.scale; // the dragged edge tracked the pointer
  expect(Math.abs(mid.width - expected)).toBeLessThanOrEqual(5);

  // The commit is exactly the width the drag showed (WYSIWYG hand-off).
  await expect
    .poll(async () => ((await stored(page))[0].doc.shapes as { id: string; width?: number }[]).find((sh) => sh.id === "t1")!.width!)
    .toBeCloseTo(mid.width, 0);
  expect((await textNode()).lines).toBe(mid.lines);

  // An unrelated re-render (a camera scroll commits one) must NOT resurrect
  // the corner/vertical handles on the still-selected text.
  const camY = () => page.evaluate(() => (window as unknown as { Konva: { stages: { y(): number }[] } }).Konva.stages.at(-1)!.y());
  const y0 = await camY();
  await page.mouse.wheel(0, 120);
  await expect.poll(camY).not.toBe(y0);
  await page.waitForTimeout(300); // let the trailing camera-state renders land
  expect(await anchors()).toEqual(["middle-left", "middle-right"]);
});

test("glue preview is bond-specific: the pinned edge lights up, an ellipse arcs, an endpoint bind frames the body, containment stays silent", async ({ page }) => {
  await openSeeded(page, [
    rect("A", 100, 100, 120, 80), // edge target — right edge x=220, v-center 140
    { id: "E", type: "ellipse", stroke: "#e5484d", strokeWidth: 3, x: 400, y: 100, width: 120, height: 80 }, // arc target
    rect("C", 100, 300, 300, 200), // container for the text drop
    rect("D", 300, 125, 40, 30), // the dragged probe (v-centered on A)
    { id: "T", type: "text", stroke: "#e5484d", strokeWidth: 3, x: 600, y: 400, text: "cap", fontSize: 18 },
  ]);
  const box = (await page.locator(".konvajs-content").boundingBox())!;
  const cam = await page.evaluate(() => {
    const s = (window as unknown as { Konva: { stages: { x(): number; y(): number; scaleX(): number }[] } }).Konva.stages.at(-1)!;
    return { x: s.x(), y: s.y(), scale: s.scaleX() };
  });
  const toScreen = (pt: { x: number; y: number }) => ({ x: box.x + cam.x + pt.x * cam.scale, y: box.y + cam.y + pt.y * cam.scale });
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const a = toScreen(from);
    const b = toScreen(to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
  };
  /** The live glue chrome, by kind: edge/arc polyline points, body frame widths. */
  const glue = () =>
    page.evaluate(() => {
      const s = (window as unknown as { Konva: { stages: { find(sel: string): { points?(): number[]; width?(): number }[] }[] } }).Konva.stages.at(-1)!;
      return {
        edge: s.find(".glue-edge").map((n) => n.points!()),
        arc: s.find(".glue-arc").map((n) => n.points!()),
        body: s.find(".glue-body").map((n) => n.width!()),
      };
    });

  // Dragging D against A's RIGHT edge lights ONLY that edge — a vertical
  // segment hugging x=220 — never the whole frame.
  await drag({ x: 320, y: 140 }, { x: 250, y: 140 }); // D.x 300 → 230, left edge 10px off A's right
  await expect.poll(async () => (await glue()).edge.length).toBe(1);
  let g = await glue();
  expect(g.body.length + g.arc.length).toBe(0);
  expect(g.edge[0]).toHaveLength(4); // one edge, not a corner polyline
  expect(g.edge[0][0]).toBeCloseTo(g.edge[0][2], 5); // vertical
  expect(Math.abs(g.edge[0][0] - 220)).toBeLessThanOrEqual(8); // hugging A's right edge (+ screen pad)
  await page.mouse.up(); // D glues to A

  // Dragging D against the ELLIPSE arcs its border around the bond angle
  // (leftmost point ≈ (400, 140) for an approach from the left).
  await drag({ x: 250, y: 140 }, { x: 375, y: 140 }); // D.x 230 → 355, right edge 5px off E's left
  await expect.poll(async () => (await glue()).arc.length).toBe(1);
  g = await glue();
  expect(g.edge.length).toBe(0);
  const arc = g.arc[0];
  expect(Math.abs(arc[24] - 400)).toBeLessThanOrEqual(8); // arc midpoint at the bond spot…
  expect(Math.abs(arc[25] - 140)).toBeLessThanOrEqual(2); // …on the horizontal axis
  await page.mouse.up(); // D re-glues to E, radially

  // Dragging the TEXT into the container's middle bonds by CONTAINMENT — the
  // bond is real (persisted on drop) but the chrome stays SILENT: the text is
  // visibly inside, nothing to announce.
  await drag({ x: 614, y: 409 }, { x: 250, y: 400 }); // T's center → C's center, ≥24px from every edge
  await expect.poll(async () => {
    const q = await glue();
    return q.edge.length + q.arc.length + q.body.length;
  }).toBe(0);
  await page.mouse.up();
  await expect
    .poll(async () => ((await stored(page))[0].doc.shapes as { id: string; attach?: { id: string; ax?: number } }[]).find((sh) => sh.id === "T")?.attach)
    .toMatchObject({ id: "C", ax: 0.5, ay: 0.5 });

  // A line ENDPOINT binds to the BODY (anywhere inside) — the whole frame
  // glows, not an edge. Deselect first so the digit arms the tool cleanly.
  const empty = toScreen({ x: 700, y: 550 });
  await page.mouse.click(empty.x, empty.y);
  await page.keyboard.press("2"); // arm the connector cluster (line)
  await drag({ x: 560, y: 250 }, { x: 150, y: 140 }); // draw a line into A's interior
  await expect.poll(async () => (await glue()).body.length).toBe(1);
  g = await glue();
  expect(g.edge.length).toBe(0);
  expect(Math.abs(g.body[0] - 120)).toBeLessThanOrEqual(12); // frames A's whole box (+ pads)
  await page.mouse.up();

  // Hovering with the RECT tool near a border previews the edge it would pin
  // to; the deep interior is mere containment — silent.
  await page.keyboard.press("1"); // arm the shape cluster (rect)
  const nearEdge = toScreen({ x: 215, y: 140 }); // 5px inside A's right edge
  await page.mouse.move(nearEdge.x, nearEdge.y);
  await expect.poll(async () => (await glue()).edge.length).toBe(1);
  g = await glue();
  expect(g.edge[0][0]).toBeCloseTo(g.edge[0][2], 5); // the right edge again
  expect(Math.abs(g.edge[0][0] - 220)).toBeLessThanOrEqual(8);
  const center = toScreen({ x: 160, y: 140 }); // A's middle — every edge ≥ 40px away
  await page.mouse.move(center.x, center.y);
  await expect.poll(async () => {
    const q = await glue();
    return q.edge.length + q.arc.length + q.body.length;
  }).toBe(0);
});

test("dblclick on a shape spawns a FREE caption inside it — or engages the existing one, never a duplicate", async ({ page }) => {
  await openSeeded(page, [rect("R", 100, 100, 200, 120)]);
  const box = (await page.locator(".konvajs-content").boundingBox())!;
  const cam = await page.evaluate(() => {
    const s = (window as unknown as { Konva: { stages: { x(): number; y(): number; scaleX(): number }[] } }).Konva.stages.at(-1)!;
    return { x: s.x(), y: s.y(), scale: s.scaleX() };
  });
  const toScreen = (pt: { x: number; y: number }) => ({ x: box.x + cam.x + pt.x * cam.scale, y: box.y + cam.y + pt.y * cam.scale });
  type StoredShape = { id: string; type: string; text?: string; x?: number; attach?: { id: string; ax?: number; ay?: number } };
  const shapesStored = async () => (await stored(page))[0].doc.shapes as StoredShape[];

  // Dblclick the empty container: a caption session opens at the click point;
  // typing + Enter mints a FREE text shape bonded by containment — not text
  // baked into the rect.
  const at = toScreen({ x: 200, y: 160 });
  await page.mouse.dblclick(at.x, at.y);
  await page.waitForSelector(".draw-text-input");
  await page.keyboard.type("cap");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await shapesStored()).length).toBe(2);
  const t1 = (await shapesStored()).find((s) => s.type === "text")!;
  expect(t1.text).toBe("cap");
  expect(t1.x).toBeCloseTo(200, 0); // spawned where the dblclick aimed
  expect(t1.attach).toMatchObject({ id: "R", ax: 0.5, ay: 0.5 }); // a bond, not a baked-in label

  // Dblclick elsewhere INSIDE the shape (clear of the caption's block): the
  // EXISTING caption's editor opens preloaded — engaged, not duplicated.
  await page.waitForTimeout(700); // outlive the far-apart dblclick suppression
  const off = toScreen({ x: 130, y: 205 });
  await page.mouse.dblclick(off.x, off.y);
  await page.waitForSelector(".draw-text-input");
  expect(await page.inputValue(".draw-text-input")).toBe("cap");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await shapesStored()).find((s) => s.type === "text")?.text).toBe("hello");
  expect((await shapesStored()).length).toBe(2); // still ONE caption

  // Dblclick on empty canvas still does nothing.
  await page.waitForTimeout(700);
  const empty = toScreen({ x: 600, y: 500 });
  await page.mouse.dblclick(empty.x, empty.y);
  await page.waitForTimeout(200);
  await expect(page.locator(".draw-text-input")).toHaveCount(0);
});

test.describe("rich exports + import drop surfaces", () => {
  /** Drop a file (bytes given as base64) onto a selector via a synthetic DragEvent. */
  async function dropFile(page: Page, selector: string, b64: string, name: string, type: string) {
    await page.evaluate(
      ([sel, data, fname, ftype]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], fname, { type: ftype }));
        const el = document.querySelector(sel)!;
        el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
        el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      [selector, b64, name, type] as const
    );
  }

  test("download rich PNG → doc embedded → re-imports as a board from EITHER drop surface; plain image over the list becomes a background page", async ({ page }) => {
    await open(page);
    await drawStroke(page, { x: 140, y: 140 }, { x: 300, y: 240 });
    await expect.poll(async () => (await stored(page)).find((d) => d.name === "Untitled")?.doc.shapes.length ?? 0).toBeGreaterThan(0);

    // Download the rich PNG and verify the embedded doc offline.
    const downloadP = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download as PNG" }).click();
    const download = await downloadP;
    const path = await download.path();
    const bytes = fs.readFileSync(path!);
    const embedded = readBoardDocFromPngBytes(new Uint8Array(bytes));
    expect(embedded?.shapes.length).toBe(1);
    expect((embedded!.shapes[0] as { type: string }).type).toBe("pen");
    const b64 = bytes.toString("base64");

    // Drop the rich PNG over the LIST → imports as a new board (not an image page).
    await dropFile(page, "nav", b64, "untitled.png", "image/png");
    await expect(page.getByRole("button", { name: "untitled", exact: true })).toBeVisible();
    await expect
      .poll(async () => (await stored(page)).find((d) => d.name === "untitled")?.doc.shapes.length ?? 0)
      .toBe(1); // full board recreation, background-free

    // Drop the SAME rich PNG over the BOARD → still imports as a board (board
    // files always win), never as a placed image shape.
    const before = (await stored(page)).length;
    await dropFile(page, ".konvajs-content", b64, "untitled.png", "image/png");
    await expect.poll(async () => (await stored(page)).length).toBe(before + 1);
    const all = await stored(page);
    // No drawing gained an image shape from that drop.
    expect(all.every((d) => !d.doc.shapes.some((sh) => (sh as { type: string }).type === "image"))).toBe(true);

    // A PLAIN image dropped over the list becomes a new page with a background.
    const plainB64 = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 80;
      c.height = 50;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(0, 0, 80, 50);
      return c.toDataURL("image/png").split(",")[1];
    });
    await dropFile(page, "nav", plainB64, "photo.png", "image/png");
    await expect(page.getByRole("button", { name: "photo" })).toBeVisible();
    const withBg = (await stored(page)).find((d) => d.name === "photo") as { doc: { background?: unknown } } | undefined;
    expect(withBg?.doc.background).toBeTruthy();
  });

  test("hovering a sidebar row shows the preview popover", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Untitled", exact: true }).hover();
    await expect(page.locator("[data-row-preview]")).toBeVisible();
    await expect(page.locator("[data-row-preview]")).toContainText("Untitled");
    await page.mouse.move(10, 400); // leave the row
    await expect(page.locator("[data-row-preview]")).toHaveCount(0);
  });
});

test.describe("round-trips: SVG, paste, slim, clipboard copy", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  /** Paste a file (bytes as base64) onto the focused board via a synthetic
   *  ClipboardEvent — the PASTE interception path, distinct from drop. */
  const pasteFile = (page: Page, b64: string, type: string) =>
    page.evaluate(
      ([data, ftype]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "clip.png", { type: ftype }));
        (document.activeElement ?? document.body).dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
        );
      },
      [b64, type] as const
    );

  test("SVG: download rich → embedded doc verifies → dropping the .svg imports the board", async ({ page }) => {
    await open(page);
    await drawStroke(page, { x: 120, y: 120 }, { x: 280, y: 220 });
    await expect.poll(async () => (await stored(page))[0]?.doc.shapes.length ?? 0).toBeGreaterThan(0);
    await page.getByRole("button", { name: "More export options" }).click();
    const downloadP = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download as SVG" }).click();
    const file = await downloadP;
    const text = fs.readFileSync((await file.path())!, "utf8");
    const embedded = readSvgDoc(text);
    expect(embedded?.shapes.length).toBe(1);
    // Re-import the SVG through the LIST drop surface.
    const b64 = Buffer.from(text, "utf8").toString("base64");
    await page.evaluate(
      ([data]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "untitled.svg", { type: "image/svg+xml" }));
        const el = document.querySelector("nav")!;
        el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      [b64] as const
    );
    await expect(page.getByRole("button", { name: "untitled", exact: true })).toBeVisible();
    await expect.poll(async () => (await stored(page)).find((d) => d.name === "untitled")?.doc.shapes.length ?? 0).toBe(1);
  });

  test("PASTE of a rich PNG onto the board imports it as a board (not a placed image)", async ({ page }) => {
    await open(page);
    await drawStroke(page, { x: 140, y: 140 }, { x: 260, y: 200 });
    await expect.poll(async () => (await stored(page))[0]?.doc.shapes.length ?? 0).toBeGreaterThan(0);
    const downloadP = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download as PNG" }).click();
    const bytes = fs.readFileSync((await (await downloadP).path())!);
    const before = (await stored(page)).length;
    // Focus the board, paste the rich file.
    await page.locator(".konvajs-content").click({ position: { x: 400, y: 350 } });
    await pasteFile(page, bytes.toString("base64"), "image/png");
    await expect.poll(async () => (await stored(page)).length).toBe(before + 1);
    const all = await stored(page);
    expect(all.every((d) => !d.doc.shapes.some((sh) => (sh as { type: string }).type === "image"))).toBe(true);
  });

  test("SLIM exports carry no doc: the file demotes to a plain image on both surfaces", async ({ page }) => {
    await open(page);
    await drawStroke(page, { x: 140, y: 140 }, { x: 260, y: 200 });
    await expect.poll(async () => (await stored(page))[0]?.doc.shapes.length ?? 0).toBeGreaterThan(0);
    await page.getByRole("button", { name: "More export options" }).click();
    const downloadP = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PNG — slim" }).click();
    const bytes = fs.readFileSync((await (await downloadP).path())!);
    expect(readBoardDocFromPngBytes(new Uint8Array(bytes))).toBeNull(); // metadata-free
    const b64 = bytes.toString("base64");
    // Over the BOARD → an on-board image SHAPE on the active drawing.
    await page.locator(".konvajs-content").click({ position: { x: 400, y: 350 } });
    await pasteFile(page, b64, "image/png");
    await expect
      .poll(async () => (await stored(page))[0]?.doc.shapes.filter((sh) => (sh as { type: string }).type === "image").length ?? 0)
      .toBe(1);
    // Over the LIST → a new page with the image as BACKGROUND.
    const before = (await stored(page)).length;
    await page.evaluate(
      ([data]) => {
        const b = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([b], "flat.png", { type: "image/png" }));
        document.querySelector("nav")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      [b64] as const
    );
    await expect.poll(async () => (await stored(page)).length).toBe(before + 1);
    const page2 = (await stored(page)).find((d) => d.name === "flat") as { doc: { background?: unknown; shapes: unknown[] } } | undefined;
    expect(page2?.doc.background).toBeTruthy();
    expect(page2?.doc.shapes).toHaveLength(0);
  });

  test("a drawing made fully ON a placed image exports as JUST the image — no padded border", async ({ page }) => {
    await open(page);
    // Select tool first: the board opens in pen, and the focus click must not ink.
    await page.getByRole("button", { name: "Cursor — select / move (Tab)" }).click();
    // Paste a solid-blue plain PNG over the board → a placed image shape.
    const blueB64 = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 300;
      c.height = 200;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#0037ff";
      ctx.fillRect(0, 0, 300, 200);
      return c.toDataURL("image/png").split(",")[1];
    });
    await page.locator(".konvajs-content").click({ position: { x: 400, y: 300 } });
    await pasteFile(page, blueB64, "image/png");
    await expect.poll(async () => (await stored(page))[0]?.doc.shapes.length ?? 0).toBe(1);
    const img = (await stored(page))[0].doc.shapes[0] as { x: number; y: number; width: number; height: number };
    // Ink fully INSIDE the image — mapped through the live camera, wherever the
    // paste placed it.
    const cam = await page.evaluate(() => {
      const s = (window as unknown as { Konva: { stages: { x(): number; y(): number; scaleX(): number }[] } }).Konva.stages.at(-1)!;
      return { x: s.x(), y: s.y(), scale: s.scaleX() };
    });
    const toScreen = (p: { x: number; y: number }) => ({ x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y });
    await page.getByRole("button", { name: "Pen — draw freehand (Tab)" }).click();
    await drawStroke(page, toScreen({ x: img.x + 40, y: img.y + 40 }), toScreen({ x: img.x + img.width - 40, y: img.y + img.height - 40 }));
    await expect.poll(async () => (await stored(page))[0]?.doc.shapes.length ?? 0).toBe(2);

    const downloadP = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download as PNG" }).click();
    const bytes = fs.readFileSync((await (await downloadP).path())!);
    // IHDR dims: exactly the image box × exportScale(2) — no +30 pad anywhere.
    expect(bytes.readUInt32BE(16)).toBe(Math.round(img.width * 2));
    expect(bytes.readUInt32BE(20)).toBe(Math.round(img.height * 2));
    // And the export's corner pixel IS the image (blue), not board background.
    const corner = await page.evaluate(async (b64: string) => {
      const im = new Image();
      await new Promise((res, rej) => {
        im.onload = res;
        im.onerror = rej;
        im.src = `data:image/png;base64,${b64}`;
      });
      const c = document.createElement("canvas");
      c.width = im.width;
      c.height = im.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(2, 2, 1, 1).data;
      return { r: d[0], b: d[2] };
    }, bytes.toString("base64"));
    expect(corner.b).toBeGreaterThan(200);
    expect(corner.r).toBeLessThan(80);
  });

  test("COPY as PNG: Chromium strips PNG chunks, so the rich copy pairs pixels with a text payload — pasting restores the board", async ({ page }) => {
    await open(page);
    await drawStroke(page, { x: 140, y: 140 }, { x: 260, y: 200 });
    await expect.poll(async () => (await stored(page))[0]?.doc.shapes.length ?? 0).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Copy as PNG" }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const [item] = await navigator.clipboard.read();
          return item?.types.includes("image/png") && item.types.includes("text/plain");
        })
      )
      .toBe(true);
    const { pngB64, text } = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const blob = await item.getType("image/png");
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return { pngB64: btoa(bin), text: await (await item.getType("text/plain")).text() };
    });
    // PLATFORM REALITY, pinned: the clipboard PNG is sanitized (chunk stripped)…
    expect(readBoardDocFromPngBytes(new Uint8Array(Buffer.from(pngB64, "base64")))).toBeNull();
    // …and the text payload carries the doc instead.
    expect(JSON.parse(text).kind).toBe("draw-board");
    // Pasting BOTH representations (what a real ⌘V delivers) imports the board.
    const before = (await stored(page)).length;
    await page.locator(".konvajs-content").click({ position: { x: 400, y: 350 } });
    await page.evaluate(
      ([data, payload]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "clip.png", { type: "image/png" }));
        dt.setData("text/plain", payload);
        (document.activeElement ?? document.body).dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
        );
      },
      [pngB64, text] as const
    );
    await expect.poll(async () => (await stored(page)).length).toBe(before + 1);
    // Imported as a BOARD, not as a pasted image shape.
    const all = await stored(page);
    expect(all.every((d) => !d.doc.shapes.some((sh) => (sh as { type: string }).type === "image"))).toBe(true);
  });
});

test.describe("clipboard fallback", () => {
  test("blocked clipboard falls back to a DOWNLOAD with an honest toast", async ({ page }) => {
    await open(page);
    await drawStroke(page, { x: 140, y: 140 }, { x: 260, y: 200 });
    // Simulate an unavailable clipboard (insecure LAN context / denied / Firefox).
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { write: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
        configurable: true,
      });
    });
    const downloadP = page.waitForEvent("download");
    await page.getByRole("button", { name: "Copy as PNG" }).click();
    const file = await downloadP; // the export landed as a file instead
    const bytes = fs.readFileSync((await file.path())!);
    expect(readBoardDocFromPngBytes(new Uint8Array(bytes))?.shapes.length).toBe(1); // still rich
    await expect(page.getByText("Clipboard unavailable here — downloaded instead")).toBeVisible();
  });
});

test.describe("stroke rendering", () => {
  test("strokes are NATIVELY zoom-true (model width attrs ride the stage transform, floored at 1 screen px); exports stay zoom-independent", async ({ page }) => {
    test.setTimeout(60_000);
    await openSeeded(page, [rect("r", 340, 240, 120, 80, { strokeWidth: 4 })]);

    /** The RENDERED node's width ATTR (model units), whether it scales with the
     *  stage (strokeScaleEnabled — screen width = attr × scale), + the camera. */
    const nodeSw = () =>
      page.evaluate(() => {
        const s = (window as unknown as { Konva: { stages: { scaleX(): number; findOne(sel: string): { strokeWidth(): number; strokeScaleEnabled(): boolean } }[] } }).Konva.stages.at(-1)!;
        const n = s.findOne("#r");
        return { sw: n.strokeWidth(), native: n.strokeScaleEnabled(), scale: s.scaleX() };
      });

    // Wherever the camera opens: width attr is the MODEL width and the stage
    // transform scales it — the screen width is 4 × scale by construction.
    await expect.poll(async () => (await nodeSw()).sw).toBe(4);
    expect((await nodeSw()).native).toBe(true);

    // MID-GESTURE (the glued-on regression): a wheel zoom must move the stroke
    // in the SAME frame, not on the ~180ms settle. Dispatch a pinch-style wheel
    // and read back within one evaluate after a single rAF (commit done, settle
    // timer nowhere near) — the width attr must still be the model 4 with
    // native scaling on, i.e. the screen width tracked the camera instantly.
    const mid = await page.evaluate(async () => {
      const w = window as unknown as { Konva: { stages: { scaleX(): number; content: HTMLElement; findOne(sel: string): { strokeWidth(): number; strokeScaleEnabled(): boolean } }[] } };
      const s = w.Konva.stages.at(-1)!;
      const before = s.scaleX();
      const r = s.content.getBoundingClientRect();
      // Dispatch on stage.content — Konva's listeners live on the INNER
      // konvajs-content div, and bubbling never descends from the container.
      s.content.dispatchEvent(
        new WheelEvent("wheel", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
      );
      // A frame or two for React to commit the camera — even a full 10 stays
      // legitimate: above the floor the settle changes nothing to hide behind.
      for (let i = 0; i < 10 && s.scaleX() === before; i++) await new Promise((res) => requestAnimationFrame(res));
      const n = s.findOne("#r");
      return { before, after: s.scaleX(), sw: n.strokeWidth(), native: n.strokeScaleEnabled() };
    });
    expect(mid.after).toBeGreaterThan(mid.before); // the zoom landed…
    expect(mid.sw).toBe(4); // …and the width attr needed no glue to follow
    expect(mid.native).toBe(true); // pre-fix: false + a frozen screen-px width until settle

    // TRANSFORMER pin/restore: during an anchor drag the outline is pinned in
    // screen px (native scaling off — live node scale must not thicken it);
    // release restores the exact model attr. The restore is the trap this
    // guards: a resize never changes the width PROP, so react-konva would never
    // rewrite it — only the imperative restore puts native scaling back.
    const box = (await page.locator(".konvajs-content").boundingBox())!;
    const toScreen = async (pt: { x: number; y: number }) => {
      const cam = await page.evaluate(() => {
        const s = (window as unknown as { Konva: { stages: { x(): number; y(): number; scaleX(): number }[] } }).Konva.stages.at(-1)!;
        return { x: s.x(), y: s.y(), scale: s.scaleX() };
      });
      return { x: box.x + cam.x + pt.x * cam.scale, y: box.y + cam.y + pt.y * cam.scale };
    };
    const center = await toScreen({ x: 400, y: 280 });
    await page.mouse.click(center.x, center.y); // select the rect
    const corner = await toScreen({ x: 460, y: 320 }); // its bottom-right anchor
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.mouse.move(corner.x + 6, corner.y + 5); // arm the transform
    await page.mouse.move(corner.x + 40, corner.y + 30);
    const pinned = await nodeSw();
    expect(pinned.native).toBe(false); // pinned for the drag…
    expect(pinned.sw).toBeCloseTo(4 * pinned.scale, 5); // …at the pre-drag screen width
    await page.mouse.up();
    const restored = await nodeSw();
    expect(restored.native).toBe(true); // native scaling is back…
    expect(restored.sw).toBe(4); // …at the exact model width
    // (a spot inside the zoomed-in viewport, clear of the grown rect)
    const empty = await toScreen({ x: 120, y: 150 });
    await page.mouse.click(empty.x, empty.y); // deselect before the zoom/export flow

    // Zoom out twice (buttons settle immediately): still the plain model attr —
    // the visible thinning is pure camera scale.
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    let st = await nodeSw();
    expect(st.sw).toBe(4);
    expect(st.scale).toBeLessThan(mid.after);

    // Deep zoom-out: the SETTLED width floors at 1 screen px (attr = 1/scale
    // model units) instead of thinning away.
    for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "Zoom out" }).click();
    await expect.poll(async () => (await nodeSw()).scale).toBeLessThan(0.25);
    st = await nodeSw();
    expect(st.sw * st.scale).toBeCloseTo(1, 5);

    // …and the floor HOLDS live through a gesture ("small stays small"): a
    // mid-gesture zoom must keep the screen width at max(4×scale, 1px) in the
    // SAME frame — no ride-along-then-correct at settle.
    const midFloor = await page.evaluate(async () => {
      const w = window as unknown as { Konva: { stages: { scaleX(): number; content: HTMLElement; findOne(sel: string): { strokeWidth(): number } }[] } };
      const s = w.Konva.stages.at(-1)!;
      const before = s.scaleX();
      const r = s.content.getBoundingClientRect();
      s.content.dispatchEvent(
        new WheelEvent("wheel", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
      );
      for (let i = 0; i < 10 && s.scaleX() === before; i++) await new Promise((res) => requestAnimationFrame(res));
      const scale = s.scaleX();
      return { before, scale, sw: s.findOne("#r").strokeWidth() };
    });
    expect(midFloor.scale).toBeGreaterThan(midFloor.before); // the zoom landed
    expect(midFloor.sw * midFloor.scale).toBeCloseTo(Math.max(4 * midFloor.scale, 1), 5);

    // Export while zoomed way out: the PNG renders strokes at the EXPORT scale
    // (model width × s, s=2 for a sketch) — independent of the live zoom and
    // its legibility floor. Deny the clipboard so Copy as PNG downloads.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { write: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
        configurable: true,
      });
    });
    const downloadP = page.waitForEvent("download");
    await page.getByRole("button", { name: "Copy as PNG" }).click();
    const file = await downloadP;
    const b64 = fs.readFileSync((await file.path())!).toString("base64");
    // Scan the raster's horizontal centerline for red-ink runs: the rect's two
    // vertical edges, each strokeWidth(4) × exportScale(2) = 8px wide.
    const runs = await page.evaluate(async (png: string) => {
      const img = new Image();
      img.src = "data:image/png;base64," + png;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const row = ctx.getImageData(0, Math.round(img.height / 2), img.width, 1).data;
      const out: number[] = [];
      let run = 0;
      for (let x = 0; x < img.width; x++) {
        const ink = row[x * 4] > 140 && row[x * 4] - row[x * 4 + 1] > 60; // #e5484d on the dark board
        if (ink) run++;
        else if (run) {
          out.push(run);
          run = 0;
        }
      }
      if (run) out.push(run);
      return out;
    }, b64);
    expect(runs.length).toBe(2);
    for (const r of runs) {
      expect(r).toBeGreaterThan(6);
      expect(r).toBeLessThan(10);
    }

    // And the export restored the LIVE attrs (still floored at this zoom).
    st = await nodeSw();
    expect(st.sw * st.scale).toBeCloseTo(1, 5);
  });
});

test.describe("shape grouping (⌘G end-to-end)", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  /** Logical→screen through the live camera (the board may open fitted). */
  async function toScreen(page: Page, pt: { x: number; y: number }) {
    const cam = await page.evaluate(() => {
      const s = (window as unknown as { Konva: { stages: { x(): number; y(): number; scaleX(): number }[] } }).Konva.stages.at(-1)!;
      return { x: s.x(), y: s.y(), scale: s.scaleX() };
    });
    const box = (await page.locator(".konvajs-content canvas").first().boundingBox())!;
    return { x: box.x + pt.x * cam.scale + cam.x, y: box.y + pt.y * cam.scale + cam.y };
  }

  async function dragLogical(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
    const a = await toScreen(page, from);
    const b = await toScreen(page, to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
  }

  const doc = async (page: Page) => (await stored(page))[0].doc as { shapes: Record<string, any>[] };
  const shape = async (page: Page, id: string) => (await doc(page)).shapes.find((sh) => sh.id === id)!;

  test("group → drag whole → glue in → scale via proxy (inbound re-judged) → deep-edit → paste remap → ungroup", async ({ page }) => {
    test.setTimeout(60_000);
    await openSeeded(page, [rect("r1", 100, 100), rect("r2", 220, 100), rect("out", 400, 320, 60, 40)]);

    // Marquee r1+r2, ⌘G — both members carry the same fresh gid; out stays loose.
    await dragLogical(page, { x: 60, y: 60 }, { x: 320, y: 200 });
    await page.keyboard.press("Control+g");
    await expect.poll(async () => (await shape(page, "r1")).groupPath?.length ?? 0).toBe(1);
    const gid = (await shape(page, "r1")).groupPath![0] as string;
    expect((await shape(page, "r2")).groupPath).toEqual([gid]);
    expect((await shape(page, "out")).groupPath).toBeUndefined();

    // Dragging ONE member drags the whole group rigidly.
    await dragLogical(page, { x: 140, y: 130 }, { x: 260, y: 160 });
    await expect.poll(async () => (await shape(page, "r1")).x).toBe(220);
    expect(await shape(page, "r2")).toMatchObject({ x: 340, y: 130 });

    // Glue IN: drop `out` snug under member r2 → an inbound edge onto the unit…
    await dragLogical(page, { x: 430, y: 340 }, { x: 380, y: 215 });
    await expect.poll(async () => (await shape(page, "out")).attach?.id).toBe("r2");
    // …so the follower rides the next whole-group drag.
    const outBefore = await shape(page, "out");
    await dragLogical(page, { x: 260, y: 160 }, { x: 260, y: 260 });
    await expect.poll(async () => (await shape(page, "r1")).y).toBe(230);
    const outAfter = await shape(page, "out");
    expect(outAfter.y - outBefore.y).toBeCloseTo(100, 0);

    // Scale via the proxy Transformer: click a member (selects the whole unit),
    // drag the bottom-right corner anchor outward. Uniform bake: both members
    // scale by the same factor, ratio preserved, strokeWidth rides.
    const r1 = await shape(page, "r1");
    const r2 = await shape(page, "r2");
    const corner = { x: Math.max(r1.x + r1.width, r2.x + r2.width), y: Math.max(r1.y + r1.height, r2.y + r2.height) };
    const origin = { x: Math.min(r1.x, r2.x), y: Math.min(r1.y, r2.y) };
    await page.mouse.click((await toScreen(page, { x: r1.x + 10, y: r1.y + 10 })).x, (await toScreen(page, { x: r1.x + 10, y: r1.y + 10 })).y);
    const target = { x: origin.x + (corner.x - origin.x) * 1.5, y: origin.y + (corner.y - origin.y) * 1.5 };
    await dragLogical(page, corner, target);
    await expect.poll(async () => (await shape(page, "r1")).width).toBeGreaterThan(95);
    const s1 = await shape(page, "r1");
    const s2 = await shape(page, "r2");
    const factor = s1.width / 80;
    expect(s1.width / s1.height).toBeCloseTo(80 / 60, 2); // uniform
    expect(s2.width / 80).toBeCloseTo(factor, 2); // same factor for every member
    expect(s1.strokeWidth).toBeCloseTo(3 * factor, 1);
    expect((await shape(page, "out")).attach?.id).toBe("r2"); // inbound edge re-judged, kept

    // Deep-edit: ⌘-click member r2, set stroke 10 — ONLY r2 changes.
    const p2 = await toScreen(page, { x: s2.x + 10, y: s2.y + 10 });
    const canvasBox = (await page.locator(".konvajs-content").boundingBox())!;
    await page
      .locator(".konvajs-content")
      .click({ position: { x: p2.x - canvasBox.x, y: p2.y - canvasBox.y }, modifiers: ["Control"] });
    // Deep-select is live: a proper subset can't group OR ungroup → the toolbar
    // toggle reads "Group selection" and is disabled.
    await expect(page.getByRole("button", { name: "Group selection (⌘G)" })).toBeDisabled();
    await page.getByRole("button", { name: "Stroke 10px" }).click();
    await expect.poll(async () => (await shape(page, "r2")).strokeWidth).toBe(10);
    expect((await shape(page, "r1")).strokeWidth).toBeCloseTo(3 * factor, 1); // untouched

    // Copy/paste the group: fresh ids, fresh SHARED gid — never welded to the
    // original (⌘G on the pasted pair must not affect r1/r2).
    const s1now = await shape(page, "r1");
    const click1 = await toScreen(page, { x: s1now.x + 10, y: s1now.y + 10 });
    await page.mouse.click(click1.x, click1.y); // plain click → whole unit
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    await expect.poll(async () => (await doc(page)).shapes.length).toBe(5);
    const pasted = (await doc(page)).shapes.filter((sh) => !["r1", "r2", "out"].includes(sh.id as string));
    expect(pasted).toHaveLength(2);
    const pgid = pasted[0].groupPath![0] as string;
    expect(pasted[1].groupPath).toEqual([pgid]);
    expect(pgid).not.toBe(gid);

    // Ungroup the ORIGINAL: exact-cover selection + ⌘G strips the level; the
    // pasted copy keeps its own group.
    await page.mouse.click(click1.x, click1.y);
    await page.keyboard.press("Control+g");
    await expect.poll(async () => (await shape(page, "r1")).groupPath ?? null).toBeNull();
    expect((await shape(page, "r2")).groupPath).toBeUndefined();
    expect((await doc(page)).shapes.filter((sh) => sh.groupPath?.[0] === pgid)).toHaveLength(2);
  });

  test("cross-version normalization: duplicated gids split by context, singleton paths collapse, on open", async ({ page }) => {
    await openSeeded(page, [
      rect("a", 100, 100, 40, 30, { groupPath: ["g1"] }),
      rect("b", 160, 100, 40, 30, { groupPath: ["g1"] }),
      // The same gid nested under a different parent — an old-version artifact;
      // structurally a DIFFERENT group.
      rect("c", 400, 100, 40, 30, { groupPath: ["g2", "g1"] }),
      rect("d", 460, 100, 40, 30, { groupPath: ["g2", "g1"] }),
      rect("e", 100, 400, 40, 30, { groupPath: ["solo"] }), // singleton → collapses
    ]);
    // Normalization runs at open (in memory); an edit persists the healed doc.
    await dragLogical(page, { x: 120, y: 115 }, { x: 130, y: 115 });
    await expect.poll(async () => (await shape(page, "a")).x).toBeGreaterThan(105);
    const [a, b, c, d, e2] = await Promise.all(["a", "b", "c", "d", "e"].map((id) => shape(page, id)));
    expect(a.groupPath).toEqual(["g1"]);
    expect(b.groupPath).toEqual(["g1"]);
    expect(c.groupPath![1]).not.toBe("g1"); // split off g1's reuse
    expect(c.groupPath).toEqual(d.groupPath);
    expect(e2.groupPath).toBeUndefined();
    // And the healed groups BEHAVE: dragging a moved its whole unit (b rode).
    expect(b.x).toBeCloseTo(a.x + 60, 0);
  });

  test("a group is selectable by its AABB: clicking/dragging the GAP between members grabs the whole group", async ({ page }) => {
    // Two members with an empty corridor between them (200..300 hits neither).
    await openSeeded(page, [
      rect("a", 100, 100, 80, 60, { groupPath: ["g"] }),
      rect("b", 320, 100, 80, 60, { groupPath: ["g"] }),
      rect("loose", 100, 400, 80, 60),
    ]);
    // Click in the gap → the whole group selects (ungroup action available).
    const gap = await toScreen(page, { x: 250, y: 130 });
    await page.mouse.click(gap.x, gap.y);
    await expect(page.getByRole("button", { name: "Ungroup (⌘G)" })).toBeEnabled();
    // Drag FROM the gap → the whole group moves rigidly; loose stays put.
    await dragLogical(page, { x: 250, y: 130 }, { x: 290, y: 180 });
    await expect.poll(async () => (await shape(page, "a")).x).toBeCloseTo(140, 0);
    expect((await shape(page, "b")).x).toBeCloseTo(360, 0);
    expect((await shape(page, "b")).y).toBeCloseTo(150, 0);
    expect((await shape(page, "loose")).x).toBe(100);
    // OUTSIDE the AABB → still a marquee-from-empty (deselects; no accidental grab).
    const out = await toScreen(page, { x: 700, y: 130 });
    await page.mouse.click(out.x, out.y);
    await expect(page.getByRole("button", { name: "Group selection (⌘G)" })).toBeDisabled();
  });

  test("side-anchor group resize: members FOLLOW the stretch (sizes track the axis), bound arrows re-cling with absolute gap", async ({ page }) => {
    await openSeeded(page, [
      rect("a", 300, 100, 80, 60, { groupPath: ["g"] }),
      rect("b", 420, 100, 80, 60, { groupPath: ["g"] }),
      // A LOOSE arrow bound onto member b with a 6px breathing gap (its tip
      // sits at b's left edge 420 − 6 = 414; the free end at 385 is outside
      // both members, in the corridor between them).
      { id: "bd", type: "arrow", stroke: "#000", strokeWidth: 3, points: [385, 130, 414, 130], bindEnd: { id: "b", angle: 0, gap: 6 } },
    ]);
    // Select the group, then drag the MIDDLE-RIGHT anchor 100px right:
    // unit bounds 300..500 → fx 1.5 about the left edge.
    const sel = await toScreen(page, { x: 340, y: 130 });
    await page.mouse.click(sel.x, sel.y);
    await dragLogical(page, { x: 500, y: 130 }, { x: 600, y: 130 });
    // Boxes map fully affinely on the stretched axis: position remaps, width×1.5.
    await expect.poll(async () => (await shape(page, "b")).x).toBeCloseTo(480, 0); // 300 + 120×1.5
    const a = await shape(page, "a");
    const b = await shape(page, "b");
    expect(a.x).toBeCloseTo(300, 0);
    expect(a.width).toBeCloseTo(120, 0);
    expect(b.width).toBeCloseTo(120, 0);
    // The untouched axis and stroke stay put (no uniform factor exists;
    // heights ride fy which the Transformer reports with float noise → closeTo).
    for (const v of [a.y, b.y]) expect(v).toBeCloseTo(100, 5);
    for (const v of [a.height, b.height]) expect(v).toBeCloseTo(60, 5);
    expect(a.strokeWidth).toBe(3);
    // The bound arrow FOLLOWED ITS BINDING: not a member (its free end never
    // moves) — the settle re-clung its tip to b's stretched border keeping the
    // ABSOLUTE 6px gap (b center 540 − half-width 60 − 6 = 474), where a naive
    // remap would have stretched the gap to 9.
    const bd = await shape(page, "bd");
    expect(bd.points![0]).toBeCloseTo(385, 0);
    expect(bd.points![2]).toBeCloseTo(474, 0);
    expect((bd as { bindEnd?: { gap: number } }).bindEnd?.gap).toBe(6);
  });

  test("secret size ladder + size dots scale a selected group/image proportionally", async ({ page }) => {
    const PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await openSeeded(page, [
      rect("solo", 100, 100, 80, 60),
      rect("a", 300, 100, 80, 60, { groupPath: ["g"] }),
      rect("b", 420, 100, 80, 60, { groupPath: ["g"] }),
      { id: "img", type: "image", stroke: "#000", strokeWidth: 3, x: 100, y: 350, width: 60, height: 40, dataBase64: PNG1, mediaType: "image/png" },
    ]);
    const clickAt = async (pt: { x: number; y: number }) => {
      const s = await toScreen(page, pt);
      await page.mouse.click(s.x, s.y);
    };
    // — Stroke mode: `=` walks past the visible top into the secret sizes.
    await clickAt({ x: 140, y: 130 }); // select solo (stroke 3)
    for (let i = 0; i < 3; i++) await page.keyboard.press("=");
    await expect.poll(async () => (await shape(page, "solo")).strokeWidth).toBe(14); // 3→6→10→14 (secret)
    // Toolbar: re-pressing the LARGE dot keeps going…
    await page.getByRole("button", { name: "Stroke 10px" }).click();
    await expect.poll(async () => (await shape(page, "solo")).strokeWidth).toBe(20);
    // …the OPPOSITE extreme walks back one rung…
    await page.getByRole("button", { name: "Stroke 3px" }).click();
    await expect.poll(async () => (await shape(page, "solo")).strokeWidth).toBe(14);
    // …and MID resets immediately.
    await page.getByRole("button", { name: "Stroke 6px" }).click();
    await expect.poll(async () => (await shape(page, "solo")).strokeWidth).toBe(6);
    // — Scale mode: the same keys/dots scale a selected GROUP proportionally.
    await clickAt({ x: 340, y: 130 }); // select the whole group
    await page.keyboard.press("=");
    await expect.poll(async () => (await shape(page, "a")).width).toBeCloseTo(96, 0); // 80×1.2
    expect((await shape(page, "a")).strokeWidth).toBeCloseTo(3.6, 3); // stroke rides the scale
    expect((await shape(page, "b")).width).toBeCloseTo(96, 0);
    // The union center stayed put (scaled about the group's center).
    const a1 = await shape(page, "a");
    const b1 = await shape(page, "b");
    expect((a1.x + (b1.x + b1.width)) / 2).toBeCloseTo((300 + 500) / 2, 0);
    // Large DOT steps the scale too; `-` steps back down.
    await page.getByRole("button", { name: "Stroke 10px" }).click();
    await expect.poll(async () => (await shape(page, "a")).width).toBeCloseTo(115.2, 0);
    await page.keyboard.press("-");
    await expect.poll(async () => (await shape(page, "a")).width).toBeCloseTo(96, 0);
    // — A lone IMAGE scales as well (stroke is meaningless there).
    await clickAt({ x: 130, y: 370 });
    await page.keyboard.press("=");
    await expect.poll(async () => (await shape(page, "img")).width).toBeCloseTo(72, 0);
  });

  test("size dots read the unit's remembered step: absolute in the normal zone, relative in the extended zone, mid restores natural", async ({ page }) => {
    await openSeeded(page, [
      rect("a", 100, 100, 80, 60, { groupPath: ["g"] }),
      rect("b", 320, 100, 80, 60, { groupPath: ["g"] }),
      rect("loose", 100, 400, 80, 60, { strokeWidth: 10 }),
    ]);
    const clickAt = async (pt: { x: number; y: number }) => {
      const s = await toScreen(page, pt);
      await page.mouse.click(s.x, s.y);
    };
    const dotSmall = page.getByRole("button", { name: "Stroke 3px" });
    const dotMid = page.getByRole("button", { name: "Stroke 6px" });
    const dotLarge = page.getByRole("button", { name: "Stroke 10px" });
    // A fresh group selects at its natural size — the MID dot is active.
    await clickAt({ x: 140, y: 130 });
    await expect(dotMid).toHaveAttribute("aria-pressed", "true");
    // Large: ABSOLUTE ×1.2, the well slides to large.
    await dotLarge.click();
    await expect.poll(async () => (await shape(page, "a")).width).toBeCloseTo(96, 0);
    await expect(dotLarge).toHaveAttribute("aria-pressed", "true");
    // Re-pressing large enters the EXTENDED zone (×1.2³ total) — and the
    // OPPOSITE dot now advertises its changed meaning (one step back).
    await dotLarge.click();
    await dotLarge.click();
    await expect.poll(async () => (await shape(page, "a")).width).toBeCloseTo(138.24, 0);
    await expect(dotSmall).toHaveAttribute("title", /One step back down/);
    // Small in the extended zone: ONE step back in, not a jump.
    await dotSmall.click();
    await expect.poll(async () => (await shape(page, "a")).width).toBeCloseTo(115.2, 0);
    // Mid: restores the exact natural size from anywhere.
    await dotMid.click();
    await expect.poll(async () => (await shape(page, "a")).width).toBeCloseTo(80, 1);
    expect((await shape(page, "a")).x).toBeCloseTo(100, 1);
    // Normal zone is absolute both ways: large, then small jumps STRAIGHT down
    // past natural (the "if we are large, we become small" case).
    await dotLarge.click();
    await expect.poll(async () => (await shape(page, "a")).width).toBeCloseTo(96, 0);
    await dotSmall.click();
    await expect.poll(async () => (await shape(page, "a")).width).toBeCloseTo(80 / 1.2, 0);
    expect((await shape(page, "a")).sizeStep).toBe(-1); // remembered IN the drawing (persists)
    // Switching selection shows the OTHER element's remembered size: the loose
    // rect's own stroke (10 → large dot), not the group's step.
    await clickAt({ x: 140, y: 430 });
    await expect(dotLarge).toHaveAttribute("aria-pressed", "true");
    // Stroke mode has the same extended-zone affordance on its ladder…
    await dotLarge.click(); // 10 → 14 (secret)
    await expect.poll(async () => (await shape(page, "loose")).strokeWidth).toBe(14);
    await expect(dotSmall).toHaveAttribute("title", /One step back down/);
    // …and re-selecting the group restores ITS remembered small position, with
    // the keyboard stepping relatively on top of it (−1 → 0 → +1).
    await clickAt({ x: 140, y: 120 });
    await expect(dotSmall).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("=");
    await page.keyboard.press("=");
    await expect.poll(async () => (await shape(page, "a")).width).toBeCloseTo(96, 0);
    await expect(dotLarge).toHaveAttribute("aria-pressed", "true");
  });

  test("opening the text editor keeps the glyphs in place (field line metrics match the canvas)", async ({ page }) => {
    await openSeeded(page, [{ id: "t1", type: "text", stroke: "#e5484d", strokeWidth: 3, x: 100, y: 100, text: "Hello", fontSize: 24 }]);
    // Clip around the text's LEFT half (excludes the caret, which parks after
    // the last glyph while editing).
    const tl = await toScreen(page, { x: 98, y: 80 });
    const br = await toScreen(page, { x: 150, y: 150 });
    const clip = { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
    /** Topmost screenshot row containing text-colored (red) ink, decoded IN-PAGE. */
    const topInkRow = async () => {
      const png = await page.screenshot({ clip });
      return page.evaluate(async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            if (d[i] > 120 && d[i] - d[i + 2] > 40 && d[i] - d[i + 1] > 40) return y;
          }
        }
        return -1;
      }, png.toString("base64"));
    };
    const canvasTop = await topInkRow();
    expect(canvasTop).toBeGreaterThan(0);
    const p = await toScreen(page, { x: 120, y: 112 });
    await page.mouse.dblclick(p.x, p.y);
    const field = page.locator(".draw-text-input");
    await expect(field).toBeVisible();
    // Kill the caret + the select-all highlight so only glyph ink is measured.
    await field.evaluate((ta: HTMLTextAreaElement) => {
      ta.style.caretColor = "transparent";
      ta.setSelectionRange(0, 0);
    });
    const fieldTop = await topInkRow();
    expect(fieldTop).toBeGreaterThan(0);
    // Same glyphs, same place: tolerate ≤1px of engine baseline nuance — the
    // pre-fix leading mismatch showed up as a systematic multi-px drop.
    expect(Math.abs(fieldTop - canvasTop)).toBeLessThanOrEqual(1);
  });

  test("a fast ⌘C⌘V pastes the just-copied shapes even while the system clipboard still holds older content", async ({ page }) => {
    await openSeeded(page, [rect("r", 100, 100, 80, 60)]);
    // Older external content sits on the system clipboard, and the board's own
    // ⌘C clipboard write is ASYNC — a fast ⌘V can read the clipboard before the
    // envelope lands. Simulate the lost race deterministically: pin writeText
    // to a no-op so ⌘C's system write never arrives.
    await page.evaluate(async () => {
      await navigator.clipboard.writeText("older external text");
      (navigator.clipboard as { writeText: (t: string) => Promise<void> }).writeText = () => Promise.resolve();
    });
    const p = await toScreen(page, { x: 140, y: 130 });
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    await expect.poll(async () => (await doc(page)).shapes.length).toBe(2);
    // The COPY pasted — not a text shape minted from the stale clipboard text.
    const pasted = (await doc(page)).shapes.find((sh) => sh.id !== "r")!;
    expect(pasted.type).toBe("rect");
  });

  test("two quick clicks at DIFFERENT spots never synthesize a double-click (no phantom editor)", async ({ page }) => {
    await openSeeded(page, [{ id: "t", type: "text", stroke: "#e5484d", strokeWidth: 3, x: 100, y: 100, text: "hello", fontSize: 18 }]);
    // Konva's dblclick window is time-based and position-blind: a deselect-click
    // on empty canvas followed by a quick click on a shape used to "double-click"
    // the shape and pop its text editor mid-flow.
    const empty = await toScreen(page, { x: 500, y: 320 });
    const onText = await toScreen(page, { x: 115, y: 108 });
    await page.mouse.click(empty.x, empty.y);
    await page.mouse.click(onText.x, onText.y); // back-to-back: well inside the window
    await page.waitForTimeout(300);
    await expect(page.locator(".draw-text-input")).toHaveCount(0); // no phantom text editor
    // A GENUINE double-click (two still clicks in one place) still opens it.
    await page.waitForTimeout(500); // let the window from the clicks above lapse
    await page.mouse.dblclick(onText.x, onText.y);
    await expect(page.locator(".draw-text-input")).toBeVisible();
  });
});

test("export menu stacks ABOVE the minimap (hit-test in the overlap)", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 560 }); // force menu/minimap overlap
  await open(page);
  await page.getByRole("button", { name: "More export options" }).click();
  const menu = (await page.locator("[data-export-menu]").boundingBox())!;
  const mini = (await page.locator("[data-minimap]").boundingBox())!;
  const x0 = Math.max(menu.x, mini.x);
  const y0 = Math.max(menu.y, mini.y);
  const x1 = Math.min(menu.x + menu.width, mini.x + mini.width);
  const y1 = Math.min(menu.y + menu.height, mini.y + mini.height);
  expect(x1).toBeGreaterThan(x0); // the layouts DO overlap at this size…
  expect(y1).toBeGreaterThan(y0);
  const topHit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      const chain: string[] = [];
      for (let e: Element | null = el; e && chain.length < 7; e = e.parentElement) {
        chain.push(`${e.tagName}.${String((e as HTMLElement).className).slice(0, 60)}`);
      }
      return { inMenu: !!el?.closest("[data-export-menu]"), inMini: !!el?.closest("[data-minimap]"), chain };
    },
    [(x0 + x1) / 2, (y0 + y1) / 2] as const
  );
  expect(topHit).toMatchObject({ inMenu: true, inMini: false }); // menu wins the stack
});

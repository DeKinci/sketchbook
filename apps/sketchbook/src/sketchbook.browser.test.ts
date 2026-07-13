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

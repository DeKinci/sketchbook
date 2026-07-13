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

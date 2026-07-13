import { defineConfig } from "vitest/config";

// The package's tests cover the PURE core (reducer, camera math, export crop) —
// no DOM, no Konva. Component behavior is proven by the real-browser suite in
// apps/web (drawViewport.browser.test.ts), which mounts the actual editor.
export default defineConfig({
  test: {
    environment: "node",
  },
});

import { defineConfig } from "vitest/config";

// The package's tests cover the PURE core (reducer, camera math, export crop) —
// no DOM, no Konva. Component behavior is proven by the real-browser suite in
// apps/sketchbook (sketchbook.browser.test.ts), which mounts the actual editor.
export default defineConfig({
  test: {
    environment: "node",
    // Restricted-CPU sandboxes can resolve tinypool's default minThreads above
    // its computed maxThreads ("options.minThreads and options.maxThreads must
    // not conflict"), killing the run before any test executes. The suite is
    // sub-second — one fork loses nothing and runs everywhere.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});

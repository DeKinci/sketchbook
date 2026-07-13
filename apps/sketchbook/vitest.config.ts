import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom for the drawings store's localStorage round-trip. Node ≥22 ships a
    // DEAD experimental localStorage global that shadows jsdom's — the test
    // script disables it (NODE_OPTIONS=--no-experimental-webstorage).
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "**/*.browser.test.ts"], // Playwright-owned
  },
});

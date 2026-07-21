import { defineConfig } from "@playwright/test";

// The mirror of vitest.config's exclude: Playwright owns ONLY *.browser.test.ts,
// so a bare `playwright test` never sweeps vitest unit files into its runner
// (importing vitest outside its CLI crashes at collection).
export default defineConfig({
  testMatch: /.*\.browser\.test\.ts/,
});

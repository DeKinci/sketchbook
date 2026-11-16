import { defineConfig } from "@playwright/test";
import { workerCap } from "./playwright.workers.ts";

// The mirror of vitest.config's exclude: Playwright owns ONLY *.browser.test.ts,
// so a bare `playwright test` never sweeps vitest unit files into its runner
// (importing vitest outside its CLI crashes at collection).
export default defineConfig({
  testMatch: /.*\.browser\.test\.ts/,
  // Each worker is a whole chromium. See playwright.workers.ts — absent/0 env keeps
  // Playwright's own default, so a human running this directly pays no cap.
  ...workerCap(),
});

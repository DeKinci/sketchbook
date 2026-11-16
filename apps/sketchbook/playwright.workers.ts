/**
 * Optional Playwright worker cap. Each worker is a whole chromium, so a harness
 * running several suites at once (Dorodango injects it per run) can bound the fan-out
 * with `PLAYWRIGHT_MAX_WORKERS`. Absent, zero or junk ⇒ `{}` ⇒ Playwright's default,
 * so a human running `pnpm test:browser` directly is uncapped.
 */
export function workerCap(): { workers?: number } {
  const n = Number(process.env.PLAYWRIGHT_MAX_WORKERS);
  return Number.isInteger(n) && n > 0 ? { workers: n } : {};
}

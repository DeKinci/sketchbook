import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port precedence: the Operator service contract (injected for the named
// "sketchbook" run config), then an explicit override, then the task-worktree
// base + 3 (base/base+1 belong to the operator server/web), then the plain
// default. Never the primary instance's 47317/47173.
const base = process.env.OPERATOR_DEV_PORT_BASE;
const port = Number(
  process.env.OPERATOR_SERVICE_SKETCHBOOK_PORT ??
    process.env.SKETCHBOOK_PORT ??
    (base ? Number(base) + 3 : 5199)
);

export default defineConfig({
  plugins: [react()],
  // `.ts.net` so the dev server is reachable at its own tailnet origin through Tailscale
  // Serve (the own-origin preview path — see apps/server/src/previewOrigins.ts).
  server: { port, allowedHosts: [".ts.net"] },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { watchWorkspacePackages } from "../../vite.watchPackages.ts";

// Port precedence: the injected web port (Operator guesses a run's preview URL on
// OPERATOR_WEB_PORT — a frontend dev server MUST bind it or its URL is treated as an
// off-web-port backend URL and hidden, so the preview never routes), then an explicit
// override, then the task-worktree base + 1 (= the web port), then the plain default.
// Never the primary instance's 47317/47173, and never OPERATOR_SERVICE_SKETCHBOOK_PORT
// — that's the service's BACKEND port (for cross-service discovery), = OPERATOR_PORT,
// one below the web port; binding it is exactly what made the preview "forbidden".
const base = process.env.OPERATOR_DEV_PORT_BASE;
const port = Number(
  process.env.OPERATOR_WEB_PORT ??
    process.env.SKETCHBOOK_PORT ??
    (base ? Number(base) + 1 : 5199)
);

export default defineConfig({
  // watchWorkspacePackages: `@operator/draw-board` is imported as out-of-root source,
  // which vite watches per-file — a mode chokidar 4 permanently loses on git file
  // replaces (every Operator land). Dir-level coverage keeps HMR alive; see the plugin.
  plugins: [react(), watchWorkspacePackages()],
  // `.ts.net` so the dev server is reachable at its own tailnet origin through Tailscale
  // Serve (the own-origin preview path — see apps/server/src/previewOrigins.ts).
  server: { port, allowedHosts: [".ts.net"] },
});

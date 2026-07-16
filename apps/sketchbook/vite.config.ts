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

// Wildcard-preview (Cloudflare Tunnel) hints, injected by the server's devEnv when an origin
// template is configured (apps/server/src/devEnv.ts). Behind the tunnel this dev server is reached
// at `p<port>.<domain>` over 443, so its Host must be allowed (else Vite 403s "forbidden") and HMR
// must dial 443 — not the raw local port over https, which fails silently. Unset (a laptop/loopback
// preview) → the tailnet default. Same handling as apps/web/vite.config.ts.
const previewAllowedHosts = process.env.OPERATOR_PREVIEW_ALLOWED_HOSTS;
const previewHmrClientPort = process.env.OPERATOR_PREVIEW_HMR_CLIENT_PORT;
const allowedHosts = previewAllowedHosts === "all" ? true : previewAllowedHosts ? [previewAllowedHosts] : [".ts.net"];
const hmr = previewHmrClientPort ? { hmr: { clientPort: Number(previewHmrClientPort) } } : {};

export default defineConfig({
  plugins: [react()],
  // `.ts.net` so the dev server is reachable at its own tailnet origin through Tailscale
  // Serve (the own-origin preview path — see apps/server/src/previewOrigins.ts). Behind the
  // Cloudflare Tunnel wildcard origin the `p<port>.<domain>` Host is allowed via
  // OPERATOR_PREVIEW_ALLOWED_HOSTS (=all) instead.
  server: { port, allowedHosts, ...hmr },
});

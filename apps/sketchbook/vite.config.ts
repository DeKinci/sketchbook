import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port: own env first; inside an Operator task worktree fall back to the
// injected base + 3 (base/base+1 belong to the operator server/web); plain
// default last. Never the primary instance's 47317/47173.
const base = process.env.OPERATOR_DEV_PORT_BASE;
const port = Number(process.env.SKETCHBOOK_PORT ?? (base ? Number(base) + 3 : 5199));

export default defineConfig({
  plugins: [react()],
  server: { port },
});

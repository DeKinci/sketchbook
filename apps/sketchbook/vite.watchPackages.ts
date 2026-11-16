import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Keep HMR alive for the workspace lib's sources (`packages/*`).
 *
 * The app imports `markup-board` as out-of-root SOURCE through the workspace symlink,
 * and vite 6 (chokidar 4) watches such files one by one. A per-file watch dies silently
 * the first time git REPLACES the file (unlink + create — checkouts, pulls, an agent
 * harness landing commits), and vite then serves a stale transform until restart.
 * Directory watches re-arm across replaces, so add the package roots as directories.
 *
 * Typed structurally (no `vite` import); the shape is assignable to vite's `Plugin`.
 */
export function watchWorkspacePackages(
  dirs: string[] = [fileURLToPath(new URL("../../packages", import.meta.url))]
) {
  return {
    name: "sketchbook:watch-workspace-packages",
    apply: "serve" as const,
    configureServer(server: { watcher: { add(path: string): unknown } }) {
      for (const dir of dirs) {
        if (fs.existsSync(dir)) server.watcher.add(dir);
      }
    },
  };
}

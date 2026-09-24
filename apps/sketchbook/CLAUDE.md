# Sketchbook (`@dorodango/sketchbook`)

Standalone drawings app: sidebar of named boards, each embedding `@dorodango/draw-board`. **No server, no API, no auth** — `localStorage` only. Exists as a scratch surface AND as the honest host-agnosticism test for `draw-board`.

## Commands
`pnpm --filter @dorodango/sketchbook dev` · `build` · `preview` · `typecheck` · `test` (vitest, jsdom) · **`test:browser`** (Playwright; the second half of root `pnpm test:browser`).

Both test scripts pass `NODE_OPTIONS=--no-experimental-webstorage` — else Node's experimental `localStorage` shadows jsdom's store and persistence tests go quiet-green; `src/lib/drawings.ts` reaches `window.localStorage` explicitly for the same reason. Don't drop either.

## Ports
`vite.config.ts` resolves: `DORO_WEB_PORT` → `SKETCHBOOK_PORT` → `DORO_DEV_PORT_BASE + 1` → `5199`. First entry load-bearing: a frontend MUST bind `DORO_WEB_PORT` or its preview URL is classified backend and never routes. **Never bind `DORO_SERVICE_SKETCHBOOK_PORT`** (the backend port — binding it once read as "forbidden" preview). `allowedHosts: [".ts.net"]`. Overlay injected by the preview proxy, no wiring.

## Structure
`src/App.tsx` (shell: list, active drawing, rename, library, toasts, `DrawEditor` mount) · `src/lib/drawings.ts` (pure list ops + storage I/O, key `sketchbook:drawings`) · `src/lib/library.ts` (element library, **shared across drawings**, key `sketchbook:library`) · `src/ExportCluster.tsx` (toolbar exports via `toolbarExtra`).

`Drawing = { id, name, doc, createdAt, session? }`. **No schema version, no migration** — loaders filter records missing `id`/`doc`, corrupt JSON = empty. Changing the stored shape ⇒ add a version key, don't widen the filter.

## Board embedding
`<DrawEditor>` gets `doc`/`onChange`, `session`/`onSessionChange`, `features` (from URL once via `featuresFromUrl()` — frozen at mount), `onNotify`, `library`, `boardRef`, `toolbarExtra`, `onImportBoard`, `autoFocus`. Subtleties: `key={active.id}` forces FULL remount per drawing (session survives only via `onSessionChange` round-trip); `autoFocus={renamingId === null}` (else the board steals the rename input's first keystrokes); mutations route through a `useRef`'d callback so the board's unmount flush still lands. No save button, no revert.

## Import / export
Rich PNG/SVG embed the full doc (`boardFile.ts`/`pngMeta.ts`) — a rich PNG re-imports as a live board; slim = pixels. Copy-as-PNG pairs `image/png` + `text/plain` board payload and **falls back to download** (insecure origin / partial Firefox / denied permission) — keep the fallback. Global capture-phase `dragover`: `.drawlib` → library merge, board file → new drawing, image on sidebar → background.

## Tests & gotchas
- `src/lib/drawings.test.ts` — pure ops + storage round-trip. `src/sketchbook.browser.test.ts` — the Playwright suite (bulk of real coverage; own vite server on pid-derived port, isolated cache dir, no watch): SVG-export styles, z-order paint law, text kerning/wrap parity (ASCII + Cyrillic), glue previews, bond-aware text growth, rich-PNG round-trip. `vitest.config.ts` excludes `*.browser.test.ts` — Playwright owns them.
- Storage keys are unscoped — two instances on one origin share them.
- Hover thumbnails: `renderDocThumbnail` into a fixed-position popover (fixed = escapes the sidebar's scroll clip).
- `watchWorkspacePackages()` (root `vite.watchPackages.ts`) in plugins — `draw-board` is out-of-root source and lands replace files wholesale; per-file watches go deaf, dir-level keeps HMR alive.

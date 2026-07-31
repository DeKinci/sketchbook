# Sketchbook (`@operator/sketchbook`)

A standalone drawings app: a sidebar of named boards, each embedding `@operator/draw-board`. **No server, no API, no auth** — everything persists to `localStorage`. It exists for two reasons: it's a useful scratch surface, and it's the honest test of whether `draw-board` is genuinely host-agnostic (a second host with entirely different persistence, chrome and lifecycle from `apps/web`). See the root `CLAUDE.md` for monorepo-wide rules.

## Commands
- Dev: `pnpm --filter @operator/sketchbook dev`
- Build / preview: `pnpm --filter @operator/sketchbook build` · `… preview`
- Typecheck: `pnpm --filter @operator/sketchbook typecheck`
- Unit tests (vitest, jsdom): `pnpm --filter @operator/sketchbook test`
- **Real-browser tests: `pnpm --filter @operator/sketchbook test:browser`** (= `pnpm exec playwright test`; also the second half of the root `pnpm test:browser`)

Both test scripts pass `NODE_OPTIONS=--no-experimental-webstorage` — Node's experimental `localStorage` global otherwise **shadows jsdom's real store** and every persistence test goes quiet-green against a store nothing reads. `src/lib/drawings.ts` reaches `window.localStorage` explicitly rather than the bare global for the same reason. Don't drop either.

## Port wiring
`vite.config.ts` resolves, in order: `OPERATOR_WEB_PORT` → `SKETCHBOOK_PORT` → `OPERATOR_DEV_PORT_BASE + 1` → `5199`.

The first entry is load-bearing and the comment in the file spells out why: Operator guesses a run's preview URL on `OPERATOR_WEB_PORT`, so a frontend dev server **must** bind it or its URL is classified as an off-web-port backend URL, hidden, and the preview never routes. **Never bind `OPERATOR_SERVICE_SKETCHBOOK_PORT`** — that's the service's *backend* port for cross-service discovery (`= OPERATOR_PORT`, one below the web port); binding it is exactly what once made the preview read as "forbidden". `allowedHosts: [".ts.net"]` keeps the dev server reachable at its Tailscale Serve origin.

The devtools overlay needs no wiring here — Operator's preview proxy injects it into every tracked run.

## Structure
- `src/App.tsx` — the shell: drawings list, active drawing, rename state, library state, toasts, and the `DrawEditor` mount.
- `src/lib/drawings.ts` — pure list ops (`createDrawing`, `renameDrawing`, `updateDoc`, `updateSession`, `importDrawing`, `displayOrder`, `nextName`) **plus** the `localStorage` I/O. Key: `sketchbook:drawings`.
- `src/lib/library.ts` — the element library (entries + open flag), **shared across every drawing**, not per-board. Key: `sketchbook:library`.
- `src/ExportCluster.tsx` — the toolbar export controls, injected into the board via `toolbarExtra`.

A `Drawing` is `{ id, name, doc, createdAt, session? }`. `doc` is `draw-board`'s `DrawDoc`; `session` is the board's toolbar/selection state, optional so records written before it existed still load. **There is no schema version and no migration path** — loaders defensively filter records missing `id`/`doc` and treat corrupt JSON as empty. If you change the stored shape, that guard is the entire safety net; add a version key rather than widening the filter.

## What the board gets injected
`<DrawEditor>` receives `doc`/`onChange`, `session`/`onSessionChange`, `features` (parsed once from the URL by `featuresFromUrl()`), `onNotify` (the toast host), `library`, `boardRef`, `toolbarExtra`, `onImportBoard`, and `autoFocus`. Two subtleties:
- `key={active.id}` forces a **full remount** when the active drawing changes — no React reuse across boards. Session state survives only because it round-trips through `onSessionChange`.
- `autoFocus={renamingId === null}`. A freshly created drawing opens in rename mode, and the board would otherwise steal the first keystrokes out of the rename input.

Mutations route through a `useRef`'d callback so the board's **unmount flush** (which runs after the render that owned its `onChange`) still lands. Nothing is explicitly saved — there is no save button and no revert.

## Import / export
Rich PNG and rich SVG embed the full document (`draw-board`'s `boardFile.ts`/`pngMeta.ts`), so an exported rich PNG drops back in as a live board; slim variants are pixels only. Copy-as-PNG writes a `ClipboardItem` pairing `image/png` with the `text/plain` board payload and **falls back to download** when the clipboard is unavailable (insecure LAN origin, partial Firefox `ClipboardItem`, denied permission) — keep that fallback. Drops are handled by a global capture-phase `dragover`: `.drawlib` files merge into the library, board files import as a new drawing, and a plain image dropped on the sidebar becomes a new drawing's background.

## Tests
- `src/lib/drawings.test.ts` — the pure list ops and the `localStorage` round-trip (corrupt/absent → empty, name uniquing, newest-first `displayOrder`).
- `src/sketchbook.browser.test.ts` — the Playwright suite (~15 tests, the bulk of the app's real coverage; ~2m). It boots **its own** vite server on a pid-derived port with an isolated cache dir (`.vite-sketchbook-browser`) and inline Tailwind/PostCSS, no watch. It exercises what jsdom cannot prove: stroke styles reaching the SVG export, z-order paint law, text kerning/wrap parity between the edit overlay and the committed canvas (ASCII **and** Cyrillic), glue previews, bond-aware upward text growth, and the rich-PNG export → re-import loop.

`vitest.config.ts` excludes `**/*.browser.test.ts` by design — Playwright owns those. Don't pull them into the vitest run.

## Gotchas
- The two `localStorage` keys are unscoped. Two Operator instances served from the same origin share them.
- The URL feature harness (`?palette=N`, `&fills=0`, `&grouping=0`, `&shapes=pen,rect,text`, …) is read **once** at load; the board freezes its feature set at mount and nothing in the UI toggles it.
- Hover thumbnails render through `renderDocThumbnail` into a fixed-position popover — fixed positioning is what stops the sidebar's scroll container clipping it.
- `watchWorkspacePackages()` (root `vite.watchPackages.ts`) is in the plugin list because `@operator/draw-board` is imported as out-of-root source and every Operator land replaces files wholesale; per-file watches go deaf on that, dir-level coverage keeps HMR alive.

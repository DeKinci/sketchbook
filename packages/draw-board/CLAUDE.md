# Draw board (`@dorodango/draw-board`)

The standalone drawing/annotation board: a **pure reducer** over a document of shapes, a **pan/zoom camera**, and a Konva/`react-konva` rendering layer. Self-contained by design — it knows nothing about Operator, its server, or its board. Two hosts embed it: `apps/web` (the sketch viewport inside a task) and `apps/sketchbook` (the standalone drawings app). See the root `CLAUDE.md` for monorepo-wide rules.

**No build step.** `exports` points `.` straight at `src/index.ts` and `./theme` at `src/theme.ts`, so consumers resolve to source over `workspace:*` — same arrangement as `@dorodango/shared`. Everything React/Konva is a **peer** dependency (`konva >=10`, `react`/`react-dom` `>=18`, `react-konva >=18`, `lucide-react >=1`); the host owns those versions, this package never bundles them.

## Commands
- Typecheck: `pnpm --filter @dorodango/draw-board typecheck`
- Test: `pnpm --filter @dorodango/draw-board test` (vitest; 15 `*.test.ts` files next to the code)
- Coverage: `pnpm --filter @dorodango/draw-board coverage`

`vitest.config.ts` runs `environment: "node"` with `pool: "forks"` / `singleFork` — **deliberate, don't "upgrade" it**. The suite covers the PURE core (reducer, camera math, export geometry, PNG/SVG round-trips) with no DOM and no Konva; the comment records why single-fork (restricted-CPU sandboxes can resolve tinypool's `minThreads` above its computed `maxThreads` and kill the run before a test executes). Component behavior is proven elsewhere — `apps/web/src/components/drawViewport.browser.test.ts` and `apps/sketchbook/src/sketchbook.browser.test.ts` mount the real editor in a real browser.

## Hosts inject services — the package asks, never reaches
The board takes its capabilities as props rather than importing them, which is what keeps it embeddable in two very different shells:
- `onNotify` — how a refusal or status message reaches the user (each host wires its own toast).
- `imageToData` — the host's file→raster reader; a host may refuse a file here and report via `onNotify`.
- `features` (`DrawFeatures`) — which tools/palette/grouping/layers are enabled. **Frozen at mount**; there is no dynamic toggling.
- `library`, `session`/`onSessionChange`, `doc`/`onChange` — the host owns persistence; the board holds no storage of its own.

Theme is the same story: `@dorodango/draw-board/theme` exports `boardColors` (the `ink`/`accent` scales), and a host **must** extend its Tailwind theme with them *and* add `../../packages/draw-board/src/**/*.{ts,tsx}` to its `content` globs — otherwise the board renders unstyled because Tailwind never generates the utilities its components name.

## State model
`drawModel.ts` is the whole domain: the shape union (`BoxShape` rect/ellipse/diamond, `SegmentShape` line/arrow, `FreehandShape`, `TextShape`, `ImageShape`), the `DrawDoc` (`shapes`, `width`, `height`, optional raster `background`), and `drawReducer` — **pure and deterministic, no side effects**, with `past`/`future` undo stacks in `DrawState`. `useDrawing.ts` is a thin `useReducer` wrapper. Roughly 45 action kinds span tools, paint, style, selection, transform, path edit, gesture lifecycle, content and history.

Grouping is the subtle part and has its own design doc — **read `docs/groups-design.md` before touching it.** The short version: there are **no group objects**. Each shape carries a root-first `groupPath` ancestry array; `unitIndex.ts` derives the unit graph from it. Glue (attach/bind) is **unit-grained**, not per-shape — the smallest dragged unit wins, one outward edge per unit. Edges that end up internal to a new group are stashed in a level-keyed `dormant` array and restored on ungroup. Selection normalizes to whole units except under deep-select (⌘-click), which permits only restricted edits (colour, width, text — never move/resize).

## Camera & hit-testing
`viewport.ts` is pure camera math over `Viewport { x, y, scale }` (`screen = logical * scale + offset`): `screenToLogical`/`logicalToScreen`, `zoomAt` (zoom about a fixed screen point), `panBy`, `fitScale`, `visibleLogicalRect`, `clampBounded`. Scale clamps to `[0.02, 40]`. Three policies: `infinite`, `bounded` (clamped to the doc box), `fixed` (no gestures, fit to container). `spatialIndex.ts` holds the bounding-box index behind marquee selection, attach detection and pointer hit-tests; `snapGuides.ts` the alignment guides.

## Keys live on the board's focused root — LAW
`DrawEditor.tsx` renders its root `<div ref={rootRef} tabIndex={0} onKeyDown onKeyUp>`; key **and paste** handlers hang there, never on `window` and never on the host's hotkey manager. Any pointer-down inside claims focus (the Konva canvas isn't focusable on its own), and opening the editor claims it too, so the first keystroke or paste lands on the board the user just opened. This is what lets `apps/web` run its own global hotkey dispatcher without the two fighting.

The only carve-outs are **transient-popover dismissal**, and they are scoped to a live popover: `DrawToolbar.tsx` registers capture-phase `document` `pointerdown`/`keydown` while a toolbar strip is open, and `LibraryPanel.tsx` a capture-phase `window` `keydown` while the panel is open. Both unregister on close. Don't grow that set — a new board shortcut belongs in `onKeyDown` on the root, and in `DRAW_KEYMAP` so hosts can list it.

`keymap.ts` publishes `DRAW_KEYMAP` purely so hosts can render the shortcut reference (`apps/web`'s `HotkeyList`). **It is documentation, not the dispatcher** — adding an entry there does not bind anything; the binding lives in `DrawEditor.tsx`'s `onKeyDown`, and the two must be kept in step by hand. Note `` ` `` is matched on `e.code`, not `e.key`, for macOS dead-key layouts.

## Export & serialization
- `boardFile.ts` — the round-trip: `exportBoardPng`/`exportBoardSvg`, `parseBoardFile`/`parseBoardPayload`, `readBoardDocFromPngBytes`. A **rich** PNG carries the full document inside a PNG text chunk (`pngMeta.ts`: `embedPngText`/`readPngText`, `BOARD_KEYWORD`), so a rich PNG re-imports as a live board while staying an ordinary image everywhere else. A **slim** export is pixels only.
- `svgExport.ts` / `svgRecolor.ts` — SVG round-trip and palette remapping of imported SVG fills/strokes.
- `exportPng.ts` — stage capture, content crop, export scale.
- `ghostPainter.ts` — off-screen rendering (`renderDocThumbnail`) with no Konva stage, which is how hosts draw list thumbnails.

## Gotchas
- **The reducer must stay pure.** Undo/redo, the browser test suites and the node-environment unit tests all depend on it; a stray `Date.now()`/`crypto` call inside an action handler breaks determinism. `newShapeId()` (`crypto.randomUUID`) is called by *callers*, not the reducer.
- The package is `private: true` and unversioned in practice — it is a workspace-internal package, not published. `packages/devtools` is the one publishable package here.
- Changing the exported types ripples into both hosts at once (they import source); `pnpm -r typecheck` is the check that catches it.

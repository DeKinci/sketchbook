# Draw board (`@dorodango/draw-board`)

The standalone drawing/annotation board: a **pure reducer** over a document of shapes, a **pan/zoom camera**, and a Konva/`react-konva` rendering layer. Self-contained by design — it knows nothing about Dorodango, its server, or its board. Two hosts embed it: `apps/web` (the sketch viewport inside a task) and `apps/sketchbook` (the standalone drawings app). See the root `CLAUDE.md` for monorepo-wide rules.

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

This law is about **keys**. `DrawCanvas.tsx` also holds three window listeners that are not keys and not dismissal — `mouseup`/`pointercancel`/`touchcancel`, the gesture terminators — and they answer a problem the root div cannot: see "A gesture must be able to end off-stage" below before deciding they are a violation.

`keymap.ts` publishes `DRAW_KEYMAP` purely so hosts can render the shortcut reference (`apps/web`'s `HotkeyList`). **It is documentation, not the dispatcher** — adding an entry there does not bind anything; the binding lives in `DrawEditor.tsx`'s `onKeyDown`, and the two must be kept in step by hand. Note `` ` `` is matched on `e.code`, not `e.key`, for macOS dead-key layouts.

## A gesture must be able to end off-stage
Konva binds every DOM listener on `Stage.content` (`_bindContentEvents`), so the stage hears only what lands ON it — and an ending that happens anywhere else did not, for a long time, happen at all. A release over the toolbar left the draft/marquee/group-move live and it **resumed** when the pointer came back with a button down; a `touchcancel` (a system takeover mid-pinch — edge swipe, scroll steal — which is never followed by a `touchend`) left `pinchRef` set forever, so every later single touch early-returned and the board stopped drawing until it remounted. `DrawCanvas.tsx` therefore registers `mouseup`/`pointercancel`/`touchcancel` on `window` for the lifetime of the canvas, funnelling all of them — plus unmount — through the one existing teardown, `settleGesture()`.

Three properties are load-bearing, and each is a thing that was tried and rejected:

- **Not pointer capture**, even though capture is this package's usual answer (`LibraryPanel.tsx:362` captures for its own tile drags). A board→library drop is *deliberately* finishable outside the stage: `LibraryPanel` consumes that `mouseup` as the drop (`onMoveGesture`'s `cancel()` snaps the shapes back), and capture retargets pointer **and compatibility mouse** events to the capture element, which would silently delete the feature. Konva's own `setPointerCapture` is internal bookkeeping that never calls the DOM API, so it settles nothing either.
- **Bubble phase, not capture phase** — the opposite of the popover carve-outs above, and for the opposite reason: those *steal* the event, this one only wants to know the gesture ended. The real target (the library panel, the host's chrome) handles it first; the canvas then cleans up whatever was left live.
- **`mouseup`, never `pointerup`.** The browser fires `pointerup` first, so a `pointerup` watcher settles — i.e. **commits** — a move drag before the panel's own `onMouseUp` can cancel it, and the shapes never snap back. Touch needs no `up` listener at all: a `touchend` is delivered to the element the touch started on, so it always reaches the stage.

Host-independence is preserved: the listeners never `preventDefault`/`stopPropagation`, no-op unless one of *this* board's gestures is live, and are removed on unmount (where they also run the finisher once more — the container collapsing to zero unmounts the canvas alone, and the editor that outlives it must not be left holding an open history gesture or a stale `camBusyRef`). Pinned by four tests in `apps/web/src/components/drawViewport.browser.test.ts` (freehand / marquee / group move re-entering **with a button held**, so the `buttons === 0` hover backstop in `onStageMove` cannot be what saves them, plus a `touchcancel` mid-pinch).

**The fourth teardown path — unmount mid-gesture — has no seam and is held by review alone; this was measured, not assumed** (`mto6ry4x`). `DrawEditor.tsx:1555` gates `<DrawCanvas>` on `avail && view && fontReady`, and the comment above frames a container collapsing to zero as what flips it — but none of the three ever goes falsy again once true: `avail` is `setAvail({w: el.clientWidth, h: el.clientHeight})` unconditionally, so a collapsed container yields `{w:0,h:0}`, a *truthy* object, not `null`; `camera` (the gesture policies' `view`) is set once and never reset; `fixed`'s `view` recomputes from `avail` every render but is equally never null once `avail` is set. Measured directly against the real editor in a real Chromium (both `infinite` and `fixed` policy, CSS height/width to `0` and `display: none`): the Konva stage and node count are unchanged before and after — `DrawCanvas` does not unmount. So there is no live path, and no way to *drive* one from outside the package (the browser harness's `__mount` remounts the whole editor, which is a different teardown already covered above), to exercise the unmount branch of `useEffect`'s cleanup (`endOutsideRef.current()` + `camBusyRef.current = false`) without either rewriting `DrawEditor`'s sizing logic for the sole purpose of a test seam or remounting the editor itself (which proves nothing about a live canvas ending mid-gesture under a host that stays mounted). Cutting a window into the package for this — a test-only prop or an exported internal — would be exactly the encapsulation hole this package is built to avoid (see "Hosts inject services" above). The cleanup call stays correct by inspection: it is the same `settleGesture`/`endOutside` teardown already exercised by the four pinned tests, invoked once more from the same `useEffect` return. If a future refactor of the effect drops the cleanup call, nothing but review will catch it.

## Export & serialization
- `boardFile.ts` — the round-trip: `exportBoardPng`/`exportBoardSvg`, `parseBoardFile`/`parseBoardPayload`, `readBoardDocFromPngBytes`. A **rich** PNG carries the full document inside a PNG text chunk (`pngMeta.ts`: `embedPngText`/`readPngText`, `BOARD_KEYWORD`), so a rich PNG re-imports as a live board while staying an ordinary image everywhere else. A **slim** export is pixels only.
- `svgExport.ts` / `svgRecolor.ts` — SVG round-trip and palette remapping of imported SVG fills/strokes.
- `exportPng.ts` — stage capture, content crop, export scale.
- `ghostPainter.ts` — off-screen rendering (`renderDocThumbnail`) with no Konva stage, which is how hosts draw list thumbnails.

## Gotchas
- **The reducer must stay pure.** Undo/redo, the browser test suites and the node-environment unit tests all depend on it; a stray `Date.now()`/`crypto` call inside an action handler breaks determinism. `newShapeId()` (`crypto.randomUUID`) is called by *callers*, not the reducer.
- The package is `private: true` and unversioned in practice — it is a workspace-internal package, not published. `packages/devtools` is the one publishable package here.
- Changing the exported types ripples into both hosts at once (they import source); `pnpm -r typecheck` is the check that catches it.

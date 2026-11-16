# Draw board (`markup-board`)

Pure-reducer shape doc + pan/zoom camera + Konva/`react-konva` rendering; self-contained. Hosts: `apps/web` + `apps/sketchbook`.

**No build step**: `exports` `.` → `src/index.ts`, `./theme` → `src/theme.ts` (consumers resolve to source). Peers: `konva >=10`, `react`/`react-dom` `>=18`, `react-konva >=18`, `lucide-react >=1` — the host owns versions.

## Commands
`pnpm --filter markup-board typecheck` · `test` (vitest; 15 `*.test.ts`) · `coverage`

`vitest.config.ts`: `environment: "node"`, `pool: "forks"`/`singleFork` — **deliberate, don't "upgrade"** (restricted-CPU sandboxes: tinypool `minThreads` > `maxThreads` kills runs). Pure core only; component behavior: `apps/web/src/components/drawViewport.browser.test.ts` + `apps/sketchbook/src/sketchbook.browser.test.ts`.

## Injected services (props, never imports)
`onNotify` (host toast), `imageToData` (file→raster; may refuse via `onNotify`), `features` (`DrawFeatures`, **frozen at mount**), `library`, `session`/`onSessionChange`, `doc`/`onChange` — the host owns persistence, the board holds none.

Theme: `boardColors` (`ink`/`accent`) from `markup-board/theme`; hosts MUST extend Tailwind with them AND add `../../packages/draw-board/src/**/*.{ts,tsx}` to `content` globs — else unstyled.

## State
`drawModel.ts` = the domain: `BoxShape` (rect/ellipse/diamond), `SegmentShape` (line/arrow), `FreehandShape`, `TextShape`, `ImageShape`; `DrawDoc` (`shapes`, `width`, `height`, optional raster `background`); `drawReducer` pure + deterministic, `past`/`future` undo in `DrawState`, ~45 action kinds. `useDrawing.ts` = thin `useReducer` wrapper.

Grouping — **read `docs/groups-design.md` first.** No group objects; shapes carry a root-first `groupPath`; `unitIndex.ts` derives units. Glue is unit-grained (smallest dragged unit wins; one outward edge per unit); edges internal to a new group stash in level-keyed `dormant`, restored on ungroup. Selection = whole units; deep-select (⌘-click) = colour/width/text only, never move/resize.

## Camera
`viewport.ts` = pure math over `Viewport {x, y, scale}` (`screen = logical*scale + offset`): `screenToLogical`/`logicalToScreen`, `zoomAt`, `panBy`, `fitScale`, `visibleLogicalRect`, `clampBounded`; scale `[0.02, 40]`; policies `infinite` / `bounded` (doc box) / `fixed` (no gestures, fit). `spatialIndex.ts` = bbox index (marquee/attach/hit-tests); `snapGuides.ts` = guides.

## Keys live on the board's focused root — LAW
`DrawEditor.tsx` root `<div ref={rootRef} tabIndex={0} onKeyDown onKeyUp>` — key AND paste handlers there, never on `window` or the host hotkey manager. Pointer-down inside or opening the editor claims focus (Konva canvas isn't focusable). Carve-outs (live-popover dismissal ONLY; don't grow): `DrawToolbar.tsx` capture `document` `pointerdown`/`keydown` while a strip is open; `LibraryPanel.tsx` capture `window` `keydown` while open; both unregister on close. New shortcuts: root `onKeyDown` + `DRAW_KEYMAP` (`keymap.ts` = docs, not dispatcher — `apps/web`'s `HotkeyList` renders it; binding = `DrawEditor.tsx` `onKeyDown`, kept in step by hand; `` ` `` matches `e.code` not `e.key` — macOS dead keys).

## Gestures must be able to end off-stage
Konva binds DOM listeners on `Stage.content` (`_bindContentEvents`) ⇒ the stage never hears an off-stage ending (off-stage release left gestures live/resuming; `touchcancel` — never followed by `touchend` — left `pinchRef` set, board dead till remount). `DrawCanvas.tsx` registers `mouseup`/`pointercancel`/`touchcancel` on `window` for the canvas lifetime; all — plus unmount — funnel through `settleGesture()`.
- **Not pointer capture** (though `LibraryPanel.tsx:362` captures its tile drags): board→library drops finish off-stage (`LibraryPanel` consumes the `mouseup` as the drop; `onMoveGesture` `cancel()` snaps shapes back); capture retargets pointer + compatibility mouse events ⇒ deletes the feature; Konva's `setPointerCapture` never touches the DOM API.
- **Bubble, not capture** — the real target handles first; the canvas only cleans up.
- **`mouseup`, never `pointerup`** — `pointerup` fires first, committing the drag before the panel's `onMouseUp` cancels; touch needs no `up` listener (`touchend` delivers to the start element).

Listeners never `preventDefault`/`stopPropagation`, no-op unless this board's gesture is live, removed on unmount (finisher runs once more). Pinned: 4 tests in `apps/web/src/components/drawViewport.browser.test.ts` (re-entry with button held — the `buttons === 0` backstop in `onStageMove` can't save — + `touchcancel` mid-pinch).

**Fourth path — unmount mid-gesture — no seam; review-held (measured, `mto6ry4x`).** `DrawEditor.tsx:1555` gates `<DrawCanvas>` on `avail && view && fontReady`; none goes falsy once true (collapsed container ⇒ truthy `{w:0,h:0}`) ⇒ never unmounts; a test seam = the encapsulation hole this package avoids. The `useEffect` cleanup (`endOutsideRef.current()` + `camBusyRef.current = false`) is the same settle teardown; only review catches a refactor dropping it.

## Export
- `boardFile.ts` — `exportBoardPng`/`exportBoardSvg`, `parseBoardFile`/`parseBoardPayload`, `readBoardDocFromPngBytes`; a rich PNG embeds the doc in a text chunk (`pngMeta.ts`: `embedPngText`/`readPngText`, `BOARD_KEYWORD`) ⇒ re-imports as a live board; slim = pixels only.
- `svgExport.ts`/`svgRecolor.ts` — SVG round-trip + palette remap; `exportPng.ts` — capture/crop/scale; `ghostPainter.ts` — off-screen `renderDocThumbnail` (list thumbnails, no stage).

## Gotchas
- **The reducer stays pure** — a stray `Date.now()`/`crypto` in a handler breaks determinism; `newShapeId()` (`crypto.randomUUID`) is called by CALLERS.
- `private: true`, workspace-internal, unpublished.
- Exported types ripple into both hosts (source imports) — `pnpm -r typecheck`.

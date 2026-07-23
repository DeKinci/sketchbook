/**
 * @operator/draw-board — the standalone drawing/annotation board.
 *
 * A self-contained React component set: an infinite-canvas (or bounded/fixed)
 * pan-zoom drawing surface over Konva, with a pure reducer model, PNG export,
 * and zero coupling to any host app. Keyboard shortcuts live on the board's
 * own focused root — the board never touches `window` listeners or a host
 * hotkey manager (host-level key arbitration belongs to the host).
 *
 * Requirements from the host:
 *  - `konva` / `react-konva` / `lucide-react` peer deps;
 *  - tailwind utilities for the `ink`/`accent` scales (see `./theme`) — feed
 *    them into the host's tailwind config and include this package's `src` in
 *    its `content` globs.
 */
export { DrawEditor, type BoardImageData, type BoardHandle } from "./DrawEditor.tsx";
export { DrawCanvas } from "./DrawCanvas.tsx";
export { DrawToolbar } from "./DrawToolbar.tsx";
export { CropLayer, type CropControl } from "./CropLayer.tsx";
export { Minimap } from "./Minimap.tsx";
export { useDrawing, newShapeId } from "./useDrawing.ts";
export { resolveSource, type DrawSource, type ResolvedSource } from "./resolveSource.ts";
export { DRAW_KEYMAP, type DrawShortcut } from "./keymap.ts";
export { contentCropLogical, exportScale, exportStagePng, sketchFileName } from "./exportPng.ts";
export { exportBoardPng, exportBoardSvg, parseBoardFile, parseBoardPayload, boardPayloadText, readBoardDocFromPngBytes, type BoardPngOptions } from "./boardFile.ts";
export { exportSvg, readSvgDoc, SVG_META_ID, type SvgExportOptions } from "./svgExport.ts";
export { BOARD_KEYWORD, embedPngText, readPngText, isPng } from "./pngMeta.ts";
export { paintShapeGhosts, renderDocThumbnail } from "./ghostPainter.ts";
export * from "./viewport.ts";
export * from "./drawModel.ts";
export * from "./libraryModel.ts";

import { useCallback, useEffect, useRef } from "react";
import { contentBounds, type Shape } from "./drawModel.ts";
import { paintShapeGhosts } from "./ghostPainter.ts";
import {
  fitView,
  logicalToScreen,
  padBox,
  screenToLogical,
  unionBox,
  visibleLogicalRect,
  type Box,
  type Size,
  type Viewport,
} from "./viewport.ts";

const MINI_W = 168;
const MINI_H = 112;
/** Matches the board's selection/viewport chrome hue. */
const VIEW_COLOR = "#8b5cf6";
/** Trailing throttle for ghost redraws — the overview may lag a beat; it must
 *  never cost per-frame O(n) during camera moves outside the content extent. */
const REDRAW_MS = 66;

/**
 * Schematic overview of the whole board: shape ghosts + the current viewport
 * rectangle, fitted to the union of the content bounds and the visible rect.
 * Pointer-down/drag centers the camera at the pointed spot (jump + pan in one
 * gesture) through the same functional camera funnel every other gesture uses,
 * so policy clamps apply for free.
 *
 * Ghosts render to a CANVAS with a trailing throttle: an SVG node per shape put
 * thousands of DOM elements in play on big boards, and remapping them cost every
 * camera frame. The viewport rectangle stays a live SVG overlay, and the
 * logical→minimap mapping is exposed as data attributes for tests. The world
 * mapping FREEZES while dragging (a moving camera grows/shifts the union rect,
 * which would warp the map under the pointer mid-drag).
 */
export function Minimap({
  shapes,
  view,
  board,
  onViewChange,
}: {
  shapes: Shape[];
  /** The board camera. */
  view: Viewport;
  /** Board container size in CSS px (the camera's screen space). */
  board: Size;
  onViewChange: (up: (v: Viewport) => Viewport) => void;
}) {
  const visible = visibleLogicalRect(view, board);
  const content = contentBounds(shapes);
  const union = content ? unionBox(content, visible) : visible;
  const liveWorld = padBox(union, Math.max(union.width, union.height) * 0.04);

  const dragWorld = useRef<Box | null>(null);
  const world = dragWorld.current ?? liveWorld;
  // logical → minimap px (fitView IS that mapping — the minimap is a tiny fixed
  // camera; minScale: 0 because a deep zoom-out's world legitimately needs a
  // scale below the human camera's floor — clamped, the map stops fitting).
  const m = fitView(world, { w: MINI_W, h: MINI_H }, { minScale: 0 });
  const mRef = useRef(m);
  mRef.current = m;
  const boardRef = useRef(board);
  boardRef.current = board;

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  // ── Ghost canvas (throttled trailing redraw) ────────────────────────────────
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const redrawTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drawGhosts = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    if (canvas.width !== MINI_W * dpr) canvas.width = MINI_W * dpr;
    if (canvas.height !== MINI_H * dpr) canvas.height = MINI_H * dpr;
    const mm = mRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MINI_W, MINI_H);
    ctx.translate(mm.x, mm.y);
    ctx.scale(mm.scale, mm.scale);
    ctx.lineWidth = 1 / mm.scale; // constant 1 screen px
    ctx.globalAlpha = 0.75;
    paintShapeGhosts(ctx, shapesRef.current);
  }, []);
  const scheduleRedraw = useCallback(() => {
    if (redrawTimer.current) return;
    redrawTimer.current = setTimeout(() => {
      redrawTimer.current = null;
      drawGhosts();
    }, REDRAW_MS);
  }, [drawGhosts]);
  useEffect(() => {
    scheduleRedraw();
  }, [shapes, m.x, m.y, m.scale, scheduleRedraw]);
  useEffect(() => {
    drawGhosts(); // first paint immediately
    return () => {
      if (redrawTimer.current) {
        clearTimeout(redrawTimer.current);
        // MUST null the ref: StrictMode's mount→cleanup→remount otherwise
        // leaves a dead timer id here, and every future scheduleRedraw
        // early-returns — the minimap paints once and never again (adds and
        // deletes silently stop appearing).
        redrawTimer.current = null;
      }
    };
    // deps deliberately partial — react-hooks/exhaustive-deps is not enabled (eslint.config.js)
  }, []);

  // ── Interaction ─────────────────────────────────────────────────────────────
  const centerCameraAt = useCallback(
    (clientX: number, clientY: number) => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      const pt = screenToLogical(mRef.current, { x: clientX - r.left, y: clientY - r.top });
      const b = boardRef.current;
      onViewChange((v) => ({ ...v, x: b.w / 2 - pt.x * v.scale, y: b.h / 2 - pt.y * v.scale }));
    },
    [onViewChange]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragging.current = true;
      dragWorld.current = liveWorld; // freeze the mapping for the whole gesture
      try {
        rootRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events carry no active pointer — capture is best-effort.
      }
      centerCameraAt(e.clientX, e.clientY);
    },
    [centerCameraAt, liveWorld]
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragging.current) centerCameraAt(e.clientX, e.clientY);
    },
    [centerCameraAt]
  );
  const onPointerUp = useCallback(() => {
    dragging.current = false;
    dragWorld.current = null;
  }, []);

  const vTopLeft = logicalToScreen(m, { x: visible.x, y: visible.y });

  return (
    <div
      ref={rootRef}
      data-minimap
      data-mx={m.x}
      data-my={m.y}
      data-mscale={m.scale}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="relative block cursor-pointer touch-none select-none"
      style={{ width: MINI_W, height: MINI_H }}
      role="img"
      aria-label="Board overview — click or drag to move the view"
    >
      <canvas ref={canvasRef} style={{ width: MINI_W, height: MINI_H, display: "block" }} />
      <svg width={MINI_W} height={MINI_H} className="pointer-events-none absolute inset-0">
        <rect
          data-minimap-view
          x={vTopLeft.x}
          y={vTopLeft.y}
          width={visible.width * m.scale}
          height={visible.height * m.scale}
          fill={`${VIEW_COLOR}22`}
          stroke={VIEW_COLOR}
          strokeWidth={1.5}
          rx={2}
        />
      </svg>
    </div>
  );
}

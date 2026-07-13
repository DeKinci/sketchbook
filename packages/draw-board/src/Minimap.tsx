import { useCallback, useMemo, useRef } from "react";
import { boundingBox, contentBounds, isContrastInk, type Shape } from "./drawModel.ts";
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
/** Ghost color for the adaptive contrast ink (the minimap has a fixed dark bg). */
const GHOST_INK = "#f5f5f5";
/** Matches the board's selection/viewport chrome hue. */
const VIEW_COLOR = "#8b5cf6";
/** Max points per pen ghost — the tiny render needs silhouettes, not fidelity. */
const PEN_GHOST_POINTS = 24;

/**
 * Schematic overview of the whole board: shape ghosts + the current viewport
 * rectangle, fitted to the union of the content bounds and the visible rect.
 * Pointer-down/drag centers the camera at the pointed spot (jump + pan in one
 * gesture) through the same functional camera funnel every other gesture uses,
 * so policy clamps apply for free.
 *
 * The world mapping is FROZEN while dragging (a moving camera grows/shifts the
 * union rect, which would warp the mapping under the pointer mid-drag).
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
  // logical → minimap px (fitView IS that mapping — the minimap is a tiny fixed camera).
  const m = fitView(world, { w: MINI_W, h: MINI_H });
  const mRef = useRef(m);
  mRef.current = m;
  const boardRef = useRef(board);
  boardRef.current = board;

  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  const centerCameraAt = useCallback(
    (clientX: number, clientY: number) => {
      const r = svgRef.current?.getBoundingClientRect();
      if (!r) return;
      const pt = screenToLogical(mRef.current, { x: clientX - r.left, y: clientY - r.top });
      const b = boardRef.current;
      onViewChange((v) => ({ ...v, x: b.w / 2 - pt.x * v.scale, y: b.h / 2 - pt.y * v.scale }));
    },
    [onViewChange]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragging.current = true;
      dragWorld.current = liveWorld; // freeze the mapping for the whole gesture
      svgRef.current?.setPointerCapture(e.pointerId);
      centerCameraAt(e.clientX, e.clientY);
    },
    [centerCameraAt, liveWorld]
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (dragging.current) centerCameraAt(e.clientX, e.clientY);
    },
    [centerCameraAt]
  );
  const onPointerUp = useCallback(() => {
    dragging.current = false;
    dragWorld.current = null;
  }, []);

  const mx = (x: number) => logicalToScreen(m, { x, y: 0 }).x;
  const my = (y: number) => logicalToScreen(m, { x: 0, y }).y;

  const ghost = (sh: Shape) => {
    const color = isContrastInk(sh.stroke) ? GHOST_INK : sh.stroke;
    if (sh.type === "line" || sh.type === "arrow") {
      const [x1, y1, x2, y2] = sh.points;
      return (
        <line key={sh.id} data-minimap-ghost x1={mx(x1)} y1={my(y1)} x2={mx(x2)} y2={my(y2)} stroke={color} strokeWidth={1} opacity={0.75} />
      );
    }
    if (sh.type === "pen") {
      const n = sh.points.length / 2;
      const step = Math.max(1, Math.ceil(n / PEN_GHOST_POINTS));
      const pts: string[] = [];
      for (let i = 0; i < n; i += step) pts.push(`${mx(sh.points[i * 2])},${my(sh.points[i * 2 + 1])}`);
      const last = (n - 1) * 2;
      pts.push(`${mx(sh.points[last])},${my(sh.points[last + 1])}`);
      return <polyline key={sh.id} data-minimap-ghost points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1} opacity={0.75} />;
    }
    const b = boundingBox(sh);
    const w = Math.max(2, b.width * m.scale);
    const h = Math.max(2, b.height * m.scale);
    if (sh.type === "ellipse") {
      return (
        <ellipse key={sh.id} data-minimap-ghost cx={mx(b.x) + w / 2} cy={my(b.y) + h / 2} rx={w / 2} ry={h / 2} fill="none" stroke={color} strokeWidth={1} opacity={0.75} />
      );
    }
    // rect / text / image → box silhouette (images filled faintly: they're area).
    return (
      <rect
        key={sh.id}
        data-minimap-ghost
        x={mx(b.x)}
        y={my(b.y)}
        width={w}
        height={h}
        fill={sh.type === "image" ? color : "none"}
        fillOpacity={sh.type === "image" ? 0.2 : undefined}
        stroke={color}
        strokeWidth={1}
        opacity={0.75}
      />
    );
  };

  // Ghosts cached on content + mapping. When the camera moves INSIDE the content
  // extent (the common navigation case) the world — and so `m` — is stable, and a
  // pan frame skips rebuilding N SVG nodes; only the viewport rect updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ghosts = useMemo(() => shapes.map(ghost), [shapes, m.x, m.y, m.scale]);

  const vTopLeft = logicalToScreen(m, { x: visible.x, y: visible.y });

  return (
    <svg
      ref={svgRef}
      data-minimap
      width={MINI_W}
      height={MINI_H}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="block cursor-pointer touch-none select-none"
      role="img"
      aria-label="Board overview — click or drag to move the view"
    >
      {ghosts}
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
  );
}

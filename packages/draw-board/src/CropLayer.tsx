import { useEffect, useRef, useState } from "react";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node.js";
import { Image as KonvaImage, Rect, Transformer } from "react-konva";
import type { ImageShape } from "./drawModel.ts";

/** Imperative surface the editor's OWN keyboard handler drives (Enter applies,
 *  Escape cancels). The board is a standalone component: its keys live on its
 *  focused root — never on window and never on an app-level hotkey manager — so
 *  crop keys are inert the moment focus leaves the board (the composer's Enter
 *  stays the composer's), and the board works in any host. */
export type CropControl = { apply: () => void; cancel: () => void };

const SELECT = "#8b5cf6";
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
type Box = { x: number; y: number; width: number; height: number };

/**
 * Google-Slides-style crop overlay for an image (rendered inside the stage while
 * cropping). Shows the FULL image dimmed; drag it to reposition the source under
 * a bright crop frame, drag the frame handles to trim. Enter / click-outside
 * applies, Escape cancels. Dragging the frame to cover the whole image uncrops.
 */
export function CropLayer({
  img,
  shape,
  cover,
  controlRef,
  onApply,
  onCancel,
}: {
  img: HTMLImageElement;
  shape: ImageShape;
  /** The LOGICAL rect the click-catcher must cover — the currently visible part
   *  of the board (the stage has a pan/zoom camera; stage px ≠ logical px). */
  cover: Box;
  /** Populated with the live {@link CropControl} while cropping. */
  controlRef?: React.MutableRefObject<CropControl | null>;
  onApply: (box: Box, crop?: Box) => void;
  onCancel: () => void;
}) {
  const natW = img.naturalWidth || 1;
  const natH = img.naturalHeight || 1;
  const crop0 = shape.crop ?? { x: 0, y: 0, width: natW, height: natH };
  // Display px per source px (independent per axis — Konva may stretch a box).
  const sx = shape.width / crop0.width;
  const sy = shape.height / crop0.height;
  const fullW = natW * sx;
  const fullH = natH * sy;

  const [imgPos, setImgPos] = useState({ x: shape.x - crop0.x * sx, y: shape.y - crop0.y * sy });
  const [frame, setFrame] = useState<Box>({ x: shape.x, y: shape.y, width: shape.width, height: shape.height });
  const imgPosRef = useRef(imgPos);
  imgPosRef.current = imgPos;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const rectRef = useRef<Konva.Rect>(null);
  const trRef = useRef<Konva.Transformer>(null);

  useEffect(() => {
    const tr = trRef.current;
    const node = rectRef.current;
    if (tr && node) {
      tr.nodes([node]);
      tr.getLayer()?.batchDraw();
    }
  }, []);

  const clampImg = (ip: { x: number; y: number }, f: Box) => ({
    x: clamp(ip.x, f.x + f.width - fullW, f.x),
    y: clamp(ip.y, f.y + f.height - fullH, f.y),
  });
  const clampFrame = (f: Box, ip: { x: number; y: number }): Box => {
    const width = Math.min(f.width, fullW);
    const height = Math.min(f.height, fullH);
    return { x: clamp(f.x, ip.x, ip.x + fullW - width), y: clamp(f.y, ip.y, ip.y + fullH - height), width, height };
  };
  const cropRegion = (f: Box, ip: { x: number; y: number }): Box => ({
    x: (f.x - ip.x) / sx,
    y: (f.y - ip.y) / sy,
    width: f.width / sx,
    height: f.height / sy,
  });

  const apply = () => {
    const f = frameRef.current;
    const cr = cropRegion(f, imgPosRef.current);
    // Snap to "full" (uncrop) when the frame covers essentially the whole image.
    const full = cr.x <= 0.5 && cr.y <= 0.5 && cr.width >= natW - 1 && cr.height >= natH - 1;
    onApply({ x: f.x, y: f.y, width: f.width, height: f.height }, full ? undefined : cr);
  };

  // Expose apply/cancel to the editor's focused-root keyboard handler (see
  // CropControl). Re-assigned every render so the closures stay live.
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = { apply, cancel: onCancel };
    return () => {
      controlRef.current = null;
    };
  });

  const cr = cropRegion(frame, imgPos);
  return (
    <>
      {/* Invisible click-catcher over the visible board — clicking outside the
          image applies the crop. (No darkening: the dimmed full image below
          already shows the trimmed-away area faintly, Slides-style.) */}
      <Rect x={cover.x} y={cover.y} width={cover.width} height={cover.height} fill="#000000" opacity={0.01} onMouseDown={apply} onTouchStart={apply} />
      {/* Full image, dimmed — drag to reposition the source under the frame. */}
      <KonvaImage
        image={img}
        x={imgPos.x}
        y={imgPos.y}
        width={fullW}
        height={fullH}
        opacity={0.4}
        draggable
        onDragMove={(e: KonvaEventObject<DragEvent>) => {
          const ip = clampImg({ x: e.target.x(), y: e.target.y() }, frameRef.current);
          e.target.position(ip);
          setImgPos(ip);
        }}
      />
      {/* Bright cropped region shown in the frame. */}
      <KonvaImage
        image={img}
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        crop={{ x: cr.x, y: cr.y, width: cr.width, height: cr.height }}
        listening={false}
      />
      {/* The crop frame (non-listening border; the Transformer's handles resize it,
          a drag inside falls through to the dimmed image → pan). */}
      <Rect
        ref={rectRef}
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        stroke={SELECT}
        strokeWidth={1}
        listening={false}
        onTransformEnd={(e: KonvaEventObject<Event>) => {
          const node = e.target;
          const scx = node.scaleX();
          const scy = node.scaleY();
          node.scaleX(1);
          node.scaleY(1);
          const f = clampFrame(
            { x: node.x(), y: node.y(), width: Math.max(8, node.width() * scx), height: Math.max(8, node.height() * scy) },
            imgPosRef.current
          );
          node.position({ x: f.x, y: f.y });
          node.width(f.width);
          node.height(f.height);
          setFrame(f);
        }}
      />
      <Transformer
        ref={trRef}
        rotateEnabled={false}
        borderStroke={SELECT}
        anchorStroke={SELECT}
        anchorSize={9}
        ignoreStroke
        boundBoxFunc={(oldB, newB) => (newB.width < 8 || newB.height < 8 ? oldB : newB)}
      />
    </>
  );
}

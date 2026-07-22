import type { Shape } from "./drawModel.ts";

/** Partition the render list into the STATIC layer (cacheable as one bitmap) and
 *  the DYNAMIC layer (repainted per frame). See DrawCanvas's "Gesture layer
 *  split" — this is the pure core, extracted so the invariants below are testable.
 *
 *  `ordered` MUST already be in paint order (paintOrder(renderShapes)) — the
 *  dynamic layer is a contiguous TAIL of it: everything from the LOWEST shape
 *  that must repaint per frame (selected, or restamped mid-gesture) up. The
 *  static layer paints below the dynamic one wholesale, so promoting only the
 *  hot shapes would RAISE them — a selected filled box used to hide the smaller
 *  shapes resting on it. With the tail rule, cross-layer stacking always equals
 *  paint order; selection and gestures never change what covers what.
 *
 *  Load-bearing invariant: a SELECTED shape always lands in the DYNAMIC layer,
 *  whether or not a content gesture is in flight. The Transformer lives in the
 *  dynamic layer, so its target must too — otherwise grabbing a resize handle
 *  dispatches `beginGesture`, which flips `contentGesture` and (previously) moved
 *  the just-attached node from the static layer into the dynamic one mid-drag.
 *  Recreating the target node in a different layer detaches the Transformer's
 *  live drag, so the shape never resizes. Keeping the selection dynamic while
 *  idle means the node's identity/layer doesn't jump when the gesture starts —
 *  and mid-gesture the cut only ever moves DOWN (the must-repaint set grows),
 *  so a shape already dynamic stays dynamic. */
export function splitGestureLayers(
  ordered: Shape[],
  opts: { contentGesture: boolean; baseSet: Set<Shape>; selected: Set<string> },
): { stat: Shape[]; dyn: Shape[] } {
  const { contentGesture, baseSet, selected } = opts;
  // During a gesture: new identity since gesture start → hot. Selected → hot.
  const hot = (sh: Shape) => selected.has(sh.id) || (contentGesture && !baseSet.has(sh));
  const cut = ordered.findIndex(hot);
  if (cut === -1) return { stat: ordered, dyn: [] };
  return { stat: ordered.slice(0, cut), dyn: ordered.slice(cut) };
}

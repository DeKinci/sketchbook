import type { Shape } from "./drawModel.ts";

/** Partition the render list into the STATIC layer (cacheable as one bitmap) and
 *  the DYNAMIC layer (repainted per frame). See DrawCanvas's "Gesture layer
 *  split" — this is the pure core, extracted so the invariant below is testable.
 *
 *  Load-bearing invariant: a SELECTED shape always lands in the DYNAMIC layer,
 *  whether or not a content gesture is in flight. The Transformer lives in the
 *  dynamic layer, so its target must too — otherwise grabbing a resize handle
 *  dispatches `beginGesture`, which flips `contentGesture` and (previously) moved
 *  the just-attached node from the static layer into the dynamic one mid-drag.
 *  Recreating the target node in a different layer detaches the Transformer's
 *  live drag, so the shape never resizes. Keeping the selection dynamic while
 *  idle means the node's identity/layer doesn't jump when the gesture starts. */
export function splitGestureLayers(
  renderShapes: Shape[],
  opts: { contentGesture: boolean; baseSet: Set<Shape>; selected: Set<string> },
): { stat: Shape[]; dyn: Shape[] } {
  const { contentGesture, baseSet, selected } = opts;
  const stat: Shape[] = [];
  const dyn: Shape[] = [];
  for (const sh of renderShapes) {
    // During a gesture: identity preserved since gesture start AND not selected →
    // static. Idle: everything not selected → static. Selected is always dynamic.
    const isStatic = (!contentGesture || baseSet.has(sh)) && !selected.has(sh.id);
    if (isStatic) stat.push(sh);
    else dyn.push(sh);
  }
  return { stat, dyn };
}

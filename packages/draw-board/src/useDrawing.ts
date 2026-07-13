import { useReducer, useCallback } from "react";
import { drawReducer, initialDrawState, type DrawDoc, type DrawState, type DrawAction } from "./drawModel.ts";

/** A stable unique id for a shape. `crypto.randomUUID` is available in every
 *  browser we target; ids are minted in the view (not the reducer) so the
 *  reducer stays pure/deterministic. */
export function newShapeId(): string {
  return crypto.randomUUID();
}

/**
 * Thin `useReducer` wrapper over the pure {@link drawReducer}. Keeps the model
 * and its dispatcher together while leaving all logic in the testable reducer.
 */
export function useDrawing(
  initial: DrawDoc | undefined,
  defaultColor: string
): {
  state: DrawState;
  dispatch: (a: DrawAction) => void;
} {
  const [state, dispatch] = useReducer(drawReducer, initial, (doc) => initialDrawState(doc, { color: defaultColor }));
  const stable = useCallback((a: DrawAction) => dispatch(a), []);
  return { state, dispatch: stable };
}

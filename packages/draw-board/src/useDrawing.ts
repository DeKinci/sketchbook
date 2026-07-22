import { useReducer, useCallback } from "react";
import { drawReducer, initialDrawState, type DrawDoc, type DrawFeatures, type DrawSession, type DrawState, type DrawAction } from "./drawModel.ts";

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
  defaultColor: string,
  /** Persisted toolbar + selection state restored ONCE at mount (see
   *  {@link DrawSession}); later prop changes are ignored — the live reducer
   *  state is the truth after that. */
  session?: DrawSession | null,
  /** Host board config, frozen at mount like the session (see {@link DrawFeatures}). */
  features?: Partial<DrawFeatures> | null
): {
  state: DrawState;
  dispatch: (a: DrawAction) => void;
} {
  const [state, dispatch] = useReducer(drawReducer, initial, (doc) => initialDrawState(doc, { color: defaultColor, session, features }));
  const stable = useCallback((a: DrawAction) => dispatch(a), []);
  return { state, dispatch: stable };
}

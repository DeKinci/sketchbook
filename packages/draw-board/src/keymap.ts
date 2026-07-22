/**
 * The board's keyboard shortcuts as DATA — the reference a host can render in
 * its own shortcut list (Operator's Settings → Shortcuts merges this).
 *
 * Dispatch does NOT read this table: the real handlers live on the board's
 * focused root in DrawEditor.tsx (`onKeyDown` + the paste listener), where the
 * condition-rich gating (mid-stroke, crop mode, camera policy) is hand-written.
 * When you add/change a key THERE, mirror it HERE — this file is deliberately
 * colocated so the diff reviewer sees both.
 *
 * `keys` use the mod/shift+key grammar (`mod` = ⌘ on macOS, Ctrl elsewhere) so
 * hosts can format them platform-aware; `keyLabel` overrides the chips where
 * per-pattern rendering would be noise.
 */

export type DrawShortcut = {
  keys: string[];
  description: string;
  /** Display override for the key chips (hosts show it verbatim). */
  keyLabel?: string;
};

export const DRAW_KEYMAP: DrawShortcut[] = [
  { keys: ["mod+z"], description: "Undo" },
  { keys: ["mod+shift+z"], description: "Redo" },
  { keys: ["mod+c"], description: "Copy selection" },
  { keys: ["mod+v"], description: "Paste (shapes, image, or text)" },
  { keys: ["mod+a"], description: "Select all" },
  { keys: ["mod+g"], description: "Group selection / ungroup a group" },
  { keys: ["1"], description: "Shape tool (again: rect ⇄ ellipse)" },
  { keys: ["2"], description: "Connector tool (again: line → arrow → double)" },
  { keys: ["3"], description: "Text tool" },
  { keys: ["4"], description: "Cycle stroke style (solid → dashed → dotted)" },
  { keys: ["tab"], description: "Toggle primary tool" },
  { keys: ["backspace", "delete"], description: "Delete selection / eraser" },
  { keys: ["-", "="], description: "Size down / up (keeps stepping past the 3 shown; scales a selected group or image)" },
  { keys: ["0"], description: "Size medium / natural — reset (the middle dot)" },
  { keys: ["`", "shift+`"], description: "Cycle color (⇧ backwards)" },
  { keys: ["space"], description: "Hold to pan" },
  { keys: ["mod+=", "mod+-"], description: "Zoom in / out (infinite canvas)" },
  { keys: ["mod+0"], description: "Fit content (infinite canvas)" },
  { keys: ["escape"], description: "Step back: tool → selection → close" },
  { keys: ["enter"], description: "While cropping: apply (Esc cancels)" },
];

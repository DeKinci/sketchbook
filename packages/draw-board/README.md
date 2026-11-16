# markup-board

A React drawing and annotation board on [Konva](https://konvajs.org/): freehand, rectangles,
ellipses, diamonds, lines and arrows with glue, text, images, groups, an element library,
pan/zoom on an infinite (or bounded/fixed) canvas, undo/redo, and PNG/SVG export that can
embed the editable board so an exported image re-imports as a live drawing.

The model is a pure reducer (`drawReducer`) over a plain JSON `DrawDoc`; the board holds no
persistence of its own. You own storage through `onChange`.

See it running at [draw.mar.so](https://draw.mar.so) (the `sketchbook` app in
[this repository](https://github.com/DeKinci/sketchbook)).

## Install

```sh
npm install markup-board react react-dom konva react-konva lucide-react
```

`react`/`react-dom` ≥ 18, `konva` ≥ 10, `react-konva` ≥ 18 and `lucide-react` ≥ 1 are peer
dependencies — your app owns their versions. The package is ESM-only and ships TypeScript
declarations.

## Styling (Tailwind)

The components are styled with Tailwind utility classes over two colour scales, `ink` and
`accent`. Your Tailwind config must (1) scan the package's compiled files for class names
and (2) define those scales — `markup-board/theme` exports the defaults:

```ts
// tailwind.config.ts (Tailwind v3)
import type { Config } from "tailwindcss";
import { boardColors } from "markup-board/theme";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./node_modules/markup-board/dist/**/*.js"],
  theme: { extend: { colors: boardColors } },
} satisfies Config;
```

Supply your own values under the same `ink`/`accent` names to restyle the board.

## Usage

```tsx
import { useState } from "react";
import { DrawEditor, type DrawDoc } from "markup-board";

export function Sketch() {
  const [doc, setDoc] = useState<DrawDoc>({ shapes: [], width: 720, height: 460 });
  return (
    <div style={{ height: 600 }}>
      <DrawEditor doc={doc} bgImage={null} name="sketch" onChange={setDoc} />
    </div>
  );
}
```

`DrawEditor` fills its container. Useful props:

| Prop | Purpose |
|---|---|
| `doc` / `onChange` | The document, and its debounced live changes (flushed once on unmount). |
| `session` / `onSessionChange` | Toolbar and selection state, applied once at mount; store it next to the doc. |
| `features` | Capability config (palette width, fills, stroke styling, grouping). Frozen at mount. |
| `viewport` | `infinite`, `bounded` to the doc box, or `fixed` (default: `bounded` with a `bgImage`, else `infinite`). |
| `library` | An element library (`entries`, `onChange`, …) shared however the host likes. |
| `onSave` / `onCancel` | Show the "add as PNG" / discard buttons for attachment-style hosts. |
| `onNotify`, `imageToData` | Host toast and image-to-raster services. |
| `boardRef` | Imperative `BoardHandle` — export PNG/SVG, read the doc. |
| `toolbarExtra` | Your own nodes in the toolbar. |

Keyboard shortcuts are bound on the board's own focused element, never on `window`.
`markup-board/keymap` exports `DRAW_KEYMAP`, the list to show in a host's shortcut help.

## Files

- `exportBoardPng` / `exportBoardSvg` — export, optionally *rich* (the doc embedded).
- `parseBoardFile`, `readBoardDocFromPngBytes`, `readSvgDoc` — read a board back from an
  exported file.
- `renderDocThumbnail` — paint a doc off-screen for list thumbnails.

## Entry points

| Import | Contents |
|---|---|
| `markup-board` | Components, the model (`drawReducer`, `DrawDoc`, shapes), viewport math, import/export. |
| `markup-board/theme` | `boardColors`, `BOARD_INK`, `BOARD_ACCENT` — no React, safe in a Tailwind config. |
| `markup-board/keymap` | `DRAW_KEYMAP` — the shortcut list. |

## License

[MIT](./LICENSE)

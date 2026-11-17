# markup-board

## 0.2.0

### Minor Changes

- Drag line/arrow endpoints: a lone selected line, arrow or double arrow shows a round handle at each end. Dragging one re-aims that end and rebinds it to the shape it's dropped on (or unbinds it in empty space), as one undo step. New reducer action `moveEndpoint`.

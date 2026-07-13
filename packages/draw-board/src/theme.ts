/**
 * The color scales the board's components reference as tailwind utilities
 * (`bg-ink-800`, `text-accent-300`, …). A host app feeds these into its
 * tailwind config (`theme.extend.colors`) — or supplies its own values under
 * the same names to restyle the board. Values mirror Operator's graphite +
 * heather-violet palette so the board looks right out of the box.
 */
export const BOARD_INK = {
  900: "#100f0f",
  800: "#161615",
  700: "#1d1c1b",
  600: "#262524",
  500: "#343332",
  400: "#51504d",
  350: "#787672",
  300: "#a3a29e",
  200: "#cecdca",
  100: "#e9e8e7",
} as const;

export const BOARD_ACCENT = {
  100: "#e6def7",
  200: "#cdc0ed",
  300: "#af9cde",
  400: "#9880d0",
  500: "#8267c1",
  600: "#6b4db3",
  700: "#593e98",
  800: "#452f79",
  900: "#34225d",
} as const;

/** Drop-in `theme.extend.colors` fragment for a host tailwind config. */
export const boardColors = { ink: BOARD_INK, accent: BOARD_ACCENT };

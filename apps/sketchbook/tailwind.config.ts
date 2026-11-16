import type { Config } from "tailwindcss";
import { boardColors } from "markup-board/theme";

export default {
  // The board's components reference ink/accent utilities — its src must be in
  // the content globs and its scales in the theme.
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../packages/draw-board/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: boardColors,
    },
  },
  plugins: [],
} satisfies Config;

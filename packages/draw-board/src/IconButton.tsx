import { forwardRef, type ButtonHTMLAttributes } from "react";

/**
 * Square icon-only button with a consistent ≥28px hit area (icons alone are
 * too small a target for hour-long mousing). Ghost by default; `danger` tints
 * the hover red for destructive affordances (close/abort/delete).
 * `label` is mandatory — it is the accessible name AND the hover tooltip.
 */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: "ghost" | "danger";
  size?: "sm" | "md";
}

const VARIANT = {
  ghost: "text-ink-400 hover:bg-ink-600 hover:text-ink-100",
  danger: "text-ink-400 hover:bg-red-900/40 hover:text-red-300",
} as const;

const SIZE = { sm: "p-1", md: "p-1.5" } as const;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = "ghost", size = "md", className = "", type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    />
  );
});

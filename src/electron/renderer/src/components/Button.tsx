import type { ButtonHTMLAttributes, Ref } from "react";
import "./Button.scss";

type ButtonProps = {
  variant?: "default" | "primary" | "danger";
  // Fully-rounded (pill) shape — used by compact inline actions like the header's update button.
  pill?: boolean;
  size?: "default" | "small";
  // Works as a regular prop (React 19) — ConfirmPopover focuses its confirm button on open.
  ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>;

// The one <button> — header actions, modal actions, danger zone all use it, colored by variant.
export function Button({
  variant = "default",
  pill = false,
  size = "default",
  className,
  ...rest
}: ButtonProps) {
  const classes = [
    variant === "default" ? "" : variant,
    pill ? "pill" : "",
    size === "default" ? "" : size,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button type="button" className={classes || undefined} {...rest} />;
}

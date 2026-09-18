import type { ReactNode } from "react";

// Plain checkbox with a clickable label (the footer's Auto-scroll toggle, the timeout's Unlimited).
export function LabeledCheckbox({
  checked,
  disabled = false,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />{" "}
      {children}
    </label>
  );
}

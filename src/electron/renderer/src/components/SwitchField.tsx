import type { ReactNode } from "react";
import { ToggleSwitch } from "./ToggleSwitch";
import "./SwitchField.scss";

// Toggle row inside the modal — switch left, clickable label right.
export function SwitchField({
  id,
  label,
  checked,
  disabled = false,
  onChange,
}: {
  id: string;
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="field check">
      <ToggleSwitch id={id} checked={checked} disabled={disabled} onChange={onChange} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

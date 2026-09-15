import "./ToggleSwitch.scss";
// macOS-style toggle switch. Pass an id so an external <label htmlFor> can toggle it (device
// rows, the tray field).
export function ToggleSwitch({
  checked,
  onChange,
  id,
  disabled = false,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <span className={disabled ? "switch disabled" : "switch"}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="track" />
    </span>
  );
}

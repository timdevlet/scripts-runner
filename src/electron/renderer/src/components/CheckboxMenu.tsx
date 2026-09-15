import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "./icons";
import "./CheckboxMenu.scss";

// Multi-value dropdown: the same trigger-plus-floating-panel shape as SelectMenu, but every row
// toggles and the panel stays open so several choices can be made in one visit. Used for
// {{name:many(a|b|c)}} script params, where the stored value is the comma-joined selection.
//
// The trigger summarises rather than listing: a selection of five would otherwise stretch the
// field past its column. Nothing selected reads "None" — for these params that is a real answer
// ("no filter"), not an unfilled field.
export function CheckboxMenu({
  values,
  options,
  onValuesChange,
  ariaLabel,
  disabled = false,
  className,
}: {
  values: readonly string[];
  options: readonly string[];
  onValuesChange: (values: string[]) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape while open — same contract as SelectMenu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selected = new Set(values);
  // Toggling rebuilds from `options` rather than pushing onto `values`, so the stored order is
  // always the declared order however the user clicked them.
  const toggle = (option: string) => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onValuesChange(options.filter((o) => next.has(o)));
  };

  const label =
    selected.size === 0
      ? "None"
      : selected.size === options.length
        ? "All"
        : selected.size === 1
          ? values[0]
          : `${selected.size} selected`;

  return (
    <div ref={rootRef} className={["checkboxmenu", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="checkboxmenu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="checkboxmenu-value">{label}</span>
        <ChevronDownIcon size={16} className={open ? "chev open" : "chev"} />
      </button>
      {open && options.length > 0 && (
        <div className="checkboxmenu-panel" role="listbox" aria-multiselectable="true">
          {options.map((option) => {
            const checked = selected.has(option);
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={checked}
                className={checked ? "checkboxmenu-option selected" : "checkboxmenu-option"}
                onClick={() => toggle(option)}
              >
                <span className="checkboxmenu-tick">{checked && <CheckIcon />}</span>
                {option}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { anchoredPanelStyle, useAnchoredPanel } from "./useAnchoredPanel";
import "./ConfirmPopover.scss";

// A "are you sure?" step that opens next to the button that asked, rather than as a modal over the
// whole window. For a single destructive action in place — deleting the row you're looking at —
// keeping the question beside the trigger means the thing being deleted stays on screen.
//
// Renders its own trigger so the panel is positioned against it with no ref plumbing at the call
// site. Dismisses on outside click, on Escape, and after confirming; focus moves to the confirm
// button when it opens, so Enter completes and Escape cancels without touching the mouse.
//
// The panel goes in a portal at the end of <body>, positioned from the trigger's measured rect
// (useAnchoredPanel) rather than offset from it in CSS. Triggers here sit in the footer of a pane
// that clips its own overflow to keep scrolled content inside its rounded corners, and an
// absolutely-positioned panel is clipped along with it — going out to the body is what lets the
// panel be measured against the window instead, so it can flip or slide to stay fully visible.
export function ConfirmPopover({
  trigger,
  triggerVariant = "default",
  triggerClassName,
  disabled = false,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "danger",
  onConfirm,
  align = "end",
}: {
  trigger: ReactNode;
  triggerVariant?: "default" | "primary" | "danger";
  triggerClassName?: string;
  disabled?: boolean;
  title: string;
  // Optional second line — the consequence, when it isn't obvious from the title.
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "default" | "primary" | "danger";
  onConfirm: () => void;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const position = useAnchoredPanel({ open, onClose: close, rootRef, panelRef, align });

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  return (
    <span ref={rootRef} className="confirm-popover">
      <Button
        variant={triggerVariant}
        className={triggerClassName}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </Button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className={`confirm-panel${position ? ` placement-${position.placement}` : ""}`}
            role="dialog"
            aria-label={title}
            style={anchoredPanelStyle(position)}
          >
            <p className="confirm-title">{title}</p>
            {description && <p className="confirm-description">{description}</p>}
            <div className="confirm-actions">
              <Button onClick={close}>{cancelLabel}</Button>
              <Button
                ref={confirmRef}
                variant={confirmVariant}
                onClick={() => {
                  setOpen(false);
                  onConfirm();
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

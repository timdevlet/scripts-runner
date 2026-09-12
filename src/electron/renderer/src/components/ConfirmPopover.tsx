import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type PopoverPosition, placePopover } from "../lib/popoverPosition";
import { Button } from "./Button";
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
// (lib/popoverPosition) rather than offset from it in CSS. Triggers here sit in the footer of a
// pane that clips its own overflow to keep scrolled content inside its rounded corners, and an
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
  // Which edge of the trigger the panel prefers to line up with. A preference, not a guarantee:
  // whichever edge is asked for, the panel is shifted back inside the window if it would overflow.
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const reposition = useCallback(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;
    setPosition(
      placePopover({
        trigger: root.getBoundingClientRect(),
        panel: { width: panel.offsetWidth, height: panel.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        align,
        // Clear the fixed header the app draws over every view — it isn't part of the room a panel
        // has, and it paints under one (z-index 1 against the panel's 20).
        topMargin: 8 + headerHeight(),
      }),
    );
  }, [align]);

  // Measure before the browser paints, so the panel's first frame is already in place rather than
  // appearing at the top-left corner and jumping.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is no longer inside the trigger's subtree, so it needs testing separately —
      // otherwise mousedown on Confirm would unmount the button before its click landed.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Fixed to the viewport, the panel doesn't travel with a trigger that scrolls or a window that
    // resizes — capture, so a scroll inside any of the panes counts and not just the document's.
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);

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
            // First render is the measuring one: the panel has to be laid out to have a size, so
            // it's rendered where the flow puts it and hidden until the layout effect places it.
            style={
              position
                ? { top: position.top, left: position.left }
                : { top: 0, left: 0, visibility: "hidden" }
            }
          >
            <p className="confirm-title">{title}</p>
            {description && <p className="confirm-description">{description}</p>}
            <div className="confirm-actions">
              <Button onClick={() => setOpen(false)}>{cancelLabel}</Button>
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

// The header's height is a theme value (--header-height in global.scss), so read it from there
// rather than repeating the number here. Falls back to 0 if it's ever missing — the panel would
// then be free to overlap the header, which beats being pushed off-screen by a bad guess.
function headerHeight() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--header-height");
  return Number.parseFloat(value) || 0;
}

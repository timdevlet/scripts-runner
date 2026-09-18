import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { type PopoverPosition, placePopover } from "../lib/popoverPosition";

// The plumbing behind a panel that opens beside its trigger and is portalled to <body>: where to
// put it, and when to close it. Shared by ConfirmPopover and SecretPeek, which differ only in what
// the panel holds.
//
// The panel is measured against the trigger and the window (lib/popoverPosition) before the browser
// paints, so its first frame is already in place; it closes on an outside click or Escape and
// re-measures on resize and on any scroll, since a fixed panel doesn't travel with a trigger that
// scrolls away under it.
export function useAnchoredPanel({
  open,
  onClose,
  rootRef,
  panelRef,
  align,
}: {
  open: boolean;
  onClose: () => void;
  rootRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  // Which edge of the trigger the panel prefers to line up with. A preference, not a guarantee:
  // whichever edge is asked for, the panel is shifted back inside the window if it would overflow.
  align: "start" | "end";
}): PopoverPosition | null {
  const [position, setPosition] = useState<PopoverPosition | null>(null);

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
  }, [align, rootRef, panelRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is not inside the trigger's subtree, so it needs testing separately — otherwise
      // mousedown on a button in it would unmount the button before its click landed.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Capture, so a scroll inside any of the panes counts and not just the document's.
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [open, onClose, reposition, rootRef, panelRef]);

  return position;
}

// The header's height is a theme value (--header-height in global.scss), so read it from there
// rather than repeating the number here. Falls back to 0 if it's ever missing — the panel would
// then be free to overlap the header, which beats being pushed off-screen by a bad guess.
function headerHeight() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--header-height");
  return Number.parseFloat(value) || 0;
}

// The inline style a portalled panel renders with: placed once measured, and laid out but hidden
// on the measuring render before that, so it never flashes at the top-left corner.
export function anchoredPanelStyle(position: PopoverPosition | null) {
  return position
    ? { top: position.top, left: position.left }
    : { top: 0, left: 0, visibility: "hidden" as const };
}

// Where a floating panel goes, given the trigger it belongs to and the room around it. Pure
// arithmetic on rectangles so the decision is testable without a DOM: the component measures,
// this decides (see ConfirmPopover.tsx).
//
// Coordinates are viewport-relative throughout — what getBoundingClientRect returns and what
// `position: fixed` consumes — because a panel anchored this way has to escape its scroll
// container to avoid being clipped by it.

type PopoverBox = { top: number; left: number; width: number; height: number };

type PopoverSize = { width: number; height: number };

// "top" / "bottom" name the side of the trigger the panel sits on.
type PopoverPlacement = "top" | "bottom";

export type PopoverPosition = { top: number; left: number; placement: PopoverPlacement };

export function placePopover({
  trigger,
  panel,
  viewport,
  align = "end",
  gap = 8,
  margin = 8,
  // The app's header is fixed over the top of every view, so "inside the viewport" stops below it.
  topMargin = margin,
}: {
  trigger: PopoverBox;
  panel: PopoverSize;
  viewport: PopoverSize;
  // Which edge of the trigger the panel lines up with, before any shifting.
  align?: "start" | "end";
  // Between panel and trigger.
  gap?: number;
  // Between panel and viewport edge.
  margin?: number;
  topMargin?: number;
}): PopoverPosition {
  const roomAbove = trigger.top - gap - topMargin;
  const roomBelow = viewport.height - (trigger.top + trigger.height) - gap - margin;

  // Above by preference: a destructive action usually sits at the bottom of a panel, where the
  // room is. Flip under the trigger when the panel doesn't fit above — and when it fits neither
  // way, take the roomier side, where the clamp below cuts off the least.
  const placement: PopoverPlacement =
    panel.height <= roomAbove ? "top" : panel.height <= roomBelow ? "bottom" : "top";

  const anchoredTop =
    placement === "top" ? trigger.top - gap - panel.height : trigger.top + trigger.height + gap;
  const anchoredLeft = align === "end" ? trigger.left + trigger.width - panel.width : trigger.left;

  // Slide the panel back inside rather than let it hang off an edge — a panel that no longer lines
  // up with its trigger still reads; one that's half off-screen doesn't. Horizontally this is what
  // keeps an end-aligned popover on a narrow control from running past the window.
  const top = clamp(anchoredTop, topMargin, viewport.height - margin - panel.height);
  const left = clamp(anchoredLeft, margin, viewport.width - margin - panel.width);

  // Whole pixels: a panel on a half-pixel renders its text blurred.
  return { top: Math.round(top), left: Math.round(left), placement };
}

// Low bound wins when the two cross, i.e. when the panel is larger than the space left for it —
// then its start edge (title, and the label of the first action) is the part that stays visible.
function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(value, high));
}

import { describe, expect, it } from "vitest";
import { placePopover } from "../src/electron/renderer/src/lib/popoverPosition.js";

// A 700x500 window (the app's minimum) and a delete button in the bottom-right corner of it — the
// case ConfirmPopover was written for.
const viewport = { width: 700, height: 500 };
const panel = { width: 260, height: 120 };
const bottomRightTrigger = { top: 440, left: 560, width: 90, height: 30 };

describe("placePopover", () => {
  it("opens above the trigger when there is room, right edges lined up", () => {
    const at = placePopover({ trigger: bottomRightTrigger, panel, viewport });
    expect(at.placement).toBe("top");
    // 440 - 8 gap - 120 tall, and 560 + 90 - 260 wide for the end alignment.
    expect(at).toMatchObject({ top: 312, left: 390 });
  });

  it("lines up with the trigger's left edge when asked to align to the start", () => {
    // A trigger with room to its right, so the alignment is what decides the position.
    const trigger = { ...bottomRightTrigger, left: 100 };
    expect(placePopover({ trigger, panel, viewport, align: "start" }).left).toBe(100);
    expect(placePopover({ trigger, panel, viewport }).left).toBe(8); // end wanted 100 + 90 - 260
  });

  it("flips below the trigger when the space above is too short", () => {
    // 100px down the window: 120 of panel doesn't fit in the 92 above it, and there's ample below.
    const at = placePopover({
      trigger: { ...bottomRightTrigger, top: 100 },
      panel,
      viewport,
    });
    expect(at.placement).toBe("bottom");
    expect(at.top).toBe(138); // 100 + 30 tall + 8 gap
  });

  it("keeps clear of the fixed header rather than opening under it", () => {
    // Room above by the window's reckoning (60 > 44), but not once the header is excluded, so the
    // panel has to go below the trigger instead of behind the header.
    const trigger = { ...bottomRightTrigger, top: 200 };
    const short = { ...panel, height: 150 };
    expect(placePopover({ trigger, panel: short, viewport }).placement).toBe("top");
    expect(placePopover({ trigger, panel: short, viewport, topMargin: 8 + 44 }).placement).toBe(
      "bottom",
    );
  });

  it("shifts a start-aligned panel left so it does not run off the right edge", () => {
    // A 260-wide panel starting at the trigger's x=560 would end at 820, past the 700 window.
    const at = placePopover({ trigger: bottomRightTrigger, panel, viewport, align: "start" });
    expect(at.left).toBe(432); // 700 - 8 margin - 260 wide
  });

  it("shifts an end-aligned panel right so it does not run off the left edge", () => {
    const at = placePopover({
      trigger: { top: 440, left: 12, width: 90, height: 30 },
      panel,
      viewport,
    });
    expect(at.left).toBe(8); // end alignment wanted -158
  });

  it("takes the roomier side when the panel fits neither, and shows its top", () => {
    // Trigger mid-window in a window shorter than the panel: nowhere fits, so it clamps to the
    // top margin — the title and the first line of the question stay readable.
    const at = placePopover({
      trigger: { top: 120, left: 100, width: 90, height: 30 },
      panel: { width: 260, height: 400 },
      viewport: { width: 700, height: 300 },
      topMargin: 8 + 44,
    });
    expect(at.placement).toBe("top");
    expect(at.top).toBe(52);
  });

  it("rounds to whole pixels", () => {
    const at = placePopover({
      trigger: { top: 440.4, left: 560.6, width: 90.2, height: 30.5 },
      panel: { width: 260.3, height: 120.7 },
      viewport,
    });
    expect(at.top).toBe(Math.round(at.top));
    expect(at.left).toBe(Math.round(at.left));
  });
});

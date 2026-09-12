import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatDuration,
  formatWhen,
} from "../src/electron/renderer/src/lib/datetime.js";

// Locale-dependent formatting is only checked structurally (the tests must pass under any ICU
// locale); the branching logic is what's asserted exactly.

describe("formatDuration", () => {
  it("scales its precision with the magnitude", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(432)).toBe("0.4s");
    expect(formatDuration(2100)).toBe("2.1s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(3_840_000)).toBe("1h 04m");
  });

  it("never renders a negative duration", () => {
    expect(formatDuration(-500)).toBe("0.0s");
  });
});

describe("formatCountdown", () => {
  const now = Date.UTC(2024, 4, 10, 8, 0, 0);
  const inMs = (ms: number) => formatCountdown(now + ms, now);

  it("describes the lead time at a useful granularity", () => {
    expect(inMs(30_000)).toBe("in under a minute");
    expect(inMs(4 * 60_000)).toBe("in 4 min");
    expect(inMs(90 * 60_000)).toBe("in 2 h");
    expect(inMs(50 * 3_600_000)).toBe("in 2 days");
    expect(inMs(24 * 3_600_000)).toBe("in 1 day");
  });

  it("reads 'due' at or past the target", () => {
    expect(inMs(0)).toBe("due");
    expect(inMs(-60_000)).toBe("due");
  });
});

describe("formatWhen", () => {
  it("drops the date for today and keeps it otherwise", () => {
    const today = new Date(2024, 4, 10, 8, 0);
    const sameDay = formatWhen(new Date(2024, 4, 10, 14, 35).getTime(), today);
    const otherDay = formatWhen(new Date(2024, 4, 12, 14, 35).getTime(), today);
    expect(sameDay).toContain("14");
    expect(sameDay.length).toBeLessThan(otherDay.length);
  });
});

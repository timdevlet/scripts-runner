import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT_SECONDS,
  describeTimeout,
  formatClockDuration,
  MAX_TIMEOUT_SECONDS,
  normalizeTimeoutSeconds,
  parseClockDuration,
  UNLIMITED_TIMEOUT,
} from "../src/domain/duration.js";

describe("parseClockDuration", () => {
  it("reads the stopwatch forms", () => {
    expect(parseClockDuration("0:43")).toBe(43);
    expect(parseClockDuration("1:40")).toBe(100);
    expect(parseClockDuration("5:00")).toBe(300);
    expect(parseClockDuration("1:02:03")).toBe(3723);
  });

  it("reads a bare number as seconds", () => {
    expect(parseClockDuration("43")).toBe(43);
    expect(parseClockDuration("90")).toBe(90);
    expect(parseClockDuration("0")).toBe(0);
  });

  it("reads a single digit after the colon the way a stopwatch does", () => {
    expect(parseClockDuration("1:4")).toBe(64); // 1:04, not 1:40
  });

  it("leaves the leading unit unbounded so 90:00 is ninety minutes", () => {
    expect(parseClockDuration("90:00")).toBe(5400);
    expect(parseClockDuration("100:00:00")).toBe(360_000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseClockDuration("  1:40  ")).toBe(100);
  });

  it("rejects an out-of-range sub-unit rather than carrying it", () => {
    // "1:75" is a typo; reading it as 2:15 would silently set a different timeout.
    expect(parseClockDuration("1:75")).toBeNull();
    expect(parseClockDuration("1:60:00")).toBeNull();
    expect(parseClockDuration("1:00:60")).toBeNull();
  });

  it("rejects anything that isn't a duration", () => {
    for (const junk of ["", "  ", "abc", "1:", ":30", "1:2:3:4", "-5", "1.5", "5m", "1:-2"]) {
      expect(parseClockDuration(junk)).toBeNull();
    }
  });
});

describe("formatClockDuration", () => {
  it("renders m:ss below an hour and h:mm:ss above it", () => {
    expect(formatClockDuration(43)).toBe("0:43");
    expect(formatClockDuration(100)).toBe("1:40");
    expect(formatClockDuration(300)).toBe("5:00");
    expect(formatClockDuration(3600)).toBe("1:00:00");
    expect(formatClockDuration(3723)).toBe("1:02:03");
    expect(formatClockDuration(MAX_TIMEOUT_SECONDS)).toBe("24:00:00");
  });

  it("renders unlimited (and anything meaningless) as empty — the checkbox says it instead", () => {
    expect(formatClockDuration(0)).toBe("");
    expect(formatClockDuration(-1)).toBe("");
    expect(formatClockDuration(Number.NaN)).toBe("");
  });

  it("round-trips with the parser", () => {
    for (const seconds of [1, 43, 60, 100, 300, 3599, 3600, 3723, 86_400]) {
      expect(parseClockDuration(formatClockDuration(seconds))).toBe(seconds);
    }
  });
});

describe("normalizeTimeoutSeconds", () => {
  it("defaults to five minutes when nothing usable is stored", () => {
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(300);
    // A command written before the field existed inherits the default — NOT unlimited, which
    // would let a hung job run forever on an upgrade.
    expect(normalizeTimeoutSeconds(undefined)).toBe(300);
    expect(normalizeTimeoutSeconds(null)).toBe(300);
    expect(normalizeTimeoutSeconds("nonsense")).toBe(300);
    expect(normalizeTimeoutSeconds(-30)).toBe(300);
    expect(normalizeTimeoutSeconds({})).toBe(300);
  });

  it("keeps an explicit unlimited", () => {
    expect(normalizeTimeoutSeconds(0)).toBe(UNLIMITED_TIMEOUT);
    expect(normalizeTimeoutSeconds("0")).toBe(UNLIMITED_TIMEOUT);
  });

  it("keeps a real duration, rounding and accepting numeric strings", () => {
    expect(normalizeTimeoutSeconds(43)).toBe(43);
    expect(normalizeTimeoutSeconds("120")).toBe(120);
    expect(normalizeTimeoutSeconds(12.6)).toBe(13);
  });

  it("caps a huge value, because setTimeout overflows past ~24.8 days and fires instantly", () => {
    expect(normalizeTimeoutSeconds(999_999_999)).toBe(MAX_TIMEOUT_SECONDS);
    expect(MAX_TIMEOUT_SECONDS * 1000).toBeLessThan(2 ** 31 - 1);
  });
});

describe("describeTimeout", () => {
  it("names the limit, or says there isn't one", () => {
    expect(describeTimeout(300)).toBe("5:00");
    expect(describeTimeout(UNLIMITED_TIMEOUT)).toBe("no timeout");
  });
});

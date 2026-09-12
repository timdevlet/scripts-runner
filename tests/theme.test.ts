import { describe, expect, it } from "vitest";
import { normalizeTheme, THEME_PREFERENCES } from "../src/domain/theme.js";

describe("normalizeTheme", () => {
  it("keeps a known preference", () => {
    for (const theme of THEME_PREFERENCES) expect(normalizeTheme(theme)).toBe(theme);
  });

  it("falls back to dark for anything else", () => {
    expect(normalizeTheme(undefined)).toBe("dark");
    expect(normalizeTheme("sepia")).toBe("dark");
    expect(normalizeTheme(1)).toBe("dark");
  });
});

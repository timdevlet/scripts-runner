import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTE,
  formatRoute,
  parseRoute,
  type Route,
} from "../src/electron/renderer/src/lib/route.js";

describe("parseRoute", () => {
  it("reads the tab, the selection and the runs flag", () => {
    expect(parseRoute("#/scripts/abc/runs")).toEqual({ tab: "scripts", id: "abc", runs: true });
    expect(parseRoute("#/commands/abc")).toEqual({ tab: "commands", id: "abc", runs: false });
    expect(parseRoute("#/scripts")).toEqual({ tab: "scripts", id: null, runs: false });
  });

  it("reads the runs flag with nothing selected", () => {
    expect(parseRoute("#/commands/-/runs")).toEqual({ tab: "commands", id: null, runs: true });
  });

  it("carries no selection on the tabs that have none", () => {
    expect(parseRoute("#/logs/abc/runs")).toEqual({ tab: "logs", id: null, runs: false });
    expect(parseRoute("#/settings")).toEqual({ tab: "settings", id: null, runs: false });
  });

  // A hash is user-visible state, not trusted input: anything unreadable is the default route.
  it("falls back to the default for an empty or unknown hash", () => {
    expect(parseRoute("")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("#")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("#/nowhere/abc")).toEqual(DEFAULT_ROUTE);
  });

  it("survives a malformed percent-escape in the id", () => {
    expect(parseRoute("#/scripts/%E0%A4%A")).toEqual({ tab: "scripts", id: null, runs: false });
  });
});

describe("formatRoute", () => {
  const cases: Route[] = [
    { tab: "scripts", id: null, runs: false },
    { tab: "scripts", id: "a/b c", runs: false },
    { tab: "commands", id: "x", runs: true },
    { tab: "commands", id: null, runs: true },
    { tab: "settings", id: null, runs: false },
    { tab: "logs", id: null, runs: false },
  ];

  it.each(cases)("round-trips %o", (route) => {
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("drops selection state from the tabs that have none", () => {
    expect(formatRoute({ tab: "logs", id: "abc", runs: true })).toBe("#/logs");
  });
});

import { describe, expect, it } from "vitest";
import {
  compileJsScript,
  extractScriptParams,
  pruneParamValues,
  resolveParamValues,
  rewriteScriptSource,
  scriptParamsFilled,
} from "../src/domain/script-params.js";

describe("extractScriptParams", () => {
  it("collects {{name}} holes in the order they first appear", () => {
    expect(
      extractScriptParams("fs.readdirSync({{dir}}); keep({{dir}}); log({{pattern}});"),
    ).toEqual([
      { name: "dir", defaultValue: "" },
      { name: "pattern", defaultValue: "" },
    ]);
  });

  it("reads an optional default from {{name=value}}", () => {
    expect(extractScriptParams("readdir({{dir=/tmp}})").map((p) => p)).toEqual([
      { name: "dir", defaultValue: "/tmp" },
    ]);
  });

  it("fills in a default from a later hole of the same name", () => {
    expect(extractScriptParams("{{dir}} then {{dir=/var}}")).toEqual([
      { name: "dir", defaultValue: "/var" },
    ]);
  });

  it("also collects params.name references that have no hole", () => {
    expect(extractScriptParams("console.log(params.dir); {{pattern}}")).toEqual([
      { name: "pattern", defaultValue: "" },
      { name: "dir", defaultValue: "" },
    ]);
  });

  it("does not treat grouping parentheses as parameters", () => {
    expect(extractScriptParams("if (ok) fn(x);")).toEqual([]);
  });

  it("ignores malformed or empty holes", () => {
    expect(extractScriptParams("{{ }} {{1dir}} {{dir-name}}")).toEqual([]);
  });
});

describe("resolveParamValues / pruneParamValues / scriptParamsFilled", () => {
  const params = [
    { name: "dir", defaultValue: "/tmp" },
    { name: "pattern", defaultValue: "" },
  ];

  it("lets stored values win over defaults", () => {
    expect(resolveParamValues(params, { dir: "/home", pattern: "*.js" })).toEqual({
      dir: "/home",
      pattern: "*.js",
    });
  });

  it("falls back to the template default when a key is missing", () => {
    expect(resolveParamValues(params, {})).toEqual({ dir: "/tmp", pattern: "" });
  });

  it("treats an explicit empty stored value as a choice, not a missing key", () => {
    expect(resolveParamValues(params, { dir: "" })).toEqual({ dir: "", pattern: "" });
  });

  it("drops stored keys that are no longer in the source", () => {
    expect(pruneParamValues("{{dir}}", { dir: "/tmp", gone: "x" })).toEqual({ dir: "/tmp" });
  });

  it("counts a default as filling a param, but not a blank stored override", () => {
    expect(scriptParamsFilled("{{dir=/tmp}} {{pattern=*.js}}", {})).toBe(true);
    expect(scriptParamsFilled("{{dir}} {{pattern}}", { dir: "/tmp", pattern: "*" })).toBe(true);
    expect(scriptParamsFilled("{{dir=/tmp}}", { dir: "" })).toBe(false);
    expect(scriptParamsFilled("{{dir}}", {})).toBe(false);
    expect(scriptParamsFilled("console.log(1)", {})).toBe(true);
  });
});

describe("rewrite / compile", () => {
  it("turns every hole into a params.member expression, including ones with defaults", () => {
    expect(rewriteScriptSource("readdir({{dir=/tmp}}) + {{dir}}")).toBe(
      "readdir(params.dir) + params.dir",
    );
  });

  it("prepends a frozen params object built from stored values and defaults", () => {
    const compiled = compileJsScript("fs.readdirSync({{dir=/tmp}});", { dir: "/home" });
    expect(compiled.startsWith('const params = Object.freeze({"dir":"/home"});')).toBe(true);
    expect(compiled).toContain("fs.readdirSync(params.dir);");
  });

  it("JSON-encodes values so a quote or newline can't break out of the prelude", () => {
    const compiled = compileJsScript("use({{x}})", { x: 'a"b\n' });
    expect(compiled).toContain(JSON.stringify({ x: 'a"b\n' }));
    expect(compiled).toContain("use(params.x)");
  });
});

import { describe, expect, it } from "vitest";
import {
  compileJsScript,
  extractScriptParams,
  formatManyValue,
  isParamChecked,
  parseManyValue,
  pruneParamValues,
  resolveParamValues,
  rewriteScriptSource,
  type ScriptParam,
  type ScriptParamKind,
  scriptParamsFilled,
} from "../src/domain/script-params.js";

// The untyped shape, spelled once: a bare {{hole}} is a text param with no options.
const param = (
  name: string,
  defaultValue = "",
  kind: ScriptParamKind = "text",
  options: string[] = [],
): ScriptParam => ({ name, kind, options, defaultValue });

describe("extractScriptParams", () => {
  it("collects {{name}} holes in the order they first appear", () => {
    expect(
      extractScriptParams("fs.readdirSync({{dir}}); keep({{dir}}); log({{pattern}});"),
    ).toEqual([param("dir"), param("pattern")]);
  });

  it("reads an optional default from {{name=value}}", () => {
    expect(extractScriptParams("readdir({{dir=/tmp}})")).toEqual([param("dir", "/tmp")]);
  });

  it("fills in a default from a later hole of the same name", () => {
    expect(extractScriptParams("{{dir}} then {{dir=/var}}")).toEqual([param("dir", "/var")]);
  });

  it("also collects params.name references that have no hole", () => {
    expect(extractScriptParams("console.log(params.dir); {{pattern}}")).toEqual([
      param("pattern"),
      param("dir"),
    ]);
  });

  it("does not treat grouping parentheses as parameters", () => {
    expect(extractScriptParams("if (ok) fn(x);")).toEqual([]);
  });

  it("ignores malformed or empty holes", () => {
    expect(extractScriptParams("{{ }} {{1dir}} {{dir-name}}")).toEqual([]);
  });
});

describe("extractScriptParams: kinds", () => {
  it("reads the kind annotation and its option list", () => {
    expect(extractScriptParams("{{pick:one(first|random|largest)=random}}")).toEqual([
      param("pick", "random", "one", ["first", "random", "largest"]),
    ]);
    expect(extractScriptParams("{{styles:many(alternate|blurred)}}")).toEqual([
      param("styles", "", "many", ["alternate", "blurred"]),
    ]);
    expect(extractScriptParams("{{outDir:dir=/tmp/arts}}")).toEqual([
      param("outDir", "/tmp/arts", "dir"),
    ]);
  });

  it("normalizes a bool default to exactly true/false, and defaults it to false", () => {
    expect(extractScriptParams("{{apply:bool}}")).toEqual([param("apply", "false", "bool")]);
    expect(extractScriptParams("{{apply:bool=yes}}")).toEqual([param("apply", "true", "bool")]);
    expect(extractScriptParams("{{apply:bool=nope}}")).toEqual([param("apply", "false", "bool")]);
  });

  it("degrades an unrecognized kind to a text input rather than dropping the field", () => {
    expect(extractScriptParams("{{x:colour=red}}")).toEqual([param("x", "red")]);
  });

  it("trims and de-duplicates options, keeping declaration order", () => {
    expect(extractScriptParams("{{k:one( b | a |b| )}}")[0].options).toEqual(["b", "a"]);
  });

  it("lets a later hole supply the kind and options an earlier bare one lacked", () => {
    expect(extractScriptParams("{{pick}} … {{pick:one(a|b)=b}}")).toEqual([
      param("pick", "b", "one", ["a", "b"]),
    ]);
    // The default arrived before the kind did — it still ends up normalized as a bool.
    expect(extractScriptParams("{{ok=yes}} … {{ok:bool}}")).toEqual([param("ok", "true", "bool")]);
  });

  it("does not let params.name invent a kind", () => {
    expect(extractScriptParams("params.apply")).toEqual([param("apply")]);
  });
});

describe("bool and many value helpers", () => {
  it("reads the spellings a default might be written in", () => {
    for (const yes of ["true", "TRUE", " 1 ", "yes", "on"]) expect(isParamChecked(yes)).toBe(true);
    for (const no of ["false", "0", "", "no", "maybe"]) expect(isParamChecked(no)).toBe(false);
  });

  it("round-trips a comma-joined multi-select, dropping blanks and stray spaces", () => {
    expect(parseManyValue("a, b ,,c,")).toEqual(["a", "b", "c"]);
    expect(parseManyValue("")).toEqual([]);
    expect(formatManyValue(["a", "b"])).toBe("a,b");
    expect(formatManyValue([])).toBe("");
  });
});

describe("resolveParamValues / pruneParamValues / scriptParamsFilled", () => {
  const params = [param("dir", "/tmp"), param("pattern")];

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

  it("never blocks on a toggle or a checklist — off and none are answers, not blanks", () => {
    expect(scriptParamsFilled("{{apply:bool}}", {})).toBe(true);
    expect(scriptParamsFilled("{{apply:bool}}", { apply: "false" })).toBe(true);
    expect(scriptParamsFilled("{{styles:many(a|b)}}", { styles: "" })).toBe(true);
    // A dropdown with nothing chosen is still an unanswered question.
    expect(scriptParamsFilled("{{pick:one(a|b)}}", {})).toBe(false);
    expect(scriptParamsFilled("{{pick:one(a|b)=a}}", {})).toBe(true);
    expect(scriptParamsFilled("{{outDir:dir}}", {})).toBe(false);
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

  it("rewrites annotated holes the same way, and still hands the script plain strings", () => {
    expect(rewriteScriptSource("go({{pick:one(a|b)=a}}, {{on:bool=true}}, {{d:dir=/tmp}})")).toBe(
      "go(params.pick, params.on, params.d)",
    );
    const compiled = compileJsScript("go({{on:bool=true}}, {{styles:many(a|b)}})", {
      styles: "a,b",
    });
    expect(compiled.startsWith('const params = Object.freeze({"on":"true","styles":"a,b"});')).toBe(
      true,
    );
  });
});

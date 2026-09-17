import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_SECONDS } from "../src/domain/duration.js";
import {
  EXAMPLE_JS_SCRIPT,
  emptyJsScript,
  JS_SCRIPT_FILE_VERSION,
  type JsScript,
  jsScriptLabel,
  normalizeJsScripts,
  parseJsScriptFile,
  scriptFolderName,
  scriptFolderNames,
  serializeJsScriptFile,
} from "../src/domain/js-script.js";

const script = (over: Partial<JsScript> = {}): JsScript => ({
  id: "a",
  name: "List directory",
  source: "fs.readdirSync({{dir}})",
  paramValues: { dir: "/tmp" },
  cron: "0 2 * * *",
  enabled: true,
  cwd: "",
  timeoutSeconds: 300,
  ...over,
});

describe("normalizeJsScripts", () => {
  it("fills every field so the form inputs are always controlled", () => {
    expect(normalizeJsScripts([{ id: "a", source: "console.log(1)" }])).toEqual([
      {
        id: "a",
        name: "",
        source: "console.log(1)",
        paramValues: {},
        cron: "",
        enabled: false,
        cwd: "",
        timeoutSeconds: 300,
      },
    ]);
  });

  it("keeps a multi-line source and trims surrounding whitespace", () => {
    const [row] = normalizeJsScripts([
      { id: "a", name: "  List  ", source: "  import fs from 'node:fs'\n{{dir}}  ", cwd: " /tmp " },
    ]);
    expect(row.name).toBe("List");
    expect(row.source).toBe("import fs from 'node:fs'\n{{dir}}");
    expect(row.cwd).toBe("/tmp");
  });

  it("prunes param values that no longer appear in the source", () => {
    const [row] = normalizeJsScripts([
      { id: "a", source: "{{dir}}", paramValues: { dir: "/tmp", gone: "x", also: 1 } },
    ]);
    expect(row.paramValues).toEqual({ dir: "/tmp" });
  });

  it("drops non-string param values rather than leaking them through", () => {
    const [row] = normalizeJsScripts([
      { id: "a", source: "{{dir}} {{n}}", paramValues: { dir: "/tmp", n: 3 } },
    ]);
    expect(row.paramValues).toEqual({ dir: "/tmp" });
  });

  it("only ever enables on a strict true", () => {
    expect(normalizeJsScripts([{ id: "a", enabled: "yes" }])[0].enabled).toBe(false);
    expect(normalizeJsScripts([{ id: "a", enabled: true }])[0].enabled).toBe(true);
  });

  it("makes duplicate ids unique and mints missing ones", () => {
    const list = normalizeJsScripts([
      { source: "a" },
      { id: "same", source: "b" },
      { id: "same", source: "c" },
    ]);
    expect(list[0].id).toBe("script-1");
    expect(new Set(list.map((s) => s.id)).size).toBe(3);
    expect(list[1].id).toBe("same");
  });

  it("drops non-objects and non-arrays", () => {
    expect(normalizeJsScripts([null, "x", { id: "a" }])).toHaveLength(1);
    expect(normalizeJsScripts("garbage")).toEqual([]);
  });
});

describe("jsScriptLabel", () => {
  it("prefers the name, then a non-comment source line, then a placeholder", () => {
    expect(jsScriptLabel({ name: "List", source: "console.log(1)" })).toBe("List");
    expect(jsScriptLabel({ name: "  ", source: "// hi\nfs.readdirSync(params.dir)" })).toBe(
      "fs.readdirSync(params.dir)",
    );
    expect(jsScriptLabel({ name: "", source: "" })).toBe("Untitled script");
  });

  it("shortens a long source line so a row stays one line", () => {
    const label = jsScriptLabel({ name: "", source: "x".repeat(80) });
    expect(label).toHaveLength(41);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("the script file", () => {
  it("round-trips through serialize → JSON.parse → parseJsScriptFile", () => {
    const scripts = [script(), script({ id: "b", name: "Other", enabled: false })];
    const restored = parseJsScriptFile(JSON.parse(serializeJsScriptFile(scripts)));
    expect(restored).toEqual(scripts);
  });

  it("writes a versioned, pretty-printed file with a trailing newline", () => {
    const text = serializeJsScriptFile([script()]);
    expect(JSON.parse(text).version).toBe(JS_SCRIPT_FILE_VERSION);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "scripts": [');
  });

  it("also accepts a bare array, so a hand-written file still imports", () => {
    expect(parseJsScriptFile([{ id: "a", source: "1" }])).toHaveLength(1);
  });

  it("reads an empty or unrecognizable file as no scripts", () => {
    expect(parseJsScriptFile({})).toEqual([]);
    expect(parseJsScriptFile(null)).toEqual([]);
    expect(parseJsScriptFile("nope")).toEqual([]);
  });
});

describe("emptyJsScript", () => {
  it("starts disabled with the example template, so {{dir}} is already a field", () => {
    const row = emptyJsScript("x");
    expect(row).toMatchObject({
      id: "x",
      name: "",
      source: EXAMPLE_JS_SCRIPT,
      paramValues: {},
      cron: "",
      enabled: false,
      cwd: "",
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    });
    expect(row.source).toContain("{{dir}}");
  });
});

describe("scriptFolderName", () => {
  it("slugs the display name", () => {
    expect(scriptFolderName({ id: "x", name: "Steam BG to Wide Cover" })).toBe(
      "steam-bg-to-wide-cover",
    );
  });

  it("strips punctuation without leaving a trailing dash", () => {
    expect(scriptFolderName({ id: "x", name: "Baldur's Gate 3 — art!" })).toBe(
      "baldur-s-gate-3-art",
    );
  });

  it("falls back to the id for a name that would not survive slugging", () => {
    expect(scriptFolderName({ id: "abcdef1234", name: "" })).toBe("script-abcdef12");
    expect(scriptFolderName({ id: "abcdef1234", name: "///" })).toBe("script-abcdef12");
  });

  it("steps around names Windows will not give a folder", () => {
    expect(scriptFolderName({ id: "abcdef1234", name: "CON" })).toBe("script-abcdef12");
    expect(scriptFolderName({ id: "abcdef1234", name: "LPT1" })).toBe("script-abcdef12");
  });
});

describe("scriptFolderNames", () => {
  it("numbers duplicates in list order", () => {
    const names = scriptFolderNames([
      { id: "a", name: "Backup" },
      { id: "b", name: "Backup" },
      { id: "c", name: "Backup" },
    ]);
    expect([...names.values()]).toEqual(["backup", "backup-2", "backup-3"]);
  });

  it("steps around folders that belong to something else", () => {
    const names = scriptFolderNames([{ id: "a", name: "Backup" }], new Set(["backup"]));
    expect(names.get("a")).toBe("backup-2");
  });
});

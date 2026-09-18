import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_SECONDS } from "../src/domain/duration.js";
import type { JsScript } from "../src/domain/js-script.js";
import {
  defaultScriptsDir,
  legacyJsScriptsPath,
  loadJsScripts,
  migrateLegacyJsScripts,
  resolveScriptsDir,
  saveJsScripts,
} from "../src/js-script-store.js";

// The real filesystem: the point of this store is what it leaves on disk — one folder per script,
// a raw .js beside its config — and folder renames and deletions that a mock would not exercise.

let dir = "";

const script = (over: Partial<JsScript> = {}): JsScript => ({
  id: "id-1",
  name: "List directory",
  source: "fs.readdirSync({{dir}})",
  paramValues: { dir: "/tmp" },
  cron: "0 2 * * *",
  enabled: true,
  cwd: "",
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  ...over,
});

const read = (...parts: string[]): string => readFileSync(join(dir, ...parts), "utf8");
const config = (folder: string): Record<string, unknown> =>
  JSON.parse(read(folder, "script.json")) as Record<string, unknown>;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "js-script-store-")), "scripts");
  delete process.env.JS_SCRIPTS_DIR;
  delete process.env.JS_SCRIPTS_PATH;
});

afterEach(() => {
  rmSync(join(dir, ".."), { recursive: true, force: true });
  delete process.env.JS_SCRIPTS_DIR;
  delete process.env.JS_SCRIPTS_PATH;
});

describe("resolveScriptsDir", () => {
  it("falls back to the data dir when the setting is blank", () => {
    expect(resolveScriptsDir("")).toBe(defaultScriptsDir());
    expect(resolveScriptsDir("   ")).toBe(defaultScriptsDir());
  });

  it("lets JS_SCRIPTS_DIR override the setting", () => {
    process.env.JS_SCRIPTS_DIR = dir;
    expect(resolveScriptsDir("/somewhere/else")).toBe(dir);
  });

  it("makes a relative path absolute, so the folder can't move with the cwd", () => {
    expect(resolveScriptsDir("./my-scripts")).toBe(join(process.cwd(), "my-scripts"));
  });
});

describe("saveJsScripts", () => {
  it("writes one folder per script: the raw source beside its config", async () => {
    await saveJsScripts(dir, [script()]);

    expect(read("list-directory", "script.js")).toBe("fs.readdirSync({{dir}})\n");
    expect(config("list-directory")).toEqual({
      version: 1,
      id: "id-1",
      name: "List directory",
      order: 0,
      paramValues: { dir: "/tmp" },
      cron: "0 2 * * *",
      enabled: true,
      cwd: "",
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    });
  });

  it("names an untitled script's folder after its id, not its source", async () => {
    await saveJsScripts(dir, [script({ id: "abcdef1234", name: "" })]);
    expect(existsSync(join(dir, "script-abcdef12", "script.js"))).toBe(true);
  });

  it("gives two scripts with the same name distinct folders", async () => {
    await saveJsScripts(dir, [script({ id: "a" }), script({ id: "b" })]);
    expect(config("list-directory").id).toBe("a");
    expect(config("list-directory-2").id).toBe("b");
  });

  it("moves the folder when a script is renamed, keeping its id", async () => {
    await saveJsScripts(dir, [script()]);
    await saveJsScripts(dir, [script({ name: "Tidy up" })]);

    expect(existsSync(join(dir, "list-directory"))).toBe(false);
    expect(config("tidy-up").id).toBe("id-1");
  });

  it("lets two scripts swap folder names in one save", async () => {
    await saveJsScripts(dir, [
      script({ id: "a", name: "Alpha" }),
      script({ id: "b", name: "Beta" }),
    ]);
    await saveJsScripts(dir, [
      script({ id: "a", name: "Beta" }),
      script({ id: "b", name: "Alpha" }),
    ]);

    expect(config("beta").id).toBe("a");
    expect(config("alpha").id).toBe("b");
  });

  it("deletes the folder of a script that is gone from the list", async () => {
    await saveJsScripts(dir, [script({ id: "a" }), script({ id: "b", name: "Other" })]);
    await saveJsScripts(dir, [script({ id: "a" })]);

    expect(existsSync(join(dir, "other"))).toBe(false);
    expect(existsSync(join(dir, "list-directory"))).toBe(true);
  });

  it("keeps a user's own files when the script that shared their folder is deleted", async () => {
    await saveJsScripts(dir, [script()]);
    writeFileSync(join(dir, "list-directory", "notes.md"), "mine", "utf8");
    await saveJsScripts(dir, []);

    expect(existsSync(join(dir, "list-directory", "script.js"))).toBe(false);
    expect(read("list-directory", "notes.md")).toBe("mine");
  });

  it("never touches a folder that is not one of its scripts", async () => {
    mkdirSync(join(dir, "list-directory"), { recursive: true });
    writeFileSync(join(dir, "list-directory", "README.md"), "not a script", "utf8");
    await saveJsScripts(dir, [script()]);

    // The name was taken by something we did not write, so the script steps around it.
    expect(read("list-directory", "README.md")).toBe("not a script");
    expect(config("list-directory-2").id).toBe("id-1");
  });
});

describe("loadJsScripts", () => {
  it("returns nothing for a directory that does not exist yet", async () => {
    await expect(loadJsScripts(join(dir, "nope"))).resolves.toEqual([]);
  });

  it("round-trips what was saved", async () => {
    const scripts = [script({ id: "a" }), script({ id: "b", name: "Other", enabled: false })];
    await saveJsScripts(dir, scripts);
    await expect(loadJsScripts(dir)).resolves.toEqual(scripts);
  });

  it("keeps the list in its own order rather than the directory's", async () => {
    await saveJsScripts(dir, [
      script({ id: "a", name: "Zebra" }),
      script({ id: "b", name: "Apple" }),
    ]);
    const loaded = await loadJsScripts(dir);
    expect(loaded.map((s) => s.name)).toEqual(["Zebra", "Apple"]);
  });

  it("ignores a folder with no config in it", async () => {
    await saveJsScripts(dir, [script()]);
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, "notes", "todo.txt"), "later", "utf8");

    await expect(loadJsScripts(dir)).resolves.toHaveLength(1);
  });

  it("reads a folder written by hand, source and all", async () => {
    mkdirSync(join(dir, "hand-made"), { recursive: true });
    writeFileSync(join(dir, "hand-made", "script.js"), "console.log(1)\n", "utf8");
    writeFileSync(join(dir, "hand-made", "script.json"), '{"name":"Hand made"}', "utf8");

    const [loaded] = await loadJsScripts(dir);
    // No id in the config, so the folder name is the identity — the script still loads.
    expect(loaded).toMatchObject({ id: "hand-made", name: "Hand made", source: "console.log(1)" });
  });

  it("keeps two folders that share an id as two scripts, across a save", async () => {
    for (const folder of ["first", "second"]) {
      mkdirSync(join(dir, folder), { recursive: true });
      writeFileSync(join(dir, folder, "script.js"), `// ${folder}\n`, "utf8");
      writeFileSync(
        join(dir, folder, "script.json"),
        JSON.stringify({ id: "same", name: folder }),
        "utf8",
      );
    }
    const loaded = await loadJsScripts(dir);
    expect(loaded.map((s) => s.id)).toEqual(["same", "same-2"]);

    // The save writes the twin's new id into ITS folder — not into a third one, which used to add
    // a script to the list on every load/save round.
    await saveJsScripts(dir, loaded);
    expect(config("second").id).toBe("same-2");
    expect(existsSync(join(dir, "second-2"))).toBe(false);
    await expect(loadJsScripts(dir)).resolves.toHaveLength(2);
  });

  it("saves a hand-made folder with no id back into that folder", async () => {
    mkdirSync(join(dir, "hand-made"), { recursive: true });
    writeFileSync(join(dir, "hand-made", "script.js"), "console.log(1)\n", "utf8");
    writeFileSync(join(dir, "hand-made", "script.json"), '{"name":"Hand made"}', "utf8");

    await saveJsScripts(dir, await loadJsScripts(dir));
    expect(config("hand-made").id).toBe("hand-made");
    expect(existsSync(join(dir, "hand-made-2"))).toBe(false);
  });

  it("refuses to read a directory holding a malformed config", async () => {
    await saveJsScripts(dir, [script()]);
    writeFileSync(join(dir, "list-directory", "script.json"), "{ not json", "utf8");

    // Loudly, so the tab goes read-only rather than autosaving a list with this script missing —
    // which would delete it from disk.
    await expect(loadJsScripts(dir)).rejects.toThrow();
  });
});

describe("migrateLegacyJsScripts", () => {
  const legacy = (): string => legacyJsScriptsPath();

  it("moves the old single file into folders and deletes it", async () => {
    process.env.JS_SCRIPTS_PATH = join(dir, "..", "js-scripts.json");
    writeFileSync(
      legacy(),
      JSON.stringify({ version: 1, scripts: [script(), script({ id: "id-2", name: "Second" })] }),
      "utf8",
    );

    await expect(migrateLegacyJsScripts(dir)).resolves.toBe(2);
    expect(existsSync(legacy())).toBe(false);
    const loaded = await loadJsScripts(dir);
    expect(loaded.map((s) => s.name)).toEqual(["List directory", "Second"]);
    expect(read("list-directory", "script.js")).toBe("fs.readdirSync({{dir}})\n");
  });

  it("does nothing when there is no old file", async () => {
    process.env.JS_SCRIPTS_PATH = join(dir, "..", "js-scripts.json");
    await expect(migrateLegacyJsScripts(dir)).resolves.toBe(0);
  });

  it("leaves the old file in place when it cannot be parsed", async () => {
    process.env.JS_SCRIPTS_PATH = join(dir, "..", "js-scripts.json");
    writeFileSync(legacy(), "{ not json", "utf8");

    await expect(migrateLegacyJsScripts(dir)).rejects.toThrow();
    expect(existsSync(legacy())).toBe(true);
  });
});

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editorCandidates, findVsCode, openInVsCode } from "../src/os/external-editor.js";

const isWindows = process.platform === "win32";
const binary = isWindows ? "code.cmd" : "code";

let temp: string | null = null;
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = null;
});

describe("editorCandidates", () => {
  it("looks in every PATH entry before falling back to the install locations", () => {
    const candidates = editorCandidates(["/one", "/two"].join(delimiter));

    expect(candidates.slice(0, 2)).toEqual([join("/one", binary), join("/two", binary)]);
    // The fallbacks are platform-specific, but there is always at least one and it isn't on PATH.
    expect(candidates.length).toBeGreaterThan(2);
    expect(candidates.slice(2).some((c) => c.startsWith("/one"))).toBe(false);
  });

  it("skips empty PATH entries", () => {
    const candidates = editorCandidates(["", "  ", "/one"].join(delimiter));

    expect(candidates[0]).toBe(join("/one", binary));
  });

  it("returns the install locations when PATH is empty", () => {
    expect(editorCandidates("")).toEqual(editorCandidates(""));
    expect(editorCandidates("").length).toBeGreaterThan(0);
  });
});

describe("findVsCode", () => {
  it("returns the first PATH entry that actually holds the launcher", () => {
    temp = mkdtempSync(join(tmpdir(), "external-editor-test-"));
    const empty = join(temp, "empty");
    const real = join(temp, "real");
    mkdirSync(empty);
    mkdirSync(real);
    const launcher = join(real, binary);
    writeFileSync(launcher, "", "utf8");
    if (!isWindows) chmodSync(launcher, 0o755);

    expect(findVsCode([empty, real].join(delimiter))).toBe(launcher);
  });

  it("ignores a directory that merely shares the launcher's name", () => {
    temp = mkdtempSync(join(tmpdir(), "external-editor-test-"));
    mkdirSync(join(temp, binary));

    // Nothing on this PATH is a file, so the answer comes from the install locations (or is null
    // on a machine without VS Code) — never the directory.
    expect(findVsCode(temp)).not.toBe(join(temp, binary));
  });
});

// A stand-in for the `code` launcher: records the arguments it was handed, then exits with the
// code the test asked for. Lets the real spawn / --wait / close plumbing run without opening an
// editor. POSIX only — the Windows path goes through cmd.exe and a .cmd shim instead.
function fakeLauncher(dir: string, exitCode: number): string {
  const script = join(dir, binary);
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\nexit ${exitCode}\n`,
  );
  chmodSync(script, 0o755);
  return script;
}

describe.skipIf(isWindows)("openInVsCode", () => {
  it("runs the launcher with --wait and resolves when it exits", async () => {
    temp = mkdtempSync(join(tmpdir(), "external-editor-test-"));
    fakeLauncher(temp, 0);
    const file = join(temp, "script.js");
    writeFileSync(file, "", "utf8");

    const session = openInVsCode(file, temp);

    expect(session).not.toHaveProperty("error");
    expect(await (session as { closed: Promise<string | null> }).closed).toBeNull();
    expect(readFileSync(join(temp, "args"), "utf8")).toBe(`--wait\n${file}\n`);
  });

  it("reports a launcher that exits badly instead of hanging the session open", async () => {
    temp = mkdtempSync(join(tmpdir(), "external-editor-test-"));
    fakeLauncher(temp, 3);

    const session = openInVsCode(join(temp, "script.js"), temp);

    expect(await (session as { closed: Promise<string | null> }).closed).toBe(
      "VS Code exited with code 3.",
    );
  });
});

// Note: there is deliberately no test for the "VS Code isn't installed" branch. openInVsCode
// falls back to the install locations, so on a machine that HAS VS Code any such test would
// launch the real editor. createEditSessions covers that branch instead, by injecting the
// failure (see tests/edit-sessions.test.ts).

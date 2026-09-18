import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditSessions, type EditSessions } from "../src/os/edit-sessions.js";
import type { EditorSession } from "../src/os/external-editor.js";

// These use the real filesystem and a real fs.watch — the point is that a save in an editor
// actually reaches onSource, which is the whole feature. Only the editor launch is faked.

// Watch events are OS-scheduled, so waiting on a condition beats waiting a fixed time.
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a watch event");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// A stand-in editor: records what it was asked to open, and lets the test decide when the "tab"
// is closed.
function fakeEditor() {
  const opened: string[] = [];
  let close: (error: string | null) => void = () => {};
  return {
    opened,
    closeWith: (error: string | null) => close(error),
    open: (file: string): EditorSession => {
      opened.push(file);
      return { closed: new Promise<string | null>((resolve) => (close = resolve)) };
    },
  };
}

function setup(overrides: Partial<Parameters<typeof createEditSessions>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "edit-sessions-test-"));
  const editor = fakeEditor();
  const sources: { id: string; source: string }[] = [];
  const states: { id: string; open: boolean }[] = [];
  const errors: string[] = [];
  const sessions = createEditSessions({
    dir,
    open: editor.open,
    onSource: (id, source) => sources.push({ id, source }),
    onState: (id, open) => states.push({ id, open }),
    onError: (message) => errors.push(message),
    coalesceMs: 10,
    ...overrides,
  });
  return { dir, editor, sources, states, errors, sessions };
}

let cleanup: { dir: string; sessions: EditSessions } | null = null;
afterEach(() => {
  cleanup?.sessions.dispose();
  if (cleanup) rmSync(cleanup.dir, { recursive: true, force: true });
  cleanup = null;
});

describe("createEditSessions", () => {
  it("writes the source to the named file and opens it", () => {
    const t = setup();
    cleanup = t;

    const result = t.sessions.open("s1", "hello.js", "console.log(1)\n");

    expect(result).toEqual({ ok: true, path: join(t.dir, "hello.js"), reopened: false });
    expect(readFileSync(join(t.dir, "hello.js"), "utf8")).toBe("console.log(1)\n");
    expect(t.editor.opened).toEqual([join(t.dir, "hello.js")]);
    expect(t.states).toEqual([{ id: "s1", open: true }]);
    expect(t.sessions.isOpen("s1")).toBe(true);
    expect(t.sessions.openIds()).toEqual(["s1"]);
  });

  it("reports a save in the editor as new source", async () => {
    const t = setup();
    cleanup = t;
    t.sessions.open("s1", "hello.js", "before\n");

    writeFileSync(join(t.dir, "hello.js"), "after\n", "utf8");

    await until(() => t.sources.length > 0);
    expect(t.sources).toEqual([{ id: "s1", source: "after\n" }]);
  });

  // Editors that save atomically write a sibling file and rename it over the original, which
  // destroys a watch on the file itself. Watching the directory is what survives that.
  it("survives an editor that saves by renaming a file into place", async () => {
    const t = setup();
    cleanup = t;
    t.sessions.open("s1", "hello.js", "before\n");

    writeFileSync(join(t.dir, "hello.js.tmp"), "renamed in\n", "utf8");
    renameSync(join(t.dir, "hello.js.tmp"), join(t.dir, "hello.js"));

    await until(() => t.sources.some((s) => s.source === "renamed in\n"));
  });

  it("ignores a write that changed nothing, including its own first one", async () => {
    const t = setup();
    cleanup = t;
    t.sessions.open("s1", "hello.js", "same\n");

    writeFileSync(join(t.dir, "hello.js"), "same\n", "utf8");
    await new Promise((r) => setTimeout(r, 120));

    expect(t.sources).toEqual([]);
  });

  it("only reports the file belonging to a session", async () => {
    const t = setup();
    cleanup = t;
    t.sessions.open("s1", "mine.js", "mine\n");

    writeFileSync(join(t.dir, "someone-elses.js"), "theirs\n", "utf8");
    writeFileSync(join(t.dir, "mine.js"), "changed\n", "utf8");

    await until(() => t.sources.length > 0);
    expect(t.sources).toEqual([{ id: "s1", source: "changed\n" }]);
  });

  it("reads one last time when the tab closes, then drops the file", async () => {
    const t = setup();
    cleanup = t;
    t.sessions.open("s1", "hello.js", "before\n");

    // A save landing in the same instant the editor exits must not be lost.
    writeFileSync(join(t.dir, "hello.js"), "last words\n", "utf8");
    t.editor.closeWith(null);

    await until(() => t.states.length === 2);
    expect(t.sources).toEqual([{ id: "s1", source: "last words\n" }]);
    expect(t.states[1]).toEqual({ id: "s1", open: false });
    expect(t.sessions.isOpen("s1")).toBe(false);
    expect(existsSync(join(t.dir, "hello.js"))).toBe(false);
  });

  it("reports a launcher failure and ends the session without reading the file", async () => {
    const t = setup();
    cleanup = t;
    t.sessions.open("s1", "hello.js", "before\n");

    writeFileSync(join(t.dir, "hello.js"), "never read\n", "utf8");
    t.editor.closeWith("VS Code exited with code 1.");

    await until(() => t.errors.length > 0);
    expect(t.errors).toEqual(["VS Code exited with code 1."]);
    expect(t.sources).toEqual([]);
    expect(t.sessions.isOpen("s1")).toBe(false);
  });

  it("re-opening keeps the file as it is rather than overwriting unsaved work", () => {
    const t = setup();
    cleanup = t;
    t.sessions.open("s1", "hello.js", "first\n");
    writeFileSync(join(t.dir, "hello.js"), "edited in the editor\n", "utf8");

    const again = t.sessions.open("s1", "hello.js", "first\n");

    expect(again).toEqual({ ok: true, path: join(t.dir, "hello.js"), reopened: true });
    expect(readFileSync(join(t.dir, "hello.js"), "utf8")).toBe("edited in the editor\n");
    // Re-launched (so the window comes forward) but not announced as a second session.
    expect(t.editor.opened).toHaveLength(2);
    expect(t.states).toEqual([{ id: "s1", open: true }]);
  });

  it("cleans up the file it wrote when the editor won't start", () => {
    const t = setup({ open: () => ({ error: "VS Code was not found." }) });
    cleanup = t;

    const result = t.sessions.open("s1", "hello.js", "source\n");

    expect(result).toEqual({ ok: false, error: "VS Code was not found." });
    expect(existsSync(join(t.dir, "hello.js"))).toBe(false);
    expect(t.states).toEqual([]);
  });

  it("dispose ends every session and leaves no temp files behind", () => {
    const t = setup();
    cleanup = t;
    t.sessions.open("s1", "one.js", "1\n");
    t.sessions.open("s2", "two.js", "2\n");

    t.sessions.dispose();

    expect(existsSync(join(t.dir, "one.js"))).toBe(false);
    expect(existsSync(join(t.dir, "two.js"))).toBe(false);
    expect(t.states.filter((s) => !s.open).map((s) => s.id)).toEqual(["s1", "s2"]);
  });
});

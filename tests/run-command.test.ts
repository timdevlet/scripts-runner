import { afterEach, describe, expect, it } from "vitest";
import {
  primeLoginShell,
  runShellCommand,
  setLoginShellPath,
  shellInvocation,
} from "../src/os/run-command.js";
import { extractPath, probeLoginShellPath } from "../src/os/shell-env.js";

// These actually spawn a shell — the point is that the real capture/exit/kill path works, since
// nothing else in the app exercises it. Every command used here is a shell builtin or coreutil.

const isWindows = process.platform === "win32";

// Collect a run's output and outcome.
async function run(command: string, cwd?: string) {
  const out: { stream: string; text: string }[] = [];
  const handle = runShellCommand(command, {
    cwd,
    onOutput: (stream, text) => out.push({ stream, text }),
  });
  const outcome = await handle.done;
  return { outcome, out, text: out.map((l) => l.text).join("\n") };
}

// Tests below toggle the module-level resolved PATH; always put it back.
afterEach(() => setLoginShellPath(null));

describe("shellInvocation", () => {
  it.skipIf(isWindows)("falls back to a LOGIN shell until the profile PATH is known", () => {
    // A GUI-launched app inherits a minimal PATH; -l sources the profile that puts node on it.
    setLoginShellPath(null);
    const { file, args } = shellInvocation("echo hi");
    expect(args).toEqual(["-lc", "echo hi"]);
    expect(file).toBeTruthy();
  });

  it.skipIf(isWindows)("drops the login flag once the profile PATH has been resolved", () => {
    // Re-sourcing the profile per run would print its banners into the run's captured output.
    setLoginShellPath("/opt/bin:/usr/bin");
    expect(shellInvocation("echo hi").args).toEqual(["-c", "echo hi"]);
  });

  it.skipIf(!isWindows)("uses cmd.exe /d /s /c on Windows", () => {
    const { file, args } = shellInvocation("echo hi");
    expect(args).toEqual(["/d", "/s", "/c", '"echo hi"']);
    expect(file.toLowerCase()).toContain("cmd");
  });

  it.skipIf(!isWindows)("wraps the command so cmd.exe sees embedded quotes verbatim", () => {
    // Without the wrapper (+ windowsVerbatimArguments) libuv escapes `"` as `\"`, which cmd.exe
    // does not understand — a quoted Windows path with spaces would arrive mangled.
    const command = 'node "C:\\My Scripts\\job.js"';
    expect(shellInvocation(command).args[3]).toBe(`"${command}"`);
  });

  it.skipIf(!isWindows)("actually runs a command containing quoted arguments", async () => {
    const { out } = await run('echo "hello world"');
    expect(out.map((l) => l.text).join("")).toContain("hello world");
  });
});

describe("the login-shell PATH probe", () => {
  it("reads the fenced value out of whatever else the profile printed", () => {
    const noisy = "nvm loaded\n__TVC_PATH_START__/opt/bin:/usr/bin__TVC_PATH_END__";
    expect(extractPath(noisy)).toBe("/opt/bin:/usr/bin");
  });

  it("returns null when the markers are missing or the value is empty", () => {
    expect(extractPath("just some banner output")).toBeNull();
    expect(extractPath("__TVC_PATH_START__  __TVC_PATH_END__")).toBeNull();
    expect(extractPath("__TVC_PATH_START__ no end marker")).toBeNull();
  });

  it.skipIf(isWindows || !process.env.SHELL)(
    "comes back with a real PATH from this shell",
    async () => {
      const resolved = await probeLoginShellPath();
      // A profile that fails outright is allowed to yield null — but if it answers, it's a PATH.
      if (resolved !== null) expect(resolved).toContain("/");
    },
    15_000,
  );

  it.skipIf(!isWindows)(
    "is a no-op on Windows, which already inherits the user's PATH",
    async () => {
      expect(await probeLoginShellPath()).toBeNull();
    },
  );

  it.skipIf(isWindows)(
    "makes later runs resolve the same commands without a login shell",
    async () => {
      setLoginShellPath(null);
      const resolved = await primeLoginShell();
      if (resolved === null) return; // no usable login shell here — the fallback path is tested above
      expect(shellInvocation("x").args[0]).toBe("-c");
      const out: string[] = [];
      const handle = runShellCommand("echo $PATH", { onOutput: (_s, text) => out.push(text) });
      await handle.done;
      expect(out.join("")).toBe(resolved);
    },
    15_000,
  );
});

describe("runShellCommand", () => {
  it("captures stdout line by line and reports a clean exit", async () => {
    const { outcome, out } = await run("echo first && echo second");
    expect(outcome.code).toBe(0);
    expect(outcome.error).toBeUndefined();
    expect(out.filter((l) => l.stream === "stdout").map((l) => l.text.trim())).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps stdout and stderr apart", async () => {
    const { out } = await run(isWindows ? "echo oops 1>&2" : "echo oops >&2");
    expect(out.some((l) => l.stream === "stderr" && l.text.includes("oops"))).toBe(true);
    expect(out.some((l) => l.stream === "stdout")).toBe(false);
  });

  it("reports the exit code of a failing command", async () => {
    const { outcome } = await run("exit 3");
    expect(outcome.code).toBe(3);
  });

  it.skipIf(isWindows)("emits a trailing line that never ended in a newline", async () => {
    const { out } = await run("printf 'no newline'");
    expect(out.map((l) => l.text)).toContain("no newline");
  });

  it.skipIf(isWindows)("runs in the requested working directory", async () => {
    const { text } = await run("pwd", "/tmp");
    // macOS resolves /tmp through a symlink to /private/tmp — match either.
    expect(text).toMatch(/\/tmp$/);
  });

  it("comes back with an error instead of hanging when the cwd doesn't exist", async () => {
    const { outcome } = await run("echo hi", "/definitely/not/a/real/directory");
    expect(outcome.error).toBeTruthy();
    expect(outcome.code).toBeNull();
  });

  it.skipIf(isWindows)(
    "kills the whole process group, not just the shell",
    async () => {
      const out: string[] = [];
      const handle = runShellCommand("sleep 30 & echo started; wait", {
        onOutput: (_stream, text) => out.push(text),
      });
      // Wait for the shell to have actually started the child before killing it.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (out.includes("started")) {
            clearInterval(check);
            resolve();
          }
        }, 20);
      });
      handle.kill();
      const outcome = await handle.done;
      // `done` resolving at all is the assertion: with only the shell killed, the inherited stdout
      // pipe would be held open by `sleep` and "close" would not fire for another 30 seconds.
      expect(outcome.signal ?? outcome.code).toBeTruthy();
    },
    15_000,
  );

  it.skipIf(isWindows)(
    "kills a command that outlives its timeout, and says so",
    async () => {
      const started = Date.now();
      const handle = runShellCommand("sleep 30", { timeoutMs: 400, onOutput: () => {} });
      const outcome = await handle.done;
      expect(outcome.timedOut).toBe(true);
      // It really was the timer, not the command finishing: `sleep 30` would take 30s.
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    15_000,
  );

  it.skipIf(isWindows)(
    "takes the whole tree with it on a timeout, not just the shell",
    async () => {
      const out: string[] = [];
      const handle = runShellCommand("sleep 30 & echo started; wait", {
        timeoutMs: 700,
        onOutput: (_stream, text) => out.push(text),
      });
      const outcome = await handle.done;
      // `done` resolving at all is the assertion: with the grandchild still holding the inherited
      // stdout pipe open, "close" would not fire for another 30 seconds.
      expect(outcome.timedOut).toBe(true);
      expect(out).toContain("started");
    },
    15_000,
  );

  it("leaves a command that finishes in time untouched", async () => {
    const { outcome } = await run("echo quick");
    expect(outcome.timedOut).toBeUndefined();
    expect(outcome.code).toBe(0);
  });

  it("treats timeoutMs 0 (Unlimited) as no timer at all", async () => {
    const handle = runShellCommand("echo hi", { timeoutMs: 0, onOutput: () => {} });
    const outcome = await handle.done;
    expect(outcome.timedOut).toBeUndefined();
    expect(outcome.code).toBe(0);
  });

  it("ignores a kill after the command has already finished", async () => {
    const handle = runShellCommand("echo done", { onOutput: () => {} });
    await handle.done;
    expect(() => handle.kill()).not.toThrow();
  });
});

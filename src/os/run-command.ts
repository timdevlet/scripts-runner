// Run one shell command line and stream its output back line by line. Used by the scheduler
// (src/scheduler.ts) for both the ▶ button and cron-fired runs.
//
// Two details that matter for "run my node script":
//
//  • The command resolves against the PATH a terminal would have, so `node`, `npm`, `python` and
//    friends are found even though a GUI-launched app inherits a minimal PATH. That PATH is read
//    out of the user's login shell ONCE at startup (see primeLoginShell / src/os/shell-env.ts) and
//    reused here; until then — or if the probe fails — each run falls back to a login shell of its
//    own, which resolves the same names but re-sources the profile (and prints whatever it prints)
//    every time.
//
//  • Stopping kills the whole process GROUP. The child we spawn is the shell, not the script; on
//    POSIX we start it as a group leader (detached) and signal the negated pid so the script dies
//    with it, and on Windows we hand the tree to taskkill.

import { spawn } from "node:child_process";
import { probeLoginShellPath } from "./shell-env.js";

export interface RunOutcome {
  // Exit code, or null when the process was killed by a signal or never started.
  code: number | null;
  signal: NodeJS.Signals | null;
  // Set only when the process could not be spawned at all (bad cwd, missing shell).
  error?: string;
  // True when the command's own time limit is what killed it, so the caller can report that
  // rather than a bare "stopped".
  timedOut?: boolean;
}

export interface RunHandle {
  // Terminate the command and everything it started. Safe to call more than once, and after exit.
  kill(): void;
  // Resolves once the process has exited AND its output streams have closed. Never rejects — a
  // spawn failure comes back as `error`.
  done: Promise<RunOutcome>;
}

interface RunOptions {
  // Working directory; "" / undefined runs in the app's own cwd.
  cwd?: string;
  // Kill the command (and its whole process tree) once it has run this long. 0 / undefined = no
  // limit. The outcome then carries timedOut.
  timeoutMs?: number;
  // Called once per complete output line, with the trailing newline stripped.
  onOutput: (stream: "stdout" | "stderr", text: string) => void;
  // Extra environment variables for the child, layered over the inherited environment. This is how
  // secrets reach a run (see src/domain/secrets.ts): the value never appears in the command line,
  // where `ps` and a shell quoting mistake could both expose it.
  env?: Record<string, string>;
}

const isWindows = process.platform === "win32";

// How long a killed process gets to exit on its own before it's killed outright (POSIX only —
// taskkill /F is already unconditional).
const KILL_GRACE_MS = 5000;

// The PATH read out of the user's login shell at startup, or null when that hasn't happened (or
// couldn't). Module state rather than a parameter because every caller wants the same answer and
// nobody should be able to run with a half-configured environment.
let loginShellPath: string | null = null;

// Read the login shell's PATH once, so runs afterwards don't need a login shell of their own.
// Awaited during scheduler startup; safe to call more than once. Never throws.
export async function primeLoginShell(): Promise<string | null> {
  loginShellPath ??= await probeLoginShellPath();
  return loginShellPath;
}

// Test seam: set (or clear, with null) the resolved PATH without spawning a shell.
export function setLoginShellPath(value: string | null): void {
  loginShellPath = value;
}

// The shell invocation for this platform. Exported for the unit tests, which assert the flags
// rather than actually spawning anything.
export function shellInvocation(command: string): { file: string; args: string[] } {
  if (isWindows) {
    // /d skips AutoRun, /s fixes quote handling, /c runs and exits. No login-shell equivalent is
    // needed: a Windows process already inherits the user's full PATH.
    //
    // The command is wrapped in its own quotes and spawned with windowsVerbatimArguments (see
    // runShellCommand) — the same pair Node applies for `shell: true`, and both halves are
    // required. Without them libuv MSVCRT-escapes the argument, turning every embedded `"` into
    // `\"`, which cmd.exe does not understand: `node "C:\My Scripts\job.js"` would reach it as
    // `node \"C:\My Scripts\job.js\"` and fail on a mangled path. /s then strips exactly the outer
    // pair we added.
    return {
      file: process.env.ComSpec?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
    };
  }
  const file = process.env.SHELL?.trim() || "/bin/sh";
  // With the profile's PATH already in hand, a plain -c shell resolves everything a login shell
  // would, without re-running the profile (and without its output polluting the run log).
  return { file, args: [loginShellPath ? "-c" : "-lc", command] };
}

// Split a byte stream into complete lines, holding a partial tail until the next chunk. flush()
// emits whatever's left when the stream closes (output that never ended in a newline).
function lineSplitter(emit: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      // Handle \n and \r\n alike; a lone \r (progress bars) is left in place rather than treated
      // as a line break, which would flood the log.
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) emit(part.replace(/\r$/, ""));
    },
    flush() {
      if (buffer) {
        emit(buffer);
        buffer = "";
      }
    },
  };
}

// The inherited environment, with the login shell's PATH and then the job's own variables layered
// over it. Kept as one function so every run — shell command and JS script alike — builds its
// environment the same way.
function childEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  if (!loginShellPath && !extra) return process.env;
  return {
    ...process.env,
    ...(loginShellPath ? { PATH: loginShellPath } : {}),
    ...extra,
  };
}

export function runShellCommand(command: string, options: RunOptions): RunHandle {
  const { file, args } = shellInvocation(command);
  const child = spawn(file, args, {
    cwd: options.cwd?.trim() || undefined,
    // The resolved profile PATH replaces the app's minimal one; everything else is inherited, and
    // the job's own variables (its secrets) go on top.
    env: childEnv(options.env),
    // POSIX: own process group, so kill() can take down the script the shell started, not just
    // the shell. Windows has no process groups here — taskkill /T walks the tree instead — and
    // `detached` there would pop a console window.
    detached: !isWindows,
    windowsHide: true,
    // Pass the pre-quoted command line through untouched; see shellInvocation. Ignored off Windows.
    windowsVerbatimArguments: isWindows,
    stdio: ["ignore", "pipe", "pipe"],
  });

  for (const [name, stream] of [
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ] as const) {
    const splitter = lineSplitter((line) => options.onOutput(name, line));
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => splitter.push(chunk));
    stream?.on("close", () => splitter.flush());
  }

  let killTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let exited = false;
  // Set when the time limit — not the user — is what ended this run, so the caller can say so.
  let timedOut = false;

  const done = new Promise<RunOutcome>((resolve) => {
    const settle = (outcome: RunOutcome): void => {
      exited = true;
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // The flag rides on whichever outcome actually lands (usually the "close" from our own kill).
      resolve(timedOut ? { ...outcome, timedOut: true } : outcome);
    };
    // "error" fires instead of "close" when the spawn itself failed (no such cwd, no shell).
    child.on("error", (err) => settle({ code: null, signal: null, error: err.message }));
    // "close" (not "exit") so the last of the piped output has been delivered first.
    child.on("close", (code, signal) => settle({ code, signal }));
  });

  // The command's own time limit. Runs through the same kill() as the Stop button, so it takes the
  // whole process tree with it — a shell script's children don't outlive their parent's deadline.
  const timeoutMs = options.timeoutMs ?? 0;
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      kill();
    }, timeoutMs);
  }

  function kill(): void {
    if (exited || child.pid == null) return;
    if (isWindows) {
      // /T the whole tree, /F because a console app won't answer a polite request.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on(
        "error",
        () => child.kill("SIGKILL"),
      );
      return;
    }
    const pid = child.pid;
    try {
      // Negative pid = the whole process group (we spawned detached, so the shell leads it).
      process.kill(-pid, "SIGTERM");
    } catch {
      // Group already gone, or we lost the race with its exit — nothing left to signal.
      return;
    }
    killTimer = setTimeout(() => {
      if (exited) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
    // Don't hold the event loop open just to escalate a kill.
    killTimer.unref?.();
  }

  return { kill, done };
}

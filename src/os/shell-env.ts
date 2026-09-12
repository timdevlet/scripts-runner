// Resolve the PATH a user's terminal would have, once.
//
// The problem this solves: a GUI-launched app on macOS inherits a minimal PATH — no
// /usr/local/bin, no Homebrew, no nvm — so a scheduled `node script.js` fails with "command not
// found" even though it works in a terminal. Running each command through a LOGIN shell
// (`$SHELL -lc`) fixes that, but re-sources the user's profile on every single run, and anything
// that profile prints (a version-manager banner, a stray `compdef: command not found`) lands in
// that run's captured output, where it looks like the command's own errors.
//
// So the login shell is paid exactly once, at startup, purely to read $PATH out of it. Commands
// then run in a plain non-login shell with that PATH — same resolution, no profile noise.
//
// The value is fenced with markers because a profile is free to print whatever it likes on stdout
// too; only what's between them is ours.

import { spawn } from "node:child_process";

const START = "__TVC_PATH_START__";
const END = "__TVC_PATH_END__";

// A slow profile (nvm, rbenv, conda) can take a moment; past this we give up and fall back.
const PROBE_TIMEOUT_MS = 5000;

// Pull the fenced value out of whatever else the profile decided to print.
export function extractPath(stdout: string): string | null {
  const start = stdout.indexOf(START);
  const end = stdout.indexOf(END, start + START.length);
  if (start < 0 || end < 0) return null;
  const value = stdout.slice(start + START.length, end).trim();
  return value || null;
}

// Ask the user's login shell what PATH it ends up with. Resolves to null on Windows (cmd.exe
// already inherits the full user PATH), when there's no usable shell, or on any failure — the
// caller then keeps using a login shell per run.
export function probeLoginShellPath(timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  const shell = process.env.SHELL?.trim();
  if (!shell) return Promise.resolve(null);

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-lc", `printf '%s' '${START}'"$PATH"'${END}'`], {
        stdio: ["ignore", "pipe", "ignore"], // the profile's stderr is exactly what we're avoiding
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(extractPath(stdout)));
  });
}

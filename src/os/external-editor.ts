// Open a file in VS Code and tell the caller when that editing session ends.
//
// Two things make this more than a one-line spawn:
//
//  • Finding the launcher. `code` on PATH is the normal answer, but a GUI-launched app inherits a
//    minimal PATH (see src/os/shell-env.ts) and plenty of installs never ran VS Code's "Shell
//    Command: Install 'code' command in PATH" at all — so the usual install locations are tried
//    too before reporting that it isn't there.
//
//  • Knowing when the user is done. The launcher is run with --wait, so it stays alive until the
//    tab is closed. That exit is what ends the session: the caller stops watching the temp file
//    and deletes it, instead of leaving a watcher running for the life of the app.

import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const isWindows = process.platform === "win32";

// What the launcher is called, most-preferred first. On Windows PATH holds the .cmd shim.
const BINARY_NAMES = isWindows ? ["code.cmd", "code.exe"] : ["code"];

// Where VS Code puts the launcher when it was never added to PATH. Best-effort and
// platform-specific; a miss just means the "not found" message.
function installCandidates(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    const bin = join("Contents", "Resources", "app", "bin", "code");
    return [
      join("/Applications", "Visual Studio Code.app", bin),
      join(home, "Applications", "Visual Studio Code.app", bin),
    ];
  }
  if (isWindows) {
    const bin = join("Microsoft VS Code", "bin", "code.cmd");
    return [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", bin) : "",
      process.env.ProgramFiles ? join(process.env.ProgramFiles, bin) : "",
      process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], bin) : "",
    ].filter(Boolean);
  }
  return ["/usr/bin/code", "/usr/local/bin/code", "/snap/bin/code"];
}

// Every path worth testing, in order: the given PATH first (that's the user's own choice of
// install), then the known locations. Pure, so the ordering is unit-testable without a VS Code
// installed anywhere.
export function editorCandidates(pathValue: string): string[] {
  const out: string[] = [];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir.trim()) continue;
    for (const name of BINARY_NAMES) out.push(join(dir, name));
  }
  out.push(...installCandidates());
  return out;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The launcher to run, or null when VS Code can't be found.
export function findVsCode(pathValue: string): string | null {
  return editorCandidates(pathValue).find(isFile) ?? null;
}

export const VS_CODE_MISSING =
  "VS Code was not found. Install it, or open VS Code and run " +
  "“Shell Command: Install 'code' command in PATH”, then try again.";

// A .cmd shim can't be spawned directly (Node refuses since the argument-injection fix), so on
// Windows it goes through cmd.exe with the same pre-quoted form src/os/run-command.ts uses.
function spawnEditor(bin: string, file: string, env: NodeJS.ProcessEnv): ChildProcess {
  if (isWindows) {
    return spawn(
      process.env.ComSpec?.trim() || "cmd.exe",
      ["/d", "/s", "/c", `""${bin}" --wait "${file}""`],
      { env, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true },
    );
  }
  // detached so the editor outlives this app: quitting the tray app shouldn't close the window
  // someone is typing in.
  return spawn(bin, ["--wait", file], { env, stdio: "ignore", detached: true });
}

export interface EditorSession {
  // Resolves when the editor session ends — the tab was closed, or the launcher failed. Carries
  // the failure text, or null on a clean close. Never rejects.
  closed: Promise<string | null>;
}

// Open `file` in VS Code. `pathValue` is the PATH to search (the login-shell one, so a
// GUI-launched app finds the same `code` a terminal would).
export function openInVsCode(file: string, pathValue: string): EditorSession | { error: string } {
  const bin = findVsCode(pathValue);
  if (!bin) return { error: VS_CODE_MISSING };

  // The launcher shells out to the app; give it the resolved PATH rather than the app's minimal one.
  const env = pathValue ? { ...process.env, PATH: pathValue } : process.env;
  let child: ChildProcess;
  try {
    child = spawnEditor(bin, file, env);
  } catch (err) {
    return { error: `Could not start VS Code: ${(err as Error).message}` };
  }

  const closed = new Promise<string | null>((resolve) => {
    child.on("error", (err) => resolve(`Could not start VS Code: ${err.message}`));
    child.on("close", (code) =>
      // A non-zero exit from the launcher itself means it never got as far as opening the file.
      resolve(code === 0 || code === null ? null : `VS Code exited with code ${code}.`),
    );
  });
  // Don't hold the event loop open for an editor the user may leave open for hours.
  child.unref();
  return { closed };
}

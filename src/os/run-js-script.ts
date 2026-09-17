// Run a JS template by compiling it to a temp .mjs and spawning `node` through the same shell
// runner the Commands tab uses — login-shell PATH, cwd, timeout, process-group kill, streamed lines.
//
// The temp file is deleted once the process exits (success, failure, timeout, or Stop). A kill
// that races the unlink is fine: ENOENT is ignored.

import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileJsScript } from "../domain/script-params.js";
import { type RunHandle, runShellCommand } from "./run-command.js";

export interface JsScriptRun {
  source: string;
  paramValues: Record<string, string>;
  cwd: string;
  timeoutSeconds: number;
  // Values for the source's {{NAME:secret}} holes, which compile to process.env.NAME. They travel
  // in the child's environment rather than in the compiled body, so the temp file below never
  // holds a copy of them.
  secrets?: Record<string, string>;
}

function quoteShellArg(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function removeTemp(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone, or we lost the race with the OS — the next run uses a new name either way.
  }
}

export function runJsScript(
  script: JsScriptRun,
  onOutput: (stream: "stdout" | "stderr", text: string) => void,
): RunHandle {
  const file = join(tmpdir(), `cmd-sched-${globalThis.crypto.randomUUID()}.mjs`);
  // 0600: the compiled body carries the script's parameter values, and this file sits in a
  // world-readable temp directory for the length of the run.
  writeFileSync(file, compileJsScript(script.source, script.paramValues), {
    encoding: "utf8",
    mode: 0o600,
  });
  const handle = runShellCommand(`node ${quoteShellArg(file)}`, {
    cwd: script.cwd,
    timeoutMs: script.timeoutSeconds * 1000,
    env: script.secrets,
    onOutput,
  });
  return {
    kill: handle.kill,
    done: handle.done.finally(() => removeTemp(file)),
  };
}

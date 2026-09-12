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
  writeFileSync(file, compileJsScript(script.source, script.paramValues), "utf8");
  const handle = runShellCommand(`node ${quoteShellArg(file)}`, {
    cwd: script.cwd,
    timeoutMs: script.timeoutSeconds * 1000,
    onOutput,
  });
  return {
    kill: handle.kill,
    done: handle.done.finally(() => removeTemp(file)),
  };
}

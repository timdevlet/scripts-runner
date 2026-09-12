// The scheduler behind the Commands and Scripts tabs: holds both lists, fires the ones whose cron
// is due, runs them on demand from the ▶ button, and keeps a capped in-memory log of every run.
//
// Everything time- and process-related is injected (`run`, `now`), and the due check is driven by
// an explicit tick(), so the whole thing is unit-testable without timers or child processes —
// start() only exists to wire tick() to a real clock.
//
// Run logs are in memory by design: they're a live view of what the scheduler just did, not an
// audit trail, so they're capped per command/script and go away with the app. The one-line
// summaries are also sent to the app logger, which is what the Logs tab shows.

import { nextRun } from "./domain/cron.js";
import { describeTimeout } from "./domain/duration.js";
import { errorText } from "./domain/errors.js";
import { type JsScript, jsScriptLabel } from "./domain/js-script.js";
import {
  type RunLine,
  type RunRecord,
  type RunStatus,
  type RunTrigger,
  type ScheduledCommand,
  type SchedulerSnapshot,
  scheduledCommandLabel,
} from "./domain/scheduled.js";
import {
  extractScriptParams,
  resolveParamValues,
  scriptParamsFilled,
} from "./domain/script-params.js";
import { log, logError } from "./log.js";
import { type RunHandle, runShellCommand } from "./os/run-command.js";
import { runJsScript } from "./os/run-js-script.js";

// A job the scheduler can run: a shell command from the Commands tab, or a JS template from Scripts.
export type RunnableJob = ({ kind: "shell" } & ScheduledCommand) | ({ kind: "js" } & JsScript);

// How many runs to keep per command, and how many output lines to keep per run. Both are bounded
// so a chatty script scheduled every minute can't grow the main process without limit.
const MAX_RUNS_PER_COMMAND = 20;
const MAX_OUTPUT_LINES = 500;

interface SchedulerDeps {
  // Start a command or script. Injected so tests can drive runs by hand.
  run?: (
    job: RunnableJob,
    onOutput: (stream: "stdout" | "stderr", text: string) => void,
  ) => RunHandle;
  now?: () => number;
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  newId?: () => string;
  maxRunsPerCommand?: number;
  maxOutputLines?: number;
}

interface RunResult {
  ok: boolean;
  error?: string;
}

export interface Scheduler {
  // Replace the command list (after a save / at startup) and recompute those next-run times.
  setCommands(commands: ScheduledCommand[]): void;
  commands(): ScheduledCommand[];
  // Same for JS templates. The two lists share the ticker, run log, and "one live run per id".
  setScripts(scripts: JsScript[]): void;
  scripts(): JsScript[];
  // Fire every command/script whose next run is due. start() calls this once a minute; tests call it.
  tick(): void;
  // Run one command or script now, regardless of its schedule or enabled state.
  runNow(commandId: string): RunResult;
  // Kill a live run. Returns false when it wasn't running.
  stop(commandId: string): boolean;
  snapshot(): SchedulerSnapshot;
  // The captured output of one run, by run id. Fetched on demand — snapshots carry metadata only.
  output(runId: string): RunLine[];
  subscribe(listener: () => void): () => void;
  // Begin ticking on a real clock.
  start(): void;
  // Stop ticking and kill anything still running (app quit).
  dispose(): void;
}

export function createScheduler(deps: SchedulerDeps = {}): Scheduler {
  const run = deps.run ?? defaultRunner;
  const now = deps.now ?? (() => Date.now());
  const write = deps.log ?? log;
  const writeError = deps.logError ?? logError;
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const maxRuns = deps.maxRunsPerCommand ?? MAX_RUNS_PER_COMMAND;
  const maxLines = deps.maxOutputLines ?? MAX_OUTPUT_LINES;

  let commands: ScheduledCommand[] = [];
  let scripts: JsScript[] = [];
  // Newest first, across all jobs; trimmed per id to `maxRuns`.
  let records: RunRecord[] = [];
  const outputs = new Map<string, RunLine[]>();
  // Job id → its live run. Also the "is it running" check: one run per id at a time.
  const live = new Map<string, { runId: string; handle: RunHandle; cancelled: boolean }>();
  // Job id → epoch ms of its next firing, or null when it has no armed, valid schedule.
  const nextAt = new Map<string, number | null>();
  const listeners = new Set<() => void>();
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function toJob(command: ScheduledCommand): RunnableJob {
    return { kind: "shell", ...command };
  }

  function toScriptJob(script: JsScript): RunnableJob {
    return { kind: "js", ...script };
  }

  function findJob(id: string): RunnableJob | undefined {
    const command = commands.find((c) => c.id === id);
    if (command) return toJob(command);
    const script = scripts.find((s) => s.id === id);
    if (script) return toScriptJob(script);
    return undefined;
  }

  function jobLabel(job: RunnableJob): string {
    return job.kind === "shell" ? scheduledCommandLabel(job) : jsScriptLabel(job);
  }

  function jobNoun(job: RunnableJob): string {
    return job.kind === "shell" ? "Command" : "Script";
  }

  // When a job next fires: null unless it's enabled with a schedule that parses, has something to
  // run, and (for scripts) every extracted param has a value.
  function computeNextAt(job: RunnableJob, from: number): number | null {
    if (!job.enabled || !job.cron.trim()) return null;
    if (job.kind === "shell" && !job.command.trim()) return null;
    if (
      job.kind === "js" &&
      (!job.source.trim() || !scriptParamsFilled(job.source, job.paramValues))
    ) {
      return null;
    }
    try {
      return nextRun(job.cron, new Date(from))?.getTime() ?? null;
    } catch {
      // An invalid expression is kept on the row (so the user can fix it) but never fires.
      return null;
    }
  }

  // Drop live runs, history, and next-run times for ids that are no longer in either list. Saving
  // commands must not take scripts with them, and vice versa.
  function retain(keep: Set<string>): void {
    for (const [id, entry] of live) {
      if (!keep.has(id)) {
        entry.cancelled = true;
        entry.handle.kill();
      }
    }
    for (const record of records) {
      if (!keep.has(record.commandId)) outputs.delete(record.id);
    }
    records = records.filter((r) => keep.has(r.commandId));
    for (const id of [...nextAt.keys()]) {
      if (!keep.has(id)) nextAt.delete(id);
    }
  }

  function setCommands(next: ScheduledCommand[]): void {
    const at = now();
    retain(new Set([...next.map((c) => c.id), ...scripts.map((s) => s.id)]));
    commands = next;
    for (const cmd of next) nextAt.set(cmd.id, computeNextAt(toJob(cmd), at));
    emit();
  }

  function setScripts(next: JsScript[]): void {
    const at = now();
    retain(new Set([...commands.map((c) => c.id), ...next.map((s) => s.id)]));
    scripts = next;
    for (const script of next) nextAt.set(script.id, computeNextAt(toScriptJob(script), at));
    emit();
  }

  function trim(commandId: string): void {
    const mine = records.filter((r) => r.commandId === commandId);
    if (mine.length <= maxRuns) return;
    // records is newest-first, so the ones past the cap are the oldest.
    const drop = new Set(mine.slice(maxRuns).map((r) => r.id));
    for (const id of drop) outputs.delete(id);
    records = records.filter((r) => !drop.has(r.id));
  }

  function append(record: RunRecord, stream: RunLine["stream"], text: string): void {
    const lines = outputs.get(record.id);
    if (!lines) return;
    lines.push({ at: now(), stream, text });
    if (lines.length > maxLines) {
      lines.splice(0, lines.length - maxLines);
      record.truncated = true;
    }
    // Counts every line ever produced, not the retained buffer's length. The renderer watches this
    // to know a live run has more output to fetch; a retained-count would stop changing at the cap
    // and freeze the tail of exactly the chatty commands that need it most.
    record.totalLines++;
  }

  // Start a job. The only path to a run — both tick() and runNow() go through here.
  function begin(job: RunnableJob, trigger: RunTrigger): RunResult {
    if (job.kind === "shell" && !job.command.trim()) {
      return { ok: false, error: "This command has nothing to run." };
    }
    if (job.kind === "js" && !job.source.trim()) {
      return { ok: false, error: "This script has nothing to run." };
    }
    if (live.has(job.id)) {
      return {
        ok: false,
        error:
          job.kind === "shell"
            ? "This command is already running."
            : "This script is already running.",
      };
    }

    const label = jobLabel(job);
    const noun = jobNoun(job);
    const record: RunRecord = {
      id: newId(),
      commandId: job.id,
      commandName: label,
      trigger,
      status: "running",
      startedAt: now(),
      finishedAt: null,
      exitCode: null,
      error: "",
      totalLines: 0,
      truncated: false,
    };
    records.unshift(record);
    outputs.set(record.id, []);
    trim(job.id);
    if (job.kind === "shell") {
      append(record, "system", `$ ${job.command}`);
    } else {
      append(record, "system", "$ node (script)");
      const params = extractScriptParams(job.source);
      const values = resolveParamValues(params, job.paramValues);
      for (const param of params) {
        append(record, "system", `(${param.name} = ${JSON.stringify(values[param.name])})`);
      }
    }
    if (job.cwd.trim()) append(record, "system", `(in ${job.cwd.trim()})`);
    // Record the limit this run is held to, so a later "timed out" line in the log has its
    // explanation right above it — even if the job's timeout has been edited since.
    if (job.timeoutSeconds > 0) {
      append(record, "system", `(timeout ${describeTimeout(job.timeoutSeconds)})`);
    }
    write(`\n${noun} "${label}" → running (${trigger})...`);

    let handle: RunHandle;
    try {
      handle = run(job, (stream, text) => {
        append(record, stream, text);
        emit();
      });
    } catch (err) {
      // A synchronous spawn throw (rather than the async "error" event) still has to land as a
      // finished run, or the job would look stuck at "running" forever.
      const message = errorText(err);
      finish(record, "failed", null, message, noun);
      return { ok: false, error: message };
    }

    const entry = { runId: record.id, handle, cancelled: false };
    live.set(job.id, entry);
    void handle.done.then((outcome) => {
      live.delete(job.id);
      // Stop wins over the time limit when both landed: the user already knows they stopped it,
      // whereas an automatic kill is the part worth surfacing.
      const status: RunStatus = entry.cancelled
        ? "cancelled"
        : outcome.timedOut
          ? "timeout"
          : outcome.error || outcome.code !== 0
            ? "failed"
            : "success";
      const detail = outcome.timedOut
        ? `timed out after ${describeTimeout(job.timeoutSeconds)}`
        : (outcome.error ?? "");
      finish(record, status, outcome.code, detail, noun);
    });
    emit();
    return { ok: true };
  }

  function finish(
    record: RunRecord,
    status: RunStatus,
    code: number | null,
    error: string,
    noun = "Command",
  ): void {
    record.status = status;
    record.finishedAt = now();
    record.exitCode = code;
    record.error = error;
    const seconds = ((record.finishedAt - record.startedAt) / 1000).toFixed(1);
    const detail = error || (code == null ? "stopped" : `exit ${code}`);
    append(record, "system", `${detail} — ${seconds}s`);
    const line = `${noun} "${record.commandName}" → ${status} (${detail}) in ${seconds}s.`;
    if (status === "failed" || status === "timeout") writeError(line);
    else write(line);
    emit();
  }

  function tick(): void {
    if (disposed) return;
    const at = now();
    for (const job of [...commands.map(toJob), ...scripts.map(toScriptJob)]) {
      const due = nextAt.get(job.id);
      if (due == null || due > at) continue;
      // Recompute from NOW, not from the missed time: a schedule the PC slept through fires once
      // on the next tick and then resumes its normal cadence, rather than replaying every
      // occurrence it missed. Done before the run so a failure to start can't wedge the schedule.
      nextAt.set(job.id, computeNextAt(job, at));
      if (live.has(job.id)) {
        write(`${jobNoun(job)} "${jobLabel(job)}" is still running — skipping this run.`);
        continue;
      }
      begin(job, "schedule");
    }
    emit();
  }

  function runNow(commandId: string): RunResult {
    const job = findJob(commandId);
    if (!job) return { ok: false, error: "Unknown command." };
    return begin(job, "manual");
  }

  function stop(commandId: string): boolean {
    const entry = live.get(commandId);
    if (!entry) return false;
    entry.cancelled = true;
    entry.handle.kill();
    return true;
  }

  function snapshot(): SchedulerSnapshot {
    return {
      // Copies, not the live records: the renderer diffs by value, and these are mutated in place
      // as a run progresses.
      runs: records.map((r) => ({ ...r })),
      running: [...live.keys()],
      nextRunAt: Object.fromEntries(nextAt),
    };
  }

  // Tick just after each minute rolls over — cron's resolution is a minute, so there's nothing to
  // gain from a faster poll, and re-aligning every time keeps it from drifting (or from firing a
  // minute late for the rest of the session after the machine sleeps).
  function scheduleTick(): void {
    if (disposed) return;
    const delay = 60_000 - (now() % 60_000) + 250;
    timer = setTimeout(() => {
      tick();
      scheduleTick();
    }, delay);
  }

  return {
    setCommands,
    commands: () => commands,
    setScripts,
    scripts: () => scripts,
    tick,
    runNow,
    stop,
    snapshot,
    output: (runId) => (outputs.get(runId) ?? []).map((l) => ({ ...l })),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: scheduleTick,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // Don't leave orphaned scripts behind when the app quits.
      for (const entry of live.values()) {
        entry.cancelled = true;
        entry.handle.kill();
      }
      live.clear();
      listeners.clear();
    },
  };
}

// The real runner: a shell child process, or node on a compiled temp file for JS templates.
function defaultRunner(
  job: RunnableJob,
  onOutput: (stream: "stdout" | "stderr", text: string) => void,
): RunHandle {
  if (job.kind === "js") {
    return runJsScript(job, onOutput);
  }
  return runShellCommand(job.command, {
    cwd: job.cwd,
    // 0 (Unlimited) passes straight through as "no timer".
    timeoutMs: job.timeoutSeconds * 1000,
    onOutput,
  });
}

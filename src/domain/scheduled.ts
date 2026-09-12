// Pure types & policy for the scheduler (the Commands tab): the stored command shape, the run
// records its logs are made of, and the JSON file format used for both storage and export/import.
// No I/O — the file adapter is src/scheduled-store.ts and the runner is src/scheduler.ts.

import { DEFAULT_TIMEOUT_SECONDS, normalizeTimeoutSeconds } from "./duration.js";

// One user-defined command. Every field is always present (no optionals) because this shape is
// edited directly by the renderer's controlled inputs, stored verbatim, and exported as-is — one
// shape end to end means no second "settings" mirror to keep in sync.
export interface ScheduledCommand {
  // Stable id, minted when the row is added. React key, run/delete identity, and run-log key.
  id: string;
  // Display name shown in the list ("" renders as "Untitled command").
  name: string;
  // The shell command line, e.g. `node ~/scripts/backup.js`. Run through the user's login shell.
  command: string;
  // A 5-field cron expression (see src/domain/cron.ts). "" = no schedule: the command exists but
  // only ever runs from the ▶ button.
  cron: string;
  // Whether the schedule is armed. A disabled command keeps its cron but never fires on its own;
  // ▶ still runs it. New commands start disabled so nothing runs before it's been looked at.
  enabled: boolean;
  // Working directory for the run. "" = the app's own cwd.
  cwd: string;
  // Kill the command (and everything it started) if it's still running after this many seconds.
  // 0 = unlimited. Defaults to DEFAULT_TIMEOUT_SECONDS, including for commands stored before this
  // field existed — see normalizeTimeoutSeconds.
  timeoutSeconds: number;
}

// Where a run came from: the ▶ button or the cron schedule.
export type RunTrigger = "manual" | "schedule";

// A run's lifecycle. "cancelled" is specifically the Stop button (or app quit) killing it;
// "timeout" is the command's own time limit doing so.
export type RunStatus = "running" | "success" | "failed" | "cancelled" | "timeout";

// One captured line of a run. "system" lines are the scheduler's own notes (the command line it
// ran, the exit summary) rather than the child process's output.
export interface RunLine {
  at: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

// The metadata for one run. The captured output is NOT here — it's fetched per run on demand
// (scheduler:output) so pushing a live snapshot every few hundred ms stays cheap.
export interface RunRecord {
  id: string;
  commandId: string;
  // The command's name at the time it ran, so a renamed/deleted command's history still reads.
  commandName: string;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: number;
  // null while still running.
  finishedAt: number | null;
  // Process exit code; null while running, or when the process died on a signal / never spawned.
  exitCode: number | null;
  // Why it failed to run at all (spawn error). "" when the process actually ran.
  error: string;
  // How many lines this run has produced in TOTAL — it only ever grows, including past the
  // retention cap. That matters: the renderer re-fetches a live run's output whenever this
  // changes, so a count that plateaued at the cap would freeze the tail of a chatty command.
  totalLines: number;
  // True once the oldest output lines have been dropped to stay under the per-run cap.
  truncated: boolean;
}

// What the main process pushes to the renderer on every scheduler change.
export interface SchedulerSnapshot {
  // Every retained run, newest first, across all commands.
  runs: RunRecord[];
  // Ids of the commands with a live run right now (the ▶ button shows Stop for these).
  running: string[];
  // Per command id: when it next fires (epoch ms), or null when it has no armed, valid schedule.
  nextRunAt: Record<string, number | null>;
}

// An empty command row, as "+ Add command" creates it.
export function emptyScheduledCommand(id: string): ScheduledCommand {
  return {
    id,
    name: "",
    command: "",
    cron: "",
    enabled: false,
    cwd: "",
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
}

// Display name for a command — the list, the logs, and the run history all use this so an unnamed
// row is never a blank space.
export function scheduledCommandLabel(cmd: Pick<ScheduledCommand, "name" | "command">): string {
  const name = cmd.name.trim();
  if (name) return name;
  const command = cmd.command.trim();
  if (!command) return "Untitled command";
  // Fall back to the command itself, shortened — enough to tell two unnamed rows apart.
  return command.length > 40 ? `${command.slice(0, 40)}…` : command;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Coerce an untrusted value (the stored file, an imported file, an IPC payload) to a clean command
// list. Non-objects are dropped; everything else is kept — including half-filled rows, which are
// just drafts the user hasn't finished. Ids are made unique so an imported file that reuses one
// can't shadow an existing command's run history.
export function normalizeScheduledCommands(value: unknown): ScheduledCommand[] {
  if (!Array.isArray(value)) return [];
  const result: ScheduledCommand[] = [];
  const seenIds = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    let id = str(entry.id).trim() || `sched-${result.length + 1}`;
    while (seenIds.has(id)) id = `${id}-2`;
    seenIds.add(id);
    result.push({
      id,
      name: str(entry.name).trim(),
      // Not trimmed to a single line: a multi-line script is a legitimate command. Only the
      // surrounding whitespace goes.
      command: str(entry.command).trim(),
      cron: str(entry.cron).trim(),
      enabled: entry.enabled === true,
      cwd: str(entry.cwd).trim(),
      timeoutSeconds: normalizeTimeoutSeconds(entry.timeoutSeconds),
    });
  }
  return result;
}

// The on-disk / export envelope. Versioned so a future shape change can migrate rather than guess.
export const SCHEDULE_FILE_VERSION = 1;

export interface ScheduleFile {
  version: number;
  commands: ScheduledCommand[];
}

// Read a parsed JSON value as a command list. Accepts the versioned envelope and — leniently — a
// bare array, so a hand-written file or a copy-pasted `commands` array still imports.
export function parseScheduleFile(value: unknown): ScheduledCommand[] {
  if (Array.isArray(value)) return normalizeScheduledCommands(value);
  if (typeof value === "object" && value !== null) {
    return normalizeScheduledCommands((value as Record<string, unknown>).commands);
  }
  return [];
}

// The exact text written to scheduled-commands.json and to an export — pretty-printed so it's
// diffable and hand-editable, with the trailing newline the rest of the app's files have.
export function serializeScheduleFile(commands: ScheduledCommand[]): string {
  const file: ScheduleFile = { version: SCHEDULE_FILE_VERSION, commands };
  return `${JSON.stringify(file, null, 2)}\n`;
}

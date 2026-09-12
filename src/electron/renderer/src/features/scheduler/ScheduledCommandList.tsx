import { ClockIcon } from "../../components/icons";
import { RunButton } from "../../components/RunButton";
import { Truncate } from "../../components/Truncate";
import { formatCountdown, formatWhen } from "../../lib/datetime";
import type { ScheduledCommand, SchedulerSnapshot } from "../../types";
import "./ScheduledCommandList.scss";

// Mirrors scheduledCommandLabel in src/domain/scheduled.ts — duplicated so the sandboxed renderer
// keeps importing only types from the node-side modules (the same trade the Settings command list
// makes for its own label helpers).
export function commandLabel(cmd: ScheduledCommand): string {
  const name = cmd.name.trim();
  if (name) return name;
  const command = cmd.command.trim();
  if (!command) return "Untitled command";
  return command.length > 40 ? `${command.slice(0, 40)}…` : command;
}

// The one-line schedule summary under a row's name. Everything it needs is already in the
// snapshot the main process pushes, so no cron parsing happens in the renderer.
function scheduleSubtitle(cmd: ScheduledCommand, nextAt: number | null | undefined): string {
  if (!cmd.command.trim()) return "Nothing to run yet";
  if (!cmd.cron.trim()) return "Manual only";
  if (!cmd.enabled) return "Paused";
  // Saved, enabled, has an expression — but the scheduler found no firing time for it. Either the
  // expression doesn't parse or it can never match (e.g. Feb 30th).
  if (nextAt == null) return "Schedule isn't valid";
  return `${formatCountdown(nextAt)} · ${formatWhen(nextAt)}`;
}

// The left column: one row per command, single-select. Selecting a row shows its configuration in
// the panel beside it. A trailing "+ Add command" row appends a blank one. Rows mirror the TV
// control list's shape (title + muted subtitle) so the two tabs read the same.
export function ScheduledCommandList({
  commands,
  snapshot,
  selectedId,
  pendingId,
  onSelect,
  onRun,
  onAdd,
}: {
  commands: ScheduledCommand[];
  snapshot: SchedulerSnapshot;
  selectedId: string | null;
  // A command whose ▶ has been pressed but whose run hasn't been confirmed started yet.
  pendingId: string | null;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  onAdd: () => void;
}) {
  const running = new Set(snapshot.running);
  return (
    <div className="sched-list" role="radiogroup" aria-label="Command to configure">
      {commands.map((cmd) => {
        const active = cmd.id === selectedId;
        const scheduled = cmd.enabled && cmd.cron.trim() !== "";
        return (
          // A row is a wrapper, not a button: it holds two controls (select and run), and nesting
          // a button inside a button isn't valid HTML. The radio is the selectable part only.
          <div key={cmd.id} className={active ? "sched-row active" : "sched-row"}>
            <button
              type="button"
              role="radio"
              aria-checked={active}
              className="sched-row-select"
              onClick={() => onSelect(cmd.id)}
            >
              <span className="sched-row-text">
                <span className="sched-row-label">
                  {scheduled && <ClockIcon size={13} />}
                  <Truncate text={commandLabel(cmd)} />
                </span>
                <small className="sched-row-subtitle">
                  {scheduleSubtitle(cmd, snapshot.nextRunAt[cmd.id])}
                </small>
              </span>
            </button>
            {/* Doubles as the row's running indicator: the spinner shows for a run started here,
                from the panel, or by the schedule. */}
            <RunButton
              running={running.has(cmd.id)}
              pending={pendingId === cmd.id}
              disabled={!cmd.command.trim()}
              label={`Run "${commandLabel(cmd)}" now`}
              runningLabel={`"${commandLabel(cmd)}" is running`}
              onRun={() => onRun(cmd.id)}
            />
          </div>
        );
      })}
      <button type="button" className="sched-row sched-row-add" onClick={onAdd}>
        <span className="sched-row-label">+ Add command</span>
      </button>
    </div>
  );
}

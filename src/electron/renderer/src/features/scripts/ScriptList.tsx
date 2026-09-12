import { scriptParamsFilled } from "../../../../../domain/script-params";
import { ClockIcon } from "../../components/icons";
import { RunButton } from "../../components/RunButton";
import { Truncate } from "../../components/Truncate";
import { formatCountdown, formatWhen } from "../../lib/datetime";
import type { JsScript, SchedulerSnapshot } from "../../types";
import "../scheduler/ScheduledCommandList.scss";

export function scriptLabel(script: JsScript): string {
  const name = script.name.trim();
  if (name) return name;
  const source = script.source.trim();
  if (!source) return "Untitled script";
  const first =
    source.split("\n").find((line) => line.trim() && !line.trim().startsWith("//")) ?? source;
  const compact = first.trim();
  return compact.length > 40 ? `${compact.slice(0, 40)}…` : compact;
}

function scheduleSubtitle(script: JsScript, nextAt: number | null | undefined): string {
  if (!script.source.trim()) return "Nothing to run yet";
  if (!script.cron.trim()) return "Manual only";
  if (!script.enabled) return "Paused";
  if (nextAt == null) {
    if (!scriptParamsFilled(script.source, script.paramValues)) return "Fill in the parameters";
    return "Schedule isn't valid";
  }
  return `${formatCountdown(nextAt)} · ${formatWhen(nextAt)}`;
}

export function ScriptList({
  scripts,
  snapshot,
  selectedId,
  pendingId,
  onSelect,
  onRun,
  onAdd,
}: {
  scripts: JsScript[];
  snapshot: SchedulerSnapshot;
  selectedId: string | null;
  pendingId: string | null;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  onAdd: () => void;
}) {
  const running = new Set(snapshot.running);
  return (
    <div className="sched-list" role="radiogroup" aria-label="Script to configure">
      {scripts.map((script) => {
        const active = script.id === selectedId;
        const scheduled = script.enabled && script.cron.trim() !== "";
        return (
          <div key={script.id} className={active ? "sched-row active" : "sched-row"}>
            <button
              type="button"
              role="radio"
              aria-checked={active}
              className="sched-row-select"
              onClick={() => onSelect(script.id)}
            >
              <span className="sched-row-text">
                <span className="sched-row-label">
                  {scheduled && <ClockIcon size={13} />}
                  <Truncate text={scriptLabel(script)} />
                </span>
                <small className="sched-row-subtitle">
                  {scheduleSubtitle(script, snapshot.nextRunAt[script.id])}
                </small>
              </span>
            </button>
            <RunButton
              running={running.has(script.id)}
              pending={pendingId === script.id}
              disabled={!script.source.trim()}
              label={`Run "${scriptLabel(script)}" now`}
              runningLabel={`"${scriptLabel(script)}" is running`}
              onRun={() => onRun(script.id)}
            />
          </div>
        );
      })}
      <button type="button" className="sched-row sched-row-add" onClick={onAdd}>
        <span className="sched-row-label">+ Add script</span>
      </button>
    </div>
  );
}

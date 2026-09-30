import { useState } from "react";
import { jsScriptLabel, jsScriptMatchesFilter } from "../../../../../domain/js-script";
import { scriptParamsFilled } from "../../../../../domain/script-params";
import { ClockIcon, SearchIcon } from "../../components/icons";
import { RunButton } from "../../components/RunButton";
import { TextInput } from "../../components/TextInput";
import { Truncate } from "../../components/Truncate";
import { formatCountdown, formatWhen } from "../../lib/datetime";
import type { JsScript, SchedulerSnapshot } from "../../types";
import "../scheduler/ScheduledCommandList.scss";

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
  // Only narrows what's listed: the selection stays put even when the filter hides its row.
  const [filter, setFilter] = useState("");
  const shown = scripts.filter((script) => jsScriptMatchesFilter(script, filter));
  return (
    <div className="sched-list" role="radiogroup" aria-label="Script to configure">
      {scripts.length > 0 && (
        <div className="script-filter">
          <span className="script-filter-icon">
            <SearchIcon />
          </span>
          <TextInput
            type="search"
            className="script-filter-input"
            placeholder="Filter by name"
            aria-label="Filter scripts by name"
            value={filter}
            onValueChange={setFilter}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilter("");
            }}
          />
        </div>
      )}
      {scripts.length > 0 && shown.length === 0 && (
        <p className="hint script-filter-empty">No script names match “{filter.trim()}”.</p>
      )}
      {shown.map((script) => {
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
                  <Truncate text={jsScriptLabel(script)} />
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
              label={`Run "${jsScriptLabel(script)}" now`}
              runningLabel={`"${jsScriptLabel(script)}" is running`}
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

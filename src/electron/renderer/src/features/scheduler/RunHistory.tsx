import { useEffect, useRef, useState } from "react";
import { MutedMessage } from "../../components/MutedMessage";
import { ScrollArea } from "../../components/ScrollArea";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import { formatClock, formatDuration, formatWhen } from "../../lib/datetime";
import { api } from "../../stores/api";
import type { RunLine, RunRecord, RunStatus } from "../../types";
import "./RunHistory.scss";

const STATUS_TEXT: Record<RunStatus, string> = {
  running: "Running",
  success: "Success",
  failed: "Failed",
  cancelled: "Stopped",
  timeout: "Timed out",
};

// Why a run ended, when there's more to say than its status: the spawn error, or the exit code
// behind a failure. A timeout's own detail ("timed out after 5:00") would just repeat the label.
function runReason(record: RunRecord): string {
  if (record.error) return record.error;
  if (record.status === "failed" && record.exitCode != null) return `exit ${record.exitCode}`;
  return "";
}

// A chip's tooltip — everything the strip itself hasn't room to print.
function runTooltip(record: RunRecord): string {
  const parts = [
    STATUS_TEXT[record.status],
    formatWhen(record.startedAt),
    record.trigger === "schedule" ? "scheduled" : "manual",
  ];
  if (record.finishedAt != null) parts.push(formatDuration(record.finishedAt - record.startedAt));
  const reason = runReason(record);
  if (reason) parts.push(reason);
  return parts.join(" · ");
}

// The per-command run log, shaped for a narrow column: every retained run is a status-colored chip
// on one horizontal strip (newest first, so the left edge is the interesting end), and the selected
// run's captured output takes all the height that's left. A vertical list of runs would spend the
// column's whole height saying what the chips say in one line.
//
// Output is fetched per run (api.getRunOutput) rather than pushed with the snapshot — a chatty
// command would otherwise re-send its whole backlog to the renderer several times a second. The
// effect below re-fetches whenever the selected run grows (`totalLines`) or finishes (`status`),
// which is what makes a live run tail.
export function RunHistory({ runs }: { runs: RunRecord[] }) {
  // The run the user clicked. Null = follow the newest, so a fresh run's output shows immediately.
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [lines, setLines] = useState<RunLine[]>([]);

  // A pinned run can be trimmed out of the history; fall back to the newest rather than showing
  // nothing.
  const selected = runs.find((r) => r.id === pinnedId) ?? runs[0];
  const selectedId = selected?.id;
  const newestId = runs[0]?.id;

  // A run that starts while an older one is pinned unpins it: pressing ▶ and then watching the
  // run you were reading sit there, frozen at its old output, reads as "the log doesn't update".
  // Clicking a chip pins again.
  const followedId = useRef(newestId);
  useEffect(() => {
    if (newestId !== followedId.current) {
      followedId.current = newestId;
      setPinnedId(null);
    }
  }, [newestId]);

  // The fetches below are deliberately NOT torn down when the effect re-runs. A live run pushes a
  // fresh snapshot several times a second, and cancelling the in-flight request on each one meant
  // that whenever a response took longer than the gap between snapshots — exactly what happens
  // when the main process is busy pumping a chatty run's output — every response was discarded and
  // nothing appeared until the run ended and the updates stopped. Instead each request carries a
  // sequence number: a response paints unless a newer one has already landed, or the selection has
  // moved on since.
  const requested = useRef(0);
  const applied = useRef(0);
  const showing = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (selectedId == null) {
      showing.current = undefined;
      setLines([]);
      return;
    }
    // A different run: clear first, so the previous run's output isn't left on screen under the
    // new run's heading while its first fetch is out.
    if (showing.current !== selectedId) {
      showing.current = selectedId;
      applied.current = 0;
      setLines([]);
    }
    const seq = ++requested.current;
    const apply = (next: RunLine[]) => {
      if (!mounted.current || showing.current !== selectedId || seq <= applied.current) return;
      applied.current = seq;
      setLines(next);
    };
    api.getRunOutput(selectedId).then(apply, () => apply([]));
    // Re-fetch as the run grows or ends. totalLines counts every line the run has ever emitted, so
    // it keeps ticking past the retention cap — a retained-line count would plateau there and the
    // tail of a chatty command would stop updating while it was still running.
  }, [selectedId, selected?.totalLines, selected?.status]);

  // Tail the output the way the Logs tab does: stick to the bottom while the user is already
  // there, and stay put the moment they scroll up to read something.
  const scroll = useAutoScroll(lines.length, true);

  if (runs.length === 0) {
    return <MutedMessage>No runs yet — press ▶ to run this command now.</MutedMessage>;
  }

  const reason = selected ? runReason(selected) : "";

  return (
    <div className="run-history">
      {/* The strip scrolls sideways rather than wrapping, so the height it costs is fixed however
          many runs are retained. */}
      <ScrollArea className="run-strip">
        <div className="run-strip-row" role="listbox" aria-label="Runs">
          {runs.map((record) => {
            const active = record.id === selected?.id;
            return (
              <button
                key={record.id}
                type="button"
                role="option"
                aria-selected={active}
                className={`run-chip ${record.status}${active ? " active" : ""}`}
                title={runTooltip(record)}
                onClick={() => setPinnedId(record.id)}
              >
                {formatWhen(record.startedAt)}
              </button>
            );
          })}
        </div>
      </ScrollArea>

      {/* What the chip's color only hints at, spelled out for the one run being shown. */}
      {selected && (
        <div className="run-detail">
          <span className={`run-status ${selected.status}`}>{STATUS_TEXT[selected.status]}</span>
          <span className="run-detail-meta">
            {selected.trigger === "schedule" ? "scheduled" : "manual"}
            {selected.finishedAt != null &&
              ` · ${formatDuration(selected.finishedAt - selected.startedAt)}`}
            {reason && ` · ${reason}`}
          </span>
        </div>
      )}

      <ScrollArea
        className="run-output"
        events={{
          initialized: (inst) => scroll.attach(inst.elements().viewport),
          destroyed: () => scroll.detach(),
          scroll: () => scroll.onScroll(),
        }}
      >
        {selected?.truncated && (
          <div className="run-output-note">
            Older output was dropped — showing the most recent lines.
          </div>
        )}
        {lines.length === 0 ? (
          <div className="run-output-empty">
            {selected?.status === "running" ? "Waiting for output…" : "No output."}
          </div>
        ) : (
          lines.map((line, i) => (
            // Output lines are an append-only list, never reordered — the index is a stable key.
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only, non-reordered list.
            <div key={i} className={`run-line ${line.stream}`}>
              <span className="run-line-time">{formatClock(line.at)}</span>
              <span className="run-line-text">{line.text}</span>
            </div>
          ))
        )}
      </ScrollArea>
    </div>
  );
}

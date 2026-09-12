import { IconButton } from "./IconButton";
import { PlayIcon, SpinnerIcon } from "./icons";
import "./RunButton.scss";

// A ▶ that becomes a spinner while the thing it started is running.
//
// While running it's disabled rather than doubling as a stop control: at this size there's nothing
// to distinguish "running" from "click to stop", and a mis-click would kill a job instead of
// telling you about it. Stopping lives on the full-width button in the panel, where it's labelled.
export function RunButton({
  running,
  // A press that hasn't come back yet — the IPC is out, but the run hasn't been confirmed started.
  pending = false,
  disabled = false,
  label,
  runningLabel = "Running…",
  onRun,
  className,
}: {
  running: boolean;
  pending?: boolean;
  disabled?: boolean;
  // Accessible name while idle, e.g. `Run "Nightly backup"`.
  label: string;
  runningLabel?: string;
  onRun: () => void;
  className?: string;
}) {
  const busy = running || pending;
  return (
    <IconButton
      className={["run-button", busy ? "running" : "", className].filter(Boolean).join(" ")}
      aria-label={busy ? runningLabel : label}
      title={busy ? runningLabel : label}
      disabled={disabled || busy}
      onClick={(e) => {
        // The button sits inside a clickable row; running a command shouldn't also select it.
        e.stopPropagation();
        onRun();
      }}
    >
      {busy ? <SpinnerIcon /> : <PlayIcon />}
    </IconButton>
  );
}

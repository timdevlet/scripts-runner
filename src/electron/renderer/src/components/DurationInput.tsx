import { type InputHTMLAttributes, useState } from "react";
import { formatClockDuration, parseClockDuration } from "../../../../domain/duration";
import "./DurationInput.scss";

type DurationInputProps = {
  // The committed value, in seconds.
  seconds: number;
  // Fired when a valid duration is committed (on blur or Enter), never mid-keystroke.
  onSecondsChange: (seconds: number) => void;
  // Upper bound; a larger value is clamped down on commit so the clamp is visible in the field.
  max?: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "max">;

// A stopwatch-style duration field: "0:43" is 43 seconds, "1:40" is a minute and forty, "1:02:03"
// is an hour-odd. A bare number is read as seconds, so "90" commits and redisplays as "1:30".
//
// Editing is drafted rather than continuous. The parent's value only changes when the field is
// committed (blur or Enter) — otherwise typing "1:40" would pass through "1", momentarily
// committing a one-second timeout and autosaving it. An unparseable draft marks the field invalid
// and reverts on blur, so the committed value is always one this input produced.
export function DurationInput({
  seconds,
  onSecondsChange,
  max,
  className,
  onBlur,
  onKeyDown,
  ...rest
}: DurationInputProps) {
  // null = show the committed value; a string = the user is part-way through editing it.
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null ? seconds : parseClockDuration(draft);
  const invalid = parsed === null;

  const commit = (): void => {
    if (draft === null) return;
    const value = parseClockDuration(draft);
    // Give up on an unparseable draft and snap back to what's stored, rather than silently
    // committing something the user didn't type.
    if (value !== null) onSecondsChange(max != null ? Math.min(max, value) : value);
    setDraft(null);
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      className={["duration-input", className].filter(Boolean).join(" ")}
      value={draft ?? formatClockDuration(seconds)}
      aria-invalid={invalid || undefined}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={(e) => {
        commit();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        // Escape abandons the edit and restores what's committed.
        if (e.key === "Escape") setDraft(null);
        onKeyDown?.(e);
      }}
      {...rest}
    />
  );
}

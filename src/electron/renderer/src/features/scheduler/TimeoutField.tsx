import { useState } from "react";
import {
  DEFAULT_TIMEOUT_SECONDS,
  formatClockDuration,
  MAX_TIMEOUT_SECONDS,
  UNLIMITED_TIMEOUT,
} from "../../../../../domain/duration";
import { DurationInput } from "../../components/DurationInput";
import { Field } from "../../components/Field";
import { LabeledCheckbox } from "../../components/LabeledCheckbox";
import "./TimeoutField.scss";

// How long a command may run before it's killed: a duration field plus an Unlimited checkbox.
// Unlimited is stored as 0 — see src/domain/duration.ts.
export function TimeoutField({
  seconds,
  onChange,
  disabled = false,
}: {
  seconds: number;
  onChange: (seconds: number) => void;
  disabled?: boolean;
}) {
  const unlimited = seconds === UNLIMITED_TIMEOUT;
  // Ticking Unlimited overwrites the stored duration with 0, so hold on to what it was — unticking
  // then restores the user's own value instead of resetting them to the default. Per-command,
  // because the parent mounts a fresh field for each (keyed by command id).
  const [lastFinite, setLastFinite] = useState(unlimited ? DEFAULT_TIMEOUT_SECONDS : seconds);

  return (
    <Field label="Timeout" htmlFor="schedTimeout">
      <div className="timeout-row">
        <DurationInput
          id="schedTimeout"
          seconds={unlimited ? lastFinite : seconds}
          max={MAX_TIMEOUT_SECONDS}
          disabled={disabled || unlimited}
          aria-label="Timeout (minutes:seconds)"
          onSecondsChange={(value) => {
            // A typed 0 means the same thing the checkbox does.
            if (value <= 0) {
              onChange(UNLIMITED_TIMEOUT);
              return;
            }
            setLastFinite(value);
            onChange(value);
          }}
        />
        <LabeledCheckbox
          checked={unlimited}
          onChange={(checked) => onChange(checked ? UNLIMITED_TIMEOUT : lastFinite)}
        >
          Unlimited
        </LabeledCheckbox>
      </div>
      <p className="hint timeout-hint">
        {unlimited
          ? "The command runs for as long as it takes — nothing stops it but the ■ button."
          : `Killed if it's still running after ${formatClockDuration(unlimited ? lastFinite : seconds)}, along with anything it started. Type m:ss (0:43) or h:mm:ss (1:02:03).`}
      </p>
    </Field>
  );
}

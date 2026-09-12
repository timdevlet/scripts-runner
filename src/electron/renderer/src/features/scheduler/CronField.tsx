import { useEffect, useRef, useState } from "react";
import { Field } from "../../components/Field";
import { SelectMenu, type SelectMenuOption } from "../../components/SelectMenu";
import { TextInput } from "../../components/TextInput";
import { formatWhen } from "../../lib/datetime";
import { api, type CronPreview } from "../../stores/api";
import "./CronField.scss";

// The common schedules, so the usual cases need no cron knowledge at all. The expression field
// below stays the ground truth — picking a preset just writes into it.
const PRESETS: readonly { value: string; label: string }[] = [
  { value: "", label: "No schedule (run manually)" },
  { value: "* * * * *", label: "Every minute" },
  { value: "*/5 * * * *", label: "Every 5 minutes" },
  { value: "*/15 * * * *", label: "Every 15 minutes" },
  { value: "0 * * * *", label: "Every hour" },
  { value: "0 9 * * *", label: "Every day at 09:00" },
  { value: "0 9 * * 1-5", label: "Every weekday at 09:00" },
  { value: "0 9 * * 1", label: "Every Monday at 09:00" },
  { value: "0 3 1 * *", label: "1st of the month at 03:00" },
];

// Sentinel for "the expression isn't one of the presets". Not a valid cron expression, so it can
// never collide with a real value.
const CUSTOM = "__custom__";

// What Custom starts from when the schedule was empty — a complete, valid expression is a much
// better starting point than a blank field.
const CUSTOM_SEED = "0 9 * * *";

const OPTIONS: SelectMenuOption[] = [...PRESETS, { value: CUSTOM, label: "Custom…" }];

const DEBOUNCE_MS = 250;

const EMPTY_PREVIEW: CronPreview = { ok: true, error: "", description: "", next: [] };

// The schedule editor: a preset dropdown, the raw cron expression, and a live preview of what it
// means and when it next fires.
//
// The preview is computed in the MAIN process (api.previewCron), not here — it comes from the very
// same parser the scheduler fires from, so what this shows and what actually happens can't drift.
// The line under the field: what the schedule means and when it next fires — or why it won't.
// `describeCron` echoes the expression back for shapes it can't phrase, in which case repeating it
// directly under the input it came from says nothing, so only the times are shown.
function previewText(value: string, preview: CronPreview): string {
  const expr = value.trim();
  if (!expr) return "Runs only when you press ▶.";
  if (!preview.ok) return preview.error;
  const times = preview.next.map((t) => formatWhen(t)).join(", ");
  const phrased = preview.description && preview.description !== expr ? preview.description : "";
  if (!times) return phrased || "This schedule has no upcoming runs.";
  return phrased ? `${phrased} — next ${times}` : `Next: ${times}`;
}

export function CronField({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (cron: string) => void;
  disabled?: boolean;
}) {
  const [preview, setPreview] = useState<CronPreview>(EMPTY_PREVIEW);
  const exprRef = useRef<HTMLInputElement>(null);

  // Debounced so typing an expression doesn't fire an IPC call per keystroke.
  useEffect(() => {
    const expr = value.trim();
    if (!expr) {
      setPreview(EMPTY_PREVIEW);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api.previewCron(expr).then(
        (result) => {
          if (alive) setPreview(result);
        },
        () => {
          if (alive) setPreview(EMPTY_PREVIEW);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [value]);

  const matched = PRESETS.find((p) => p.value === value.trim());
  const selected = matched ? matched.value : CUSTOM;

  const onPreset = (next: string) => {
    // "Custom…" isn't a schedule of its own — the expression field below is already showing
    // whatever is set, so this just puts the cursor in it. A blank schedule gets seeded first so
    // there's a valid expression to edit rather than an empty box.
    if (next === CUSTOM) {
      if (!value.trim()) onChange(CUSTOM_SEED);
      // The field may only be about to appear (seeded from blank), so focus after this render.
      requestAnimationFrame(() => exprRef.current?.focus());
      return;
    }
    onChange(next);
  };

  return (
    <div className="cron-field">
      <Field label="Schedule" className="inline">
        <SelectMenu
          ariaLabel="Schedule"
          value={selected}
          options={OPTIONS}
          onValueChange={onPreset}
          disabled={disabled}
        />
      </Field>
      {/* Shown for every schedule, not just custom ones: the expression is what's actually stored,
          so hiding it behind the preset that produced it would make the two disagree — and there'd
          be no way back to editing it by hand. */}
      {value.trim() !== "" && (
        <Field label="Cron expression (minute hour day month weekday)" htmlFor="cronExpr">
          <TextInput
            id="cronExpr"
            ref={exprRef}
            className="cron-expr"
            placeholder="e.g. 30 2 * * 1-5"
            value={value}
            onValueChange={onChange}
            disabled={disabled}
            aria-invalid={!preview.ok}
          />
        </Field>
      )}
      {/* Always rendered so the panel doesn't jump as the preview resolves (the ErrorText pattern). */}
      <p className={preview.ok ? "cron-preview" : "cron-preview invalid"} aria-live="polite">
        {previewText(value, preview)}
      </p>
    </div>
  );
}

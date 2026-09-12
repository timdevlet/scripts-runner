// Clock-style durations — the `m:ss` / `h:mm:ss` form the Commands tab's timeout field uses, plus
// the policy for what a stored timeout may be. Pure: no I/O, no node imports, no DOM. That's what
// lets the renderer import it directly rather than mirroring a second copy of the parser (if
// anything here ever grows a `node:` dependency, the renderer build fails loudly at that point).

// A command with no timeout recorded predates the setting, so it inherits this rather than
// becoming unlimited by accident: five minutes is long enough for ordinary jobs and short enough
// that a hung one is noticed.
export const DEFAULT_TIMEOUT_SECONDS = 300;

// 0 is the stored form of "no limit" — the Unlimited checkbox.
export const UNLIMITED_TIMEOUT = 0;

// Upper bound for a finite timeout. Not arbitrary: the timer is a setTimeout, and past ~24.8 days
// the delay overflows a 32-bit int and fires IMMEDIATELY — a "very long timeout" would silently
// become an instant kill. A day is well clear of that, and anything longer is what Unlimited is
// for.
export const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

const pad2 = (n: number): string => String(n).padStart(2, "0");

// Seconds → the form the field displays: "0:43", "1:40", "5:00", and "1:02:03" once it passes an
// hour. Unlimited (0) has no clock form and renders empty — the checkbox says it instead.
export function formatClockDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

// Parse what someone types into the field, in seconds; null when it isn't a duration.
//
// Accepted: "43" (a bare number is seconds), "0:43", "1:40", "1:02:03". Minutes and seconds must be
// 0-59 in the positions where they're bounded — "1:75" is a typo, not 2:15 — but the leading unit
// is unbounded, so "90:00" is a legitimate 90 minutes. A single digit after the colon is read the
// way a stopwatch reads it: "1:4" is 1:04.
export function parseClockDuration(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length > 3) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const piece = part.trim();
    if (!/^\d{1,4}$/.test(piece)) return null;
    numbers.push(Number(piece));
  }
  // Every position but the first is a 0-59 sub-unit.
  if (numbers.slice(1).some((n) => n > 59)) return null;
  if (numbers.length === 1) return numbers[0];
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}

// Coerce an untrusted stored/typed value to a valid timeout in seconds. A missing or unreadable
// value falls back to the default rather than to unlimited — the safe direction, since the whole
// point is that a hung command doesn't run forever. An explicit 0 means the user chose Unlimited.
export function normalizeTimeoutSeconds(value: unknown): number {
  if (value === UNLIMITED_TIMEOUT) return UNLIMITED_TIMEOUT;
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TIMEOUT_SECONDS;
  if (n === 0) return UNLIMITED_TIMEOUT;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.round(n));
}

// How a timeout reads in a log line or a run summary.
export function describeTimeout(seconds: number): string {
  return seconds === UNLIMITED_TIMEOUT ? "no timeout" : formatClockDuration(seconds);
}

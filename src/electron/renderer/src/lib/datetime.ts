// Small date/duration formatters for the Commands tab (next-run times, run history). Locale-aware
// via Intl, framework-free so they're unit-testable in the node vitest env like the other lib
// modules.

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// "14:35:02" — the timestamp on a run-output line.
export function formatClock(ms: number): string {
  return CLOCK.format(ms);
}

// "14:35" for today, "Tue 5 Aug, 14:35" otherwise — enough context without a full timestamp on
// every row. `today` is injectable so the tests don't depend on the current date.
export function formatWhen(ms: number, today: Date = new Date()): string {
  const when = new Date(ms);
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();
  return sameDay ? TIME.format(when) : DATE_TIME.format(when);
}

// "0.4s" / "12s" / "3m 05s" / "1h 04m" — a run's wall-clock length, at a useful precision for each
// magnitude.
export function formatDuration(ms: number): string {
  if (ms < 0) return "0.0s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// "in 4 min" / "in 2 h" / "in 3 days" — the lead time on a next-run pill. Past/now reads "due".
export function formatCountdown(target: number, from: number = Date.now()): string {
  const ms = target - from;
  if (ms <= 0) return "due";
  // Anything inside the next minute reads as "under a minute" — rounding here would round 30s up
  // to a flat "in 1 min", which is both wrong and less useful.
  if (ms < 60_000) return "in under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

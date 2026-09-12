// A small, dependency-free cron parser for the scheduler (Settings' Commands tab). Pure — no I/O,
// no timers — so both the scheduler and the "next run" preview run the exact same rules.
//
// Supports the classic 5-field crontab syntax:
//
//   ┌───────── minute       0-59
//   │ ┌─────── hour         0-23
//   │ │ ┌───── day of month 1-31
//   │ │ │ ┌─── month        1-12 or JAN-DEC
//   │ │ │ │ ┌─ day of week  0-7 (0 and 7 are Sunday) or SUN-SAT
//   * * * * *
//
// Each field takes `*`, a number, a `a-b` range, a `a,b,c` list, and a `/n` step on any of those
// (`*/15`, `0-30/5`, `5/10` = from 5 to the field's max, every 10). The `@hourly`-style macros are
// accepted too. Seconds are deliberately not supported: the scheduler ticks once a minute.
//
// Everything is evaluated in LOCAL time, which is what a user setting "every day at 09:00" means.
// DST is handled explicitly in nextRun (see the comment there): a scheduled time inside a
// spring-forward gap runs at the first minute that does exist, and during a fall-back's repeated
// hour every matching wall-clock minute is offered once per pass.

import { errorText } from "./errors.js";

interface CronFields {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  // Whether the day-of-month / day-of-week fields were narrowed (i.e. aren't a bare `*`). When
  // BOTH are, classic cron matches a day if EITHER field matches — see matchesDay.
  domRestricted: boolean;
  dowRestricted: boolean;
}

// Shorthands accepted in place of a 5-field expression, expanded before parsing.
const CRON_MACROS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  // Names accepted instead of numbers, lowercase, indexed from `min`.
  names?: readonly string[];
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTH_NAMES },
  // 0-7 on input; 7 is folded onto 0 (Sunday) after parsing.
  { label: "day of week", min: 0, max: 7, names: DAY_NAMES },
];

// Expand a macro (and normalize whitespace/case) to a plain 5-field expression.
function expand(expr: string): string {
  const trimmed = expr.trim();
  const macro = CRON_MACROS[trimmed.toLowerCase()];
  return (macro ?? trimmed).split(/\s+/).join(" ");
}

// Resolve one term of a field ("*", "5", "mon") to its number, or throw.
function termValue(term: string, spec: FieldSpec): number {
  const named = spec.names?.indexOf(term.toLowerCase());
  if (named != null && named >= 0) return named + spec.min;
  if (!/^\d+$/.test(term)) {
    throw new Error(`"${term}" is not a valid ${spec.label}.`);
  }
  const n = Number(term);
  if (n < spec.min || n > spec.max) {
    throw new Error(`${spec.label} ${n} is out of range (${spec.min}-${spec.max}).`);
  }
  return n;
}

// Parse one whole field ("*/15", "1-5", "mon,wed") into the set of values it matches.
function parseField(text: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const piece = part.trim();
    if (!piece) throw new Error(`Empty ${spec.label} value.`);
    const [range, stepText, ...extra] = piece.split("/");
    if (extra.length > 0)
      throw new Error(`"${piece}" has more than one step in the ${spec.label}.`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new Error(`"${stepText}" is not a valid step for the ${spec.label}.`);
      }
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = spec.min;
      to = spec.max;
    } else if (range.includes("-")) {
      const [a, b, ...rest] = range.split("-");
      if (rest.length > 0) throw new Error(`"${range}" is not a valid ${spec.label} range.`);
      from = termValue(a, spec);
      to = termValue(b, spec);
      if (from > to) throw new Error(`${spec.label} range ${range} runs backwards.`);
    } else {
      from = termValue(range, spec);
      // A bare value with a step counts up to the field's max ("5/10" = 5,15,25,…), matching
      // Vixie cron; without a step it's just the one value.
      to = stepText === undefined ? from : spec.max;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

// Parse a cron expression into the sets it matches. Throws an Error whose message is safe to show
// in the UI (see cronError for the non-throwing form).
export function parseCron(expr: string): CronFields {
  const text = expand(expr);
  if (!text) throw new Error("Enter a schedule.");
  const parts = text.split(" ");
  if (parts.length !== 5) {
    throw new Error(
      `A schedule needs 5 fields (minute hour day month weekday) — got ${parts.length}.`,
    );
  }
  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = parts.map((part, i) =>
    parseField(part, FIELD_SPECS[i]),
  );
  // 7 and 0 both mean Sunday; fold so lookups only ever check 0-6 (what Date#getDay returns).
  const daysOfWeek = new Set([...rawDaysOfWeek].map((d) => (d === 7 ? 0 : d)));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

// Validate without throwing: null when the expression is usable, otherwise the message to show.
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    return errorText(err);
  }
}

export function isValidCron(expr: string): boolean {
  return cronError(expr) === null;
}

// Whether a date's day matches. Classic cron quirk: when BOTH day fields are narrowed, a day
// matches if EITHER does (so "0 0 1 * mon" fires on the 1st *and* on every Monday); when only one
// is narrowed the other is a bare `*` and matches everything anyway.
function matchesDay(f: CronFields, date: Date): boolean {
  if (!f.months.has(date.getMonth() + 1)) return false;
  const dom = f.daysOfMonth.has(date.getDate());
  const dow = f.daysOfWeek.has(date.getDay());
  return f.domRestricted && f.dowRestricted ? dom || dow : dom && dow;
}

// True when `date` (to the minute) is itself a firing time.
export function matchesCron(fields: CronFields, date: Date): boolean {
  return (
    matchesDay(fields, date) &&
    fields.hours.has(date.getHours()) &&
    fields.minutes.has(date.getMinutes())
  );
}

// How far ahead nextRun looks before giving up. A schedule like "0 0 30 2 *" (Feb 30th) never
// matches, so the search has to be bounded. 9 years clears the longest real gap between two
// matches: Feb 29th skips the non-leap turn of a century, so 2096-02-29 → 2104-02-29 is 8 years.
const SEARCH_DAYS = 366 * 9;

const MINUTE_MS = 60_000;

// A local calendar day is at most 25 hours (a DST fall-back), plus slack.
const MAX_MINUTES_PER_DAY = 26 * 60;

// Minutes since local midnight.
const minuteOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();

// The first firing time strictly after `from`, or null when the expression can never match.
//
// The cursor advances in ABSOLUTE time (epoch ms) and each candidate's local wall clock is read
// back off it, rather than being rebuilt with setHours(). That distinction is what makes this
// correct across DST:
//
//  • Fall back. The wall clock 01:30 happens twice, and `new Date(…).setHours(1, 30)` resolves the
//    ambiguity to the FIRST pass — so rebuilding a time while inside the second pass produced an
//    instant an hour in the PAST. nextAt would then already be due, tick() would fire, re-arm to
//    another past instant, and a */15 command would run every minute for the rest of the hour.
//    Advancing absolutely can only ever move forward, so the result is always after `from`, and
//    both passes of a repeated hour are offered to the match independently.
//
//  • Spring forward. The wall clock 02:30 doesn't exist at all. Those minutes are simply never
//    produced by an absolute cursor, so instead of dropping the run, the jump is detected and any
//    scheduled time inside it fires at the first minute that does exist — which is what cron has
//    always done, and what keeps a "@daily"/"0 0 * * *" job from silently skipping a day in the
//    zones (Santiago, Havana, Lord Howe) whose transition lands on midnight itself.
export function nextRun(expr: string | CronFields, from: Date): Date | null {
  const fields = typeof expr === "string" ? parseCron(expr) : expr;
  // Round up to the next whole minute: strictly after `from`, and aligned to cron's resolution.
  let cursor = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  // The first day is entered partway through, so nothing before the cursor counts as skipped.
  let partialDay = true;

  for (let day = 0; day <= SEARCH_DAYS; day++) {
    const dayStart = new Date(cursor);
    const year = dayStart.getFullYear();
    const month = dayStart.getMonth();
    const date = dayStart.getDate();

    if (matchesDay(fields, dayStart)) {
      // Previous minute-of-day seen, for spotting a forward jump. -1 stands for "midnight minus a
      // minute", so a day that begins at 01:00 (a midnight DST gap) reports 00:00–00:59 as skipped.
      let previous = partialDay ? minuteOfDay(dayStart) - 1 : -1;
      for (let i = 0; i < MAX_MINUTES_PER_DAY; i++) {
        const at = new Date(cursor + i * MINUTE_MS);
        // Left the local day (which also covers the 23h day of a spring-forward).
        if (at.getDate() !== date || at.getMonth() !== month || at.getFullYear() !== year) break;
        const current = minuteOfDay(at);
        // A forward jump means the wall-clock minutes in between never happened today; a scheduled
        // one among them fires here, at the first real minute after the gap.
        if (current > previous + 1) {
          for (let m = previous + 1; m < current; m++) {
            if (fields.hours.has(Math.floor(m / 60)) && fields.minutes.has(m % 60)) return at;
          }
        }
        if (fields.hours.has(at.getHours()) && fields.minutes.has(at.getMinutes())) return at;
        previous = current;
      }
    }

    // First instant of the next local day. Building it from the calendar date (rather than adding
    // 24h) keeps the walk on calendar days across both DST directions; a nonexistent local midnight
    // normalizes forward to the first instant that does exist, which is where the scan resumes.
    cursor = new Date(year, month, date + 1, 0, 0, 0, 0).getTime();
    partialDay = false;
  }
  return null;
}

// The next `count` firing times — the Commands tab previews a few so an expression is easy to
// sanity-check. Stops early when the schedule runs out.
export function nextRuns(expr: string | CronFields, from: Date, count: number): Date[] {
  const fields = typeof expr === "string" ? parseCron(expr) : expr;
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const hit = nextRun(fields, cursor);
    if (!hit) break;
    out.push(hit);
    cursor = hit;
  }
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// Render a set as "1, 2 and 5" for the human-readable description.
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// A plain-English summary of an expression, for the schedule line under the cron field and for the
// startup log. Covers the shapes people actually write; anything else falls back to the raw
// expression, which is still honest.
export function describeCron(expr: string): string {
  let fields: CronFields;
  try {
    fields = parseCron(expr);
  } catch {
    return expr.trim();
  }
  const text = expand(expr);
  const [minute, hour, dom, month, dow] = text.split(" ");
  const everyMonth = month === "*";
  const at = (): string => `${pad2([...fields.hours][0])}:${pad2([...fields.minutes][0])}`;
  const singleTime = fields.hours.size === 1 && fields.minutes.size === 1;

  // Sub-hourly shapes.
  if (minute === "*" && hour === "*" && dom === "*" && everyMonth && dow === "*")
    return "Every minute";
  const everyNMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyNMinutes && hour === "*" && dom === "*" && everyMonth && dow === "*") {
    return `Every ${everyNMinutes[1]} minutes`;
  }
  if (hour === "*" && dom === "*" && everyMonth && dow === "*" && fields.minutes.size === 1) {
    return `Every hour at :${pad2([...fields.minutes][0])}`;
  }

  const days =
    dow === "*"
      ? ""
      : joinList([...fields.daysOfWeek].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d]));

  if (singleTime && everyMonth) {
    if (dom === "*" && dow === "*") return `Every day at ${at()}`;
    if (dom === "*") return `Every ${days} at ${at()}`;
    if (dow === "*") {
      const dates = joinList([...fields.daysOfMonth].sort((a, b) => a - b).map(String));
      return `On day ${dates} of every month at ${at()}`;
    }
  }
  return text;
}

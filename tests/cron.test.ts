import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  cronError,
  describeCron,
  isValidCron,
  matchesCron,
  nextRun,
  nextRuns,
  parseCron,
} from "../src/domain/cron.js";

// Everything here is in LOCAL time, like the scheduler itself — the dates are built with the
// local-time Date constructor so the assertions hold in any timezone.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

// 2024-01-01 was a Monday — the anchor for the weekday cases below.
const MONDAY = at(2024, 1, 1, 12, 0);

describe("parseCron", () => {
  it("expands * to the whole range", () => {
    const f = parseCron("* * * * *");
    expect(f.minutes.size).toBe(60);
    expect(f.hours.size).toBe(24);
    expect(f.daysOfMonth.size).toBe(31);
    expect(f.months.size).toBe(12);
    // 0-7 folds 7 onto 0, so Sunday isn't counted twice.
    expect([...f.daysOfWeek].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(f.domRestricted).toBe(false);
    expect(f.dowRestricted).toBe(false);
  });

  it("handles steps, ranges, lists and range-with-step", () => {
    expect([...parseCron("*/15 * * * *").minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0-4 * * * *").minutes]).toEqual([0, 1, 2, 3, 4]);
    expect([...parseCron("0,30 * * * *").minutes]).toEqual([0, 30]);
    expect([...parseCron("0-30/10 * * * *").minutes]).toEqual([0, 10, 20, 30]);
    // A bare value with a step counts up to the field max, like Vixie cron.
    expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45]);
  });

  it("accepts month and weekday names, case-insensitively", () => {
    expect([...parseCron("0 0 1 jan *").months]).toEqual([1]);
    expect([...parseCron("0 0 1 JAN-mar *").months]).toEqual([1, 2, 3]);
    expect([...parseCron("0 0 * * mon-fri").daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("0 0 * * SUN").daysOfWeek]).toEqual([0]);
  });

  it("treats both 0 and 7 as Sunday", () => {
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 0,7").daysOfWeek]).toEqual([0]);
  });

  it("expands the @macros", () => {
    expect(nextRun("@daily", at(2024, 3, 5, 10, 0))).toEqual(at(2024, 3, 6, 0, 0));
    expect(nextRun("@hourly", at(2024, 3, 5, 10, 30))).toEqual(at(2024, 3, 5, 11, 0));
    expect(nextRun("@MONTHLY", at(2024, 3, 5, 10, 0))).toEqual(at(2024, 4, 1, 0, 0));
  });

  it("collapses irregular whitespace", () => {
    expect(isValidCron("  0\t9  *  *   * ")).toBe(true);
  });
});

describe("cronError", () => {
  it("accepts the shapes people actually write", () => {
    for (const expr of ["* * * * *", "*/5 * * * *", "30 2 * * 1-5", "0 0 1,15 * *", "@weekly"]) {
      expect(cronError(expr)).toBeNull();
    }
  });

  it("reports the field that's wrong instead of throwing", () => {
    expect(cronError("")).toMatch(/Enter a schedule/);
    expect(cronError("* * * *")).toMatch(/needs 5 fields/);
    expect(cronError("* * * * * *")).toMatch(/needs 5 fields/);
    expect(cronError("60 * * * *")).toMatch(/minute 60 is out of range/);
    expect(cronError("* 24 * * *")).toMatch(/hour 24 is out of range/);
    expect(cronError("* * 0 * *")).toMatch(/day of month 0 is out of range/);
    expect(cronError("* * * 13 *")).toMatch(/month 13 is out of range/);
    expect(cronError("* * * * 8")).toMatch(/day of week 8 is out of range/);
    expect(cronError("abc * * * *")).toMatch(/not a valid minute/);
    expect(cronError("*/0 * * * *")).toMatch(/not a valid step/);
    expect(cronError("30-10 * * * *")).toMatch(/runs backwards/);
  });
});

describe("nextRun", () => {
  it("returns the next occurrence strictly after the given time", () => {
    // Exactly on a firing minute → the NEXT one, never the same minute again.
    expect(nextRun("0 * * * *", at(2024, 5, 10, 8, 0))).toEqual(at(2024, 5, 10, 9, 0));
    expect(nextRun("*/15 * * * *", at(2024, 5, 10, 8, 7))).toEqual(at(2024, 5, 10, 8, 15));
    expect(nextRun("0 9 * * *", at(2024, 5, 10, 9, 30))).toEqual(at(2024, 5, 11, 9, 0));
  });

  it("rolls over the hour, day, month and year", () => {
    expect(nextRun("30 * * * *", at(2024, 5, 10, 8, 45))).toEqual(at(2024, 5, 10, 9, 30));
    expect(nextRun("0 0 * * *", at(2024, 5, 31, 23, 59))).toEqual(at(2024, 6, 1, 0, 0));
    expect(nextRun("0 0 1 1 *", at(2024, 12, 31, 23, 59))).toEqual(at(2025, 1, 1, 0, 0));
  });

  it("finds the next weekday occurrence", () => {
    // From Monday noon, "weekdays at 09:00" is Tuesday.
    expect(nextRun("0 9 * * 1-5", MONDAY)).toEqual(at(2024, 1, 2, 9, 0));
    // From Friday noon it skips the weekend to Monday.
    expect(nextRun("0 9 * * 1-5", at(2024, 1, 5, 12, 0))).toEqual(at(2024, 1, 8, 9, 0));
  });

  it("matches EITHER day field when both are restricted (classic cron)", () => {
    // "the 15th, or any Monday" — from Jan 2nd (Tuesday) the next Monday is the 8th, which comes
    // before the 15th.
    const hit = nextRun("0 0 15 * mon", at(2024, 1, 2, 0, 0));
    expect(hit).toEqual(at(2024, 1, 8, 0, 0));
    // With only the day-of-month restricted, the weekday field is `*` and doesn't narrow anything.
    expect(nextRun("0 0 15 * *", at(2024, 1, 2, 0, 0))).toEqual(at(2024, 1, 15, 0, 0));
  });

  it("handles a day-of-month that only exists in some months", () => {
    // 2024 is a leap year, so Feb 29th exists…
    expect(nextRun("0 0 29 2 *", at(2024, 1, 1, 0, 0))).toEqual(at(2024, 2, 29, 0, 0));
    // …and the next one after that is four years later.
    expect(nextRun("0 0 29 2 *", at(2024, 3, 1, 0, 0))).toEqual(at(2028, 2, 29, 0, 0));
  });

  it("returns null for a schedule that can never match", () => {
    expect(nextRun("0 0 30 2 *", at(2024, 1, 1, 0, 0))).toBeNull();
    expect(nextRun("0 0 31 4 *", at(2024, 1, 1, 0, 0))).toBeNull();
  });

  it("ignores the seconds and milliseconds of the starting point", () => {
    const from = new Date(2024, 4, 10, 8, 59, 42, 500);
    expect(nextRun("0 * * * *", from)).toEqual(at(2024, 5, 10, 9, 0));
  });
});

// DST. These run the parser in a fixed zone via a child process, because a JS process's timezone
// is fixed at startup — TZ can't be changed from inside the test. Each case is a bug that shipped
// once: the old implementation rebuilt candidate times with setHours(), which resolves an
// ambiguous or nonexistent wall clock however it likes.
function nextRunsIn(tz: string, expr: string, from: string, count = 3): string[] {
  const script = `
    import { nextRuns } from "${new URL("../src/domain/cron.ts", import.meta.url).pathname}";
    const out = nextRuns(${JSON.stringify(expr)}, new Date(${JSON.stringify(from)}), ${count});
    console.log(JSON.stringify(out.map((d) => d.toISOString())));
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: { ...process.env, TZ: tz },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout.trim()) as string[];
}

describe("nextRun across DST", () => {
  it("only ever moves forward through a fall-back's repeated hour", () => {
    // 2024-11-03 in New York: 01:00–02:00 local happens twice (05:00Z–07:00Z). Starting from the
    // SECOND pass of 01:30, the old code returned 01:45 of the FIRST pass — 45 minutes in the past,
    // which made the scheduler re-fire the command every single minute for the rest of the hour.
    const from = "2024-11-03T06:30:00.000Z"; // 01:30 EST, the second pass
    const runs = nextRunsIn("America/New_York", "*/15 * * * *", from, 3);
    expect(runs).toEqual([
      "2024-11-03T06:45:00.000Z",
      "2024-11-03T07:00:00.000Z",
      "2024-11-03T07:15:00.000Z",
    ]);
    // The contract that actually matters: every result is strictly after `from`, and increasing.
    for (const run of runs)
      expect(new Date(run).getTime()).toBeGreaterThan(new Date(from).getTime());
  });

  it("offers a repeated hour's matching minute once per pass", () => {
    // Coming from before the transition, 01:30 comes round twice — once on each side of it.
    const runs = nextRunsIn("America/New_York", "30 1 * * *", "2024-11-03T04:00:00.000Z", 2);
    expect(runs).toEqual(["2024-11-03T05:30:00.000Z", "2024-11-03T06:30:00.000Z"]);
  });

  it("runs a time inside a spring-forward gap at the first minute that exists", () => {
    // 2024-03-10 in New York: 02:00–03:00 local never happens. A 02:30 job runs at 03:00.
    expect(nextRunsIn("America/New_York", "30 2 * * *", "2024-03-09T17:00:00.000Z", 1)).toEqual([
      "2024-03-10T07:00:00.000Z", // 03:00 EDT
    ]);
  });

  it("does not skip a day when the DST gap swallows local midnight", () => {
    // Santiago's 2024-09-08 has no local 00:00 (23:59:59 → 01:00:00). A daily-at-midnight job used
    // to vanish for that whole day; it must run at 01:00 instead.
    const runs = nextRunsIn("America/Santiago", "0 0 * * *", "2024-09-07T15:00:00.000Z", 3);
    const local = runs.map((r) => r.slice(0, 10));
    expect(local).toEqual(["2024-09-08", "2024-09-09", "2024-09-10"]);
    expect(runs[0]).toBe("2024-09-08T04:00:00.000Z"); // 01:00 local, the first real minute
  });
});

describe("nextRuns", () => {
  it("returns consecutive occurrences", () => {
    expect(nextRuns("*/30 * * * *", at(2024, 5, 10, 8, 5), 3)).toEqual([
      at(2024, 5, 10, 8, 30),
      at(2024, 5, 10, 9, 0),
      at(2024, 5, 10, 9, 30),
    ]);
  });

  it("stops early when the schedule runs out", () => {
    expect(nextRuns("0 0 30 2 *", at(2024, 1, 1), 3)).toEqual([]);
  });
});

describe("matchesCron", () => {
  it("is true exactly on a firing minute", () => {
    const fields = parseCron("30 2 * * *");
    expect(matchesCron(fields, at(2024, 5, 10, 2, 30))).toBe(true);
    expect(matchesCron(fields, at(2024, 5, 10, 2, 31))).toBe(false);
    expect(matchesCron(fields, at(2024, 5, 10, 3, 30))).toBe(false);
  });
});

describe("describeCron", () => {
  it("puts the common shapes into words", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/5 * * * *")).toBe("Every 5 minutes");
    expect(describeCron("15 * * * *")).toBe("Every hour at :15");
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("30 2 * * 1")).toBe("Every Monday at 02:30");
    expect(describeCron("0 9 * * 1-5")).toBe(
      "Every Monday, Tuesday, Wednesday, Thursday and Friday at 09:00",
    );
    expect(describeCron("0 3 1 * *")).toBe("On day 1 of every month at 03:00");
    expect(describeCron("0 3 1,15 * *")).toBe("On day 1 and 15 of every month at 03:00");
  });

  it("falls back to the expression itself for anything it can't phrase", () => {
    expect(describeCron("0 9 * 3 *")).toBe("0 9 * 3 *");
    // Invalid input is echoed back rather than throwing — the error line reports the problem.
    expect(describeCron("nonsense")).toBe("nonsense");
  });
});

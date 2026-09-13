import { beforeEach, describe, expect, it } from "vitest";
import type { JsScript } from "../src/domain/js-script.js";
import type { ScheduledCommand } from "../src/domain/scheduled.js";
import type { RunHandle, RunOutcome } from "../src/os/run-command.js";
import { createScheduler, type RunnableJob, type Scheduler } from "../src/scheduler.js";

// The scheduler with its clock and its process runner replaced: tick() is driven by hand and no
// child process is ever spawned, so every case here is deterministic.

const command = (over: Partial<ScheduledCommand> = {}): ScheduledCommand => ({
  id: "a",
  name: "Backup",
  command: "node backup.js",
  cron: "",
  enabled: false,
  cwd: "",
  timeoutSeconds: 300,
  ...over,
});

// A stand-in for a running child process the test finishes (or watches get killed) by hand.
interface FakeRun {
  cmd: RunnableJob;
  emit: (stream: "stdout" | "stderr", text: string) => void;
  finish: (outcome: RunOutcome) => void;
  kills: number;
}

function fakeRunner() {
  const runs: FakeRun[] = [];
  const run = (
    cmd: RunnableJob,
    onOutput: (stream: "stdout" | "stderr", text: string) => void,
  ): RunHandle => {
    let settle!: (outcome: RunOutcome) => void;
    const done = new Promise<RunOutcome>((resolve) => {
      settle = resolve;
    });
    const entry: FakeRun = { cmd, emit: onOutput, finish: settle, kills: 0 };
    runs.push(entry);
    return {
      done,
      kill: () => {
        entry.kills++;
        // A real kill ends the process; mirror that so `done` settles like it would.
        settle({ code: null, signal: "SIGTERM" });
      },
    };
  };
  return { run, runs, last: () => runs[runs.length - 1] };
}

// Let the `done.then(...)` continuations inside the scheduler run.
const settled = () => new Promise<void>((r) => setTimeout(r, 0));

// 2024-05-10 08:00 local — the anchor every schedule below is relative to.
const START = new Date(2024, 4, 10, 8, 0, 0, 0).getTime();

let clock: number;
let runner: ReturnType<typeof fakeRunner>;
let ids: number;
let scheduler: Scheduler;

function build(): Scheduler {
  return createScheduler({
    run: runner.run,
    now: () => clock,
    log: () => {},
    logError: () => {},
    newId: () => `run-${++ids}`,
  });
}

beforeEach(() => {
  clock = START;
  ids = 0;
  runner = fakeRunner();
  scheduler = build();
});

describe("scheduling", () => {
  it("fires an enabled command once its cron time arrives", () => {
    scheduler.setCommands([command({ cron: "*/15 * * * *", enabled: true })]);
    expect(scheduler.snapshot().nextRunAt.a).toBe(new Date(2024, 4, 10, 8, 15).getTime());

    clock = new Date(2024, 4, 10, 8, 14).getTime();
    scheduler.tick();
    expect(runner.runs).toHaveLength(0); // not due yet

    clock = new Date(2024, 4, 10, 8, 15).getTime();
    scheduler.tick();
    expect(runner.runs).toHaveLength(1);
    // The next occurrence is armed straight away.
    expect(scheduler.snapshot().nextRunAt.a).toBe(new Date(2024, 4, 10, 8, 30).getTime());
  });

  it("never fires a command that is disabled, unscheduled, or empty", () => {
    scheduler.setCommands([
      command({ id: "off", cron: "* * * * *", enabled: false }),
      command({ id: "manual", cron: "", enabled: true }),
      command({ id: "blank", cron: "* * * * *", enabled: true, command: "  " }),
    ]);
    const { nextRunAt } = scheduler.snapshot();
    expect(nextRunAt).toEqual({ off: null, manual: null, blank: null });

    clock += 60_000;
    scheduler.tick();
    expect(runner.runs).toHaveLength(0);
  });

  it("arms nothing for a cron expression that doesn't parse or can never match", () => {
    scheduler.setCommands([
      command({ id: "bad", cron: "not a cron", enabled: true }),
      command({ id: "impossible", cron: "0 0 30 2 *", enabled: true }),
    ]);
    expect(scheduler.snapshot().nextRunAt).toEqual({ bad: null, impossible: null });
    clock += 60_000;
    scheduler.tick();
    expect(runner.runs).toHaveLength(0);
  });

  it("fires once — not once per missed slot — after the machine was asleep", () => {
    scheduler.setCommands([command({ cron: "*/5 * * * *", enabled: true })]);
    // Jump forward three hours, past ~36 missed slots.
    clock = new Date(2024, 4, 10, 11, 2).getTime();
    scheduler.tick();
    expect(runner.runs).toHaveLength(1);
    // …and it resumes its normal cadence from now, not from the slot it missed.
    expect(scheduler.snapshot().nextRunAt.a).toBe(new Date(2024, 4, 10, 11, 5).getTime());
  });

  it("skips a scheduled run while the previous one is still going", async () => {
    scheduler.setCommands([command({ cron: "* * * * *", enabled: true })]);
    clock += 60_000;
    scheduler.tick();
    expect(runner.runs).toHaveLength(1);

    clock += 60_000;
    scheduler.tick();
    expect(runner.runs).toHaveLength(1); // still busy — skipped, not queued

    runner.last().finish({ code: 0, signal: null });
    await settled();
    clock += 60_000;
    scheduler.tick();
    expect(runner.runs).toHaveLength(2); // free again
  });
});

describe("running on demand", () => {
  it("runs regardless of the schedule or the enabled switch", () => {
    scheduler.setCommands([command({ cron: "", enabled: false })]);
    expect(scheduler.runNow("a")).toEqual({ ok: true });
    expect(runner.runs).toHaveLength(1);
  });

  it("refuses an unknown id, an empty command, and a second concurrent run", () => {
    scheduler.setCommands([command(), command({ id: "blank", command: "" })]);
    expect(scheduler.runNow("nope").ok).toBe(false);
    expect(scheduler.runNow("blank")).toEqual({
      ok: false,
      error: "This command has nothing to run.",
    });
    expect(scheduler.runNow("a").ok).toBe(true);
    expect(scheduler.runNow("a")).toEqual({ ok: false, error: "This command is already running." });
    expect(runner.runs).toHaveLength(1);
  });

  it("records a synchronous spawn failure as a finished, failed run", () => {
    const failing = createScheduler({
      now: () => clock,
      log: () => {},
      logError: () => {},
      newId: () => "run-x",
      run: () => {
        throw new Error("spawn EACCES");
      },
    });
    failing.setCommands([command()]);
    expect(failing.runNow("a")).toEqual({ ok: false, error: "spawn EACCES" });
    const [record] = failing.snapshot().runs;
    // The run must not be left sitting at "running" forever.
    expect(record.status).toBe("failed");
    expect(record.error).toBe("spawn EACCES");
    expect(failing.snapshot().running).toEqual([]);
  });
});

describe("run records", () => {
  it("goes running → success on a clean exit", async () => {
    scheduler.setCommands([command()]);
    scheduler.runNow("a");
    let [record] = scheduler.snapshot().runs;
    expect(record.status).toBe("running");
    expect(record.trigger).toBe("manual");
    expect(record.finishedAt).toBeNull();
    expect(scheduler.snapshot().running).toEqual(["a"]);

    clock += 2100;
    runner.last().finish({ code: 0, signal: null });
    await settled();

    [record] = scheduler.snapshot().runs;
    expect(record.status).toBe("success");
    expect(record.exitCode).toBe(0);
    expect(record.finishedAt).toBe(START + 2100);
    expect(scheduler.snapshot().running).toEqual([]);
  });

  it("marks a non-zero exit and a spawn error as failed", async () => {
    scheduler.setCommands([command(), command({ id: "b" })]);
    scheduler.runNow("a");
    runner.last().finish({ code: 1, signal: null });
    scheduler.runNow("b");
    runner.last().finish({ code: null, signal: null, error: "spawn ENOENT" });
    await settled();

    const byId = Object.fromEntries(scheduler.snapshot().runs.map((r) => [r.commandId, r]));
    expect(byId.a.status).toBe("failed");
    expect(byId.a.exitCode).toBe(1);
    expect(byId.b.status).toBe("failed");
    expect(byId.b.error).toBe("spawn ENOENT");
  });

  it("marks a run the time limit killed as timed out, not just stopped", async () => {
    scheduler.setCommands([command({ timeoutSeconds: 100 })]);
    scheduler.runNow("a");
    clock += 100_000;
    // What the real runner reports once its own timer fired and killed the tree.
    runner.last().finish({ code: null, signal: "SIGTERM", timedOut: true });
    await settled();

    const [record] = scheduler.snapshot().runs;
    expect(record.status).toBe("timeout");
    // The limit is named, so the log says why it ended rather than just that it did.
    expect(record.error).toBe("timed out after 1:40");
  });

  it("passes each command's own limit to the runner, with Unlimited meaning no timer", () => {
    const seen: (number | undefined)[] = [];
    const spy = createScheduler({
      now: () => clock,
      log: () => {},
      logError: () => {},
      newId: () => `run-${++ids}`,
      run: (cmd, onOutput) => {
        seen.push(cmd.timeoutSeconds);
        return runner.run(cmd, onOutput);
      },
    });
    spy.setCommands([command({ timeoutSeconds: 43 }), command({ id: "b", timeoutSeconds: 0 })]);
    spy.runNow("a");
    spy.runNow("b");
    expect(seen).toEqual([43, 0]);
  });

  it("calls a stopped run stopped even if its limit expired at the same moment", async () => {
    // The user pressing ■ already knows why it ended; the automatic kill is the surprising one, so
    // an explicit stop keeps its label.
    scheduler.setCommands([command({ timeoutSeconds: 1 })]);
    scheduler.runNow("a");
    scheduler.stop("a");
    await settled();
    expect(scheduler.snapshot().runs[0].status).toBe("cancelled");
  });

  it("marks a stopped run cancelled, not failed", async () => {
    scheduler.setCommands([command()]);
    scheduler.runNow("a");
    expect(scheduler.stop("a")).toBe(true);
    await settled();

    expect(scheduler.snapshot().runs[0].status).toBe("cancelled");
    expect(runner.runs[0].kills).toBe(1);
    expect(scheduler.stop("a")).toBe(false); // nothing left to stop
  });

  it("tags a scheduled run as such, and keeps the name it ran under", async () => {
    scheduler.setCommands([command({ name: "Nightly", cron: "* * * * *", enabled: true })]);
    clock += 60_000;
    scheduler.tick();
    runner.last().finish({ code: 0, signal: null });
    await settled();

    const [record] = scheduler.snapshot().runs;
    expect(record.trigger).toBe("schedule");
    expect(record.commandName).toBe("Nightly");

    // Renaming the command afterwards doesn't rewrite the history.
    scheduler.setCommands([command({ name: "Renamed", cron: "* * * * *", enabled: true })]);
    expect(scheduler.snapshot().runs[0].commandName).toBe("Nightly");
  });

  it("keeps only the newest runs per command, and independently per command", async () => {
    const capped = createScheduler({
      run: runner.run,
      now: () => clock,
      log: () => {},
      logError: () => {},
      newId: () => `run-${++ids}`,
      maxRunsPerCommand: 2,
    });
    capped.setCommands([command(), command({ id: "b" })]);
    for (let i = 0; i < 4; i++) {
      capped.runNow("a");
      runner.last().finish({ code: 0, signal: null });
      await settled();
      clock += 1000;
    }
    capped.runNow("b");
    runner.last().finish({ code: 0, signal: null });
    await settled();

    const runs = capped.snapshot().runs;
    expect(runs.filter((r) => r.commandId === "a")).toHaveLength(2);
    expect(runs.filter((r) => r.commandId === "b")).toHaveLength(1);
    // Newest first — the two survivors are the last two of the four.
    expect(runs.filter((r) => r.commandId === "a").map((r) => r.id)).toEqual(["run-4", "run-3"]);
    // The dropped runs' output goes with them.
    expect(capped.output("run-1")).toEqual([]);
  });
});

describe("captured output", () => {
  it("records the command line, the output, and the exit summary", async () => {
    scheduler.setCommands([command({ command: "echo hi", cwd: "/tmp", timeoutSeconds: 300 })]);
    scheduler.runNow("a");
    runner.last().emit("stdout", "hi");
    runner.last().emit("stderr", "a warning");
    clock += 500;
    runner.last().finish({ code: 0, signal: null });
    await settled();

    const lines = scheduler.output(scheduler.snapshot().runs[0].id);
    expect(lines.map((l) => [l.stream, l.text])).toEqual([
      ["system", "$ echo hi"],
      ["system", "(in /tmp)"],
      // The limit this run was held to, so a later timeout has its explanation right above it.
      ["system", "(timeout 5:00)"],
      ["stdout", "hi"],
      ["stderr", "a warning"],
      ["system", "exit 0 — 0.5s"],
    ]);
  });

  it("mirrors a run's output into the app log, so it isn't only in the run record", async () => {
    // Without this the Logs tab (and the dev terminal) shows a run starting and finishing with
    // nothing in between — a script's own console output never reached the log stream.
    const logged: string[] = [];
    const errored: string[] = [];
    scheduler = createScheduler({
      run: runner.run,
      now: () => clock,
      log: (m) => logged.push(m),
      logError: (m) => errored.push(m),
      newId: () => `run-${++ids}`,
    });
    scheduler.setCommands([command({ command: "echo hi" })]);
    scheduler.runNow("a");
    runner.last().emit("stdout", "hi");
    runner.last().emit("stderr", "a warning");
    runner.last().finish({ code: 0, signal: null });
    await settled();

    expect(logged).toContain("hi");
    expect(errored).toContain("a warning");
  });

  it("caps a chatty run and flags it truncated", () => {
    const capped = createScheduler({
      run: runner.run,
      now: () => clock,
      log: () => {},
      logError: () => {},
      newId: () => "run-1",
      maxOutputLines: 5,
    });
    capped.setCommands([command()]);
    capped.runNow("a");
    for (let i = 0; i < 20; i++) runner.last().emit("stdout", `line ${i}`);

    const record = capped.snapshot().runs[0];
    expect(record.truncated).toBe(true);
    // Two "system" lines (the command line and its timeout) precede the 20 emitted ones.
    expect(record.totalLines).toBe(22);
    const lines = capped.output("run-1");
    expect(lines).toHaveLength(5);
    // The most recent output is what's kept.
    expect(lines[4].text).toBe("line 19");
  });

  it("keeps counting past the cap, so a live tail never stops refreshing", () => {
    const capped = createScheduler({
      run: runner.run,
      now: () => clock,
      log: () => {},
      logError: () => {},
      newId: () => "run-1",
      maxOutputLines: 5,
    });
    capped.setCommands([command()]);
    capped.runNow("a");
    // The renderer re-fetches a running command's output whenever totalLines changes. A count of
    // the RETAINED lines would freeze at 5 here, and the tail of a chatty command would stop
    // updating on screen while it was still producing output.
    const counts: number[] = [];
    for (let i = 0; i < 12; i++) {
      runner.last().emit("stdout", `line ${i}`);
      counts.push(capped.snapshot().runs[0].totalLines);
    }
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBe(counts[i - 1] + 1);
    expect(capped.output("run-1")).toHaveLength(5); // still capped, as intended
  });

  it("returns an empty list for an unknown run id", () => {
    expect(scheduler.output("nope")).toEqual([]);
  });
});

describe("editing the command list", () => {
  it("re-arms the schedule when a command's cron changes", () => {
    scheduler.setCommands([command({ cron: "0 9 * * *", enabled: true })]);
    expect(scheduler.snapshot().nextRunAt.a).toBe(new Date(2024, 4, 10, 9, 0).getTime());
    scheduler.setCommands([command({ cron: "0 10 * * *", enabled: true })]);
    expect(scheduler.snapshot().nextRunAt.a).toBe(new Date(2024, 4, 10, 10, 0).getTime());
    // Turning the switch off disarms it entirely.
    scheduler.setCommands([command({ cron: "0 10 * * *", enabled: false })]);
    expect(scheduler.snapshot().nextRunAt.a).toBeNull();
  });

  it("deleting a command kills its live run and drops its history", async () => {
    scheduler.setCommands([command(), command({ id: "b" })]);
    scheduler.runNow("a");
    scheduler.runNow("b");
    runner.runs[1].finish({ code: 0, signal: null });
    await settled();
    expect(scheduler.snapshot().runs).toHaveLength(2);

    scheduler.setCommands([command({ id: "b" })]);
    await settled();

    expect(runner.runs[0].kills).toBe(1);
    const snapshot = scheduler.snapshot();
    expect(snapshot.runs.every((r) => r.commandId === "b")).toBe(true);
    expect(snapshot.running).toEqual([]);
    expect(snapshot.nextRunAt).toEqual({ b: null });
  });

  it("hands out snapshot copies, so a caller can't mutate the scheduler's state", () => {
    scheduler.setCommands([command()]);
    scheduler.runNow("a");
    const first = scheduler.snapshot().runs[0];
    first.status = "success";
    expect(scheduler.snapshot().runs[0].status).toBe("running");
  });
});

describe("js scripts", () => {
  const script = (over: Partial<JsScript> = {}): JsScript => ({
    id: "s",
    name: "List",
    source: "console.log({{dir}})",
    paramValues: { dir: "/tmp" },
    cron: "",
    enabled: false,
    cwd: "",
    timeoutSeconds: 300,
    ...over,
  });

  it("does not arm a schedule until every extracted param has a value", () => {
    scheduler.setScripts([
      script({ cron: "* * * * *", enabled: true, paramValues: {} }),
      script({ id: "filled", cron: "* * * * *", enabled: true, paramValues: { dir: "/tmp" } }),
    ]);
    expect(scheduler.snapshot().nextRunAt.s).toBeNull();
    expect(scheduler.snapshot().nextRunAt.filled).toBe(new Date(2024, 4, 10, 8, 1).getTime());

    clock += 60_000;
    scheduler.tick();
    expect(runner.runs.map((r) => r.cmd.id)).toEqual(["filled"]);
    expect(runner.runs[0].cmd.kind).toBe("js");
  });

  it("arms a script that only uses a template default", () => {
    scheduler.setScripts([
      script({
        source: "console.log({{dir=/tmp}})",
        paramValues: {},
        cron: "* * * * *",
        enabled: true,
      }),
    ]);
    expect(scheduler.snapshot().nextRunAt.s).not.toBeNull();
  });

  it("runs a script on demand through the js runner", () => {
    scheduler.setScripts([script({ enabled: false, cron: "" })]);
    expect(scheduler.runNow("s")).toEqual({ ok: true });
    const job = runner.last().cmd;
    expect(job.kind).toBe("js");
    if (job.kind === "js") expect(job.source).toBe("console.log({{dir}})");
  });

  it("refuses an empty script and a second concurrent run", () => {
    scheduler.setScripts([script(), script({ id: "blank", source: "", paramValues: {} })]);
    expect(scheduler.runNow("blank")).toEqual({
      ok: false,
      error: "This script has nothing to run.",
    });
    expect(scheduler.runNow("s").ok).toBe(true);
    expect(scheduler.runNow("s")).toEqual({ ok: false, error: "This script is already running." });
  });

  it("records the rewritten params in the run log", () => {
    scheduler.setScripts([script({ cwd: "/work" })]);
    scheduler.runNow("s");
    const lines = scheduler.output(scheduler.snapshot().runs[0].id);
    expect(lines.map((l) => l.text)).toEqual([
      "$ node (script)",
      '(dir = "/tmp")',
      "(in /work)",
      "(timeout 5:00)",
    ]);
  });

  it("saving commands does not drop a live script run or its history", async () => {
    scheduler.setCommands([command()]);
    scheduler.setScripts([script()]);
    scheduler.runNow("s");
    scheduler.setCommands([]);
    expect(runner.last().kills).toBe(0);
    expect(scheduler.snapshot().running).toEqual(["s"]);
    runner.last().finish({ code: 0, signal: null });
    await settled();
    expect(scheduler.snapshot().runs[0].commandId).toBe("s");
  });

  it("fires a due script on tick", () => {
    scheduler.setScripts([script({ cron: "* * * * *", enabled: true })]);
    clock += 60_000;
    scheduler.tick();
    expect(runner.runs).toHaveLength(1);
    expect(runner.last().cmd.kind).toBe("js");
    expect(scheduler.snapshot().runs[0].trigger).toBe("schedule");
  });
});

describe("subscribe and dispose", () => {
  it("notifies subscribers as runs start, emit output, and finish", async () => {
    let notifications = 0;
    const stop = scheduler.subscribe(() => {
      notifications++;
    });
    scheduler.setCommands([command()]);
    expect(notifications).toBe(1);
    scheduler.runNow("a");
    const afterStart = notifications;
    expect(afterStart).toBeGreaterThan(1);
    runner.last().emit("stdout", "x");
    expect(notifications).toBeGreaterThan(afterStart);
    runner.last().finish({ code: 0, signal: null });
    await settled();
    const afterFinish = notifications;

    stop();
    scheduler.runNow("a");
    expect(notifications).toBe(afterFinish); // unsubscribed
  });

  it("kills everything still running and stops ticking", async () => {
    scheduler.setCommands([command({ cron: "* * * * *", enabled: true })]);
    scheduler.runNow("a");
    scheduler.dispose();
    await settled();

    expect(runner.runs[0].kills).toBe(1);
    clock += 600_000;
    scheduler.tick();
    expect(runner.runs).toHaveLength(1); // a disposed scheduler ignores ticks
  });
});

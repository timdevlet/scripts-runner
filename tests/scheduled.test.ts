import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_SECONDS } from "../src/domain/duration.js";
import {
  emptyScheduledCommand,
  normalizeScheduledCommands,
  parseScheduleFile,
  SCHEDULE_FILE_VERSION,
  type ScheduledCommand,
  scheduledCommandLabel,
  serializeScheduleFile,
} from "../src/domain/scheduled.js";

const command = (over: Partial<ScheduledCommand> = {}): ScheduledCommand => ({
  id: "a",
  name: "Backup",
  command: "node backup.js",
  cron: "0 2 * * *",
  enabled: true,
  cwd: "",
  timeoutSeconds: 300,
  ...over,
});

describe("normalizeScheduledCommands", () => {
  it("fills every field so the form inputs are always controlled", () => {
    expect(normalizeScheduledCommands([{ id: "a", command: "ls" }])).toEqual([
      { id: "a", name: "", command: "ls", cron: "", enabled: false, cwd: "", timeoutSeconds: 300 },
    ]);
  });

  it("trims the surrounding whitespace but keeps a multi-line command intact", () => {
    const [cmd] = normalizeScheduledCommands([
      { id: "a", name: "  Build  ", command: "  cd /tmp\nnode build.js  ", cwd: " /tmp " },
    ]);
    expect(cmd.name).toBe("Build");
    expect(cmd.command).toBe("cd /tmp\nnode build.js");
    expect(cmd.cwd).toBe("/tmp");
  });

  it("keeps a half-filled row — it's a draft, not corruption", () => {
    expect(normalizeScheduledCommands([{ id: "a" }])).toHaveLength(1);
    expect(normalizeScheduledCommands([{ id: "a", name: "Just a name" }])[0].command).toBe("");
  });

  it("keeps an invalid cron expression so the user can fix it", () => {
    expect(normalizeScheduledCommands([{ id: "a", cron: "not a cron" }])[0].cron).toBe(
      "not a cron",
    );
  });

  it("only ever enables on a strict true", () => {
    expect(normalizeScheduledCommands([{ id: "a", enabled: "yes" }])[0].enabled).toBe(false);
    expect(normalizeScheduledCommands([{ id: "a", enabled: 1 }])[0].enabled).toBe(false);
    expect(normalizeScheduledCommands([{ id: "a", enabled: true }])[0].enabled).toBe(true);
  });

  it("drops non-objects and non-arrays", () => {
    expect(normalizeScheduledCommands([null, "x", 5, { id: "a" }])).toHaveLength(1);
    expect(normalizeScheduledCommands("garbage")).toEqual([]);
    expect(normalizeScheduledCommands(undefined)).toEqual([]);
  });

  it("mints an id for an entry that has none", () => {
    const list = normalizeScheduledCommands([{ command: "a" }, { command: "b" }]);
    expect(list.map((c) => c.id)).toEqual(["sched-1", "sched-2"]);
  });

  it("makes duplicate ids unique so one command can't shadow another", () => {
    const list = normalizeScheduledCommands([
      { id: "same", command: "a" },
      { id: "same", command: "b" },
      { id: "same", command: "c" },
    ]);
    expect(new Set(list.map((c) => c.id)).size).toBe(3);
    // The first keeps the original id, so existing run history stays attached to it.
    expect(list[0].id).toBe("same");
  });

  it("coerces non-string fields to empty rather than leaking them through", () => {
    const [cmd] = normalizeScheduledCommands([{ id: "a", name: 42, command: ["ls"], cron: {} }]);
    expect(cmd).toEqual({
      id: "a",
      name: "",
      command: "",
      cron: "",
      enabled: false,
      cwd: "",
      timeoutSeconds: 300,
    });
  });
});

describe("scheduledCommandLabel", () => {
  it("prefers the name, then the command, then a placeholder", () => {
    expect(scheduledCommandLabel({ name: "Backup", command: "node b.js" })).toBe("Backup");
    expect(scheduledCommandLabel({ name: "  ", command: "node b.js" })).toBe("node b.js");
    expect(scheduledCommandLabel({ name: "", command: "" })).toBe("Untitled command");
  });

  it("shortens a long command so a row stays one line", () => {
    const label = scheduledCommandLabel({ name: "", command: "x".repeat(80) });
    expect(label).toHaveLength(41); // 40 chars + the ellipsis
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("the schedule file", () => {
  it("round-trips through serialize → JSON.parse → parseScheduleFile", () => {
    const commands = [command(), command({ id: "b", name: "Other", enabled: false })];
    const restored = parseScheduleFile(JSON.parse(serializeScheduleFile(commands)));
    expect(restored).toEqual(commands);
  });

  it("writes a versioned, pretty-printed file with a trailing newline", () => {
    const text = serializeScheduleFile([command()]);
    expect(JSON.parse(text).version).toBe(SCHEDULE_FILE_VERSION);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "commands": [');
  });

  it("also accepts a bare array, so a hand-written file still imports", () => {
    expect(parseScheduleFile([{ id: "a", command: "ls" }])).toHaveLength(1);
  });

  it("reads an empty or unrecognizable file as no commands", () => {
    expect(parseScheduleFile({})).toEqual([]);
    expect(parseScheduleFile({ version: 1 })).toEqual([]);
    expect(parseScheduleFile(null)).toEqual([]);
    expect(parseScheduleFile("nope")).toEqual([]);
  });
});

describe("emptyScheduledCommand", () => {
  it("starts blank and disabled, so a new row can't run before it's filled in", () => {
    expect(emptyScheduledCommand("x")).toEqual({
      id: "x",
      name: "",
      command: "",
      cron: "",
      enabled: false,
      cwd: "",
      // Five minutes, not unlimited: a new row is guarded before it is ever run.
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    });
  });
});

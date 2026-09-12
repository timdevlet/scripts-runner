// File adapter for the scheduled commands: scheduled-commands.json, kept in the app data dir.
//
// The shape and its coercion rules live in src/domain/scheduled.ts.

import { join } from "node:path";
import {
  normalizeScheduledCommands,
  parseScheduleFile,
  type ScheduledCommand,
  serializeScheduleFile,
} from "./domain/scheduled.js";
import { createSerializedWriter, readJsonFile, writeTextFileAtomic } from "./os/json-file.js";
import { dataDir } from "./paths.js";

// SCHEDULED_COMMANDS_PATH overrides the location; otherwise the file sits in the data dir, so a
// packaged app picks it up from the same writable folder as settings.json.
export function scheduledCommandsPath(): string {
  return process.env.SCHEDULED_COMMANDS_PATH?.trim() || join(dataDir(), "scheduled-commands.json");
}

// Read the stored commands. A missing file is the normal first-run state (no commands yet); a
// malformed one throws, so the caller can tell the user rather than silently starting empty and
// then overwriting their file on the next autosave.
export async function loadScheduledCommands(): Promise<ScheduledCommand[]> {
  const raw = await readJsonFile(scheduledCommandsPath());
  if (raw === undefined) return [];
  return parseScheduleFile(raw);
}

// Writes are whole-file replaces (the renderer always sends the complete list), and the Commands
// tab autosaves on a debounce, so two saves can overlap. The serialized writer keeps the last
// write the one that lands.
const serialized = createSerializedWriter();

export function saveScheduledCommands(commands: ScheduledCommand[]): Promise<void> {
  return serialized(async () => {
    const text = serializeScheduleFile(normalizeScheduledCommands(commands));
    await writeTextFileAtomic(scheduledCommandsPath(), text);
  });
}

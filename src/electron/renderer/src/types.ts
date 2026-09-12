// Renderer-local aliases for the shared main-process types. Type-only re-exports — erased at
// build, so none of the node-side modules are ever loaded in the sandboxed renderer.

export type { JsScript } from "../../../domain/js-script.js";
export type {
  RunLine,
  RunRecord,
  RunStatus,
  RunTrigger,
  ScheduledCommand,
  SchedulerSnapshot,
} from "../../../domain/scheduled.js";
export type { ThemePreference } from "../../../domain/theme.js";
export type { LogEntry } from "../../../log.js";
export type { AppSettings } from "../../settings.js";

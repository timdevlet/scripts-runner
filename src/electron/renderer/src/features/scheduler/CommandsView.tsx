import { useEffect, useState } from "react";
import { emptyScheduledCommand } from "../../../../../domain/scheduled";
import { Button } from "../../components/Button";
import { Column, Columns } from "../../components/Columns";
import { ConfirmPopover } from "../../components/ConfirmPopover";
import { ErrorText } from "../../components/ErrorText";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExportIcon,
  ImportIcon,
  LogsIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
} from "../../components/icons";
import { RailNav } from "../../components/RailNav";
import { SwitchField } from "../../components/SwitchField";
import { TextArea } from "../../components/TextArea";
import { TextInput } from "../../components/TextInput";
import { useScheduler } from "../../hooks/useScheduler";
import type { ToastKind } from "../../lib/toasts";
import { api } from "../../stores/api";
import type { ScheduledCommand } from "../../types";
import { CronField } from "./CronField";
import { RunHistory } from "./RunHistory";
import { commandLabel, ScheduledCommandList } from "./ScheduledCommandList";
import { TimeoutField } from "./TimeoutField";
import "./CommandsView.scss";

function blankCommand(): ScheduledCommand {
  return emptyScheduledCommand(crypto.randomUUID());
}

// Whether the logs column is open. Module scope, not component state: this view remounts on every
// visit to the tab, and having the column close itself each time would be a nuisance. Off to start
// with, so the two working columns stay roomy in a narrow window.
let logsColumnOpen = false;
// Whether the command list is zipped shut to its rail — kept at module scope for the same reason.
let listColumnCollapsed = false;

// The Commands tab (shown only when the `enableScheduler` feature flag is on): user-defined shell
// commands, each with an optional cron schedule and its own run log.
//
// Up to three full-height panes (see components/Columns): the command list, the selected command's
// configuration, and — behind the Logs toggle — that command's run history beside it rather than
// below. The tab itself never scrolls; each pane scrolls on its own, so a long list or a chatty run
// log can't push the fields you're editing off the window.
//
// There is no Save button: every edit autosaves to scheduled-commands.json (see useScheduler),
// which is also exactly what Export writes and Import reads.
export function CommandsView({ onToast }: { onToast: (kind: ToastKind, text: string) => void }) {
  const scheduler = useScheduler();
  const { commands, snapshot } = scheduler;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Ids with an in-flight ▶ / ■ press, so the button can't be double-fired while the IPC is out.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(logsColumnOpen);
  const [listCollapsed, setListCollapsed] = useState(listColumnCollapsed);

  const toggleLogs = () => {
    logsColumnOpen = !showLogs;
    setShowLogs(logsColumnOpen);
  };

  const setCollapsed = (next: boolean) => {
    listColumnCollapsed = next;
    setListCollapsed(next);
  };

  // Select the first command once the list loads, and never strand the panel on a deleted one.
  useEffect(() => {
    if (commands.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!commands.some((c) => c.id === selectedId)) setSelectedId(commands[0].id);
  }, [commands, selectedId]);

  const selected = commands.find((c) => c.id === selectedId) ?? null;
  const isRunning = selected != null && snapshot.running.includes(selected.id);
  const runs = selected ? snapshot.runs.filter((r) => r.commandId === selected.id) : [];

  const onAdd = () => {
    const command = blankCommand();
    scheduler.add(command);
    setSelectedId(command.id);
  };

  // ▶ runs the STORED command, so flush the autosave first — otherwise a command typed seconds ago
  // would run its previous text. Takes an id, not a command: the list's row buttons call it too.
  const onRun = async (commandId: string) => {
    setBusyId(commandId);
    try {
      await scheduler.flush();
      const result = await api.runScheduledCommand(commandId);
      if (!result.ok) onToast("error", result.error || "Could not start that command.");
    } finally {
      setBusyId(null);
    }
  };

  const onStop = async (cmd: ScheduledCommand) => {
    setBusyId(cmd.id);
    try {
      await api.stopScheduledCommand(cmd.id);
    } finally {
      setBusyId(null);
    }
  };

  const onExport = async () => {
    await scheduler.flush();
    const result = await api.exportScheduledCommands();
    if (result.ok) onToast("success", `Exported to ${result.path}`);
    else if (!result.cancelled) onToast("error", result.error || "Export failed.");
  };

  // Imported commands are appended (never a destructive replace) and arrive disabled with fresh
  // ids — see the import handler in src/electron/scheduler-ipc.ts.
  const onImport = async () => {
    const result = await api.importScheduledCommands();
    if (!result.ok) {
      if (!result.cancelled) onToast("error", result.error || "Import failed.");
      return;
    }
    if (result.commands.length === 0) {
      onToast("error", "That file has no commands in it.");
      return;
    }
    scheduler.append(result.commands);
    setSelectedId(result.commands[0].id);
    onToast(
      "success",
      `Imported ${result.commands.length} command${result.commands.length === 1 ? "" : "s"} — review, then enable.`,
    );
  };

  const onDelete = (cmd: ScheduledCommand) => {
    if (snapshot.running.includes(cmd.id)) void api.stopScheduledCommand(cmd.id);
    scheduler.remove(cmd.id);
  };

  return (
    // .modal comes along for the shared body typography only (p.hint, inline <code>, .error) —
    // .commands-view overrides its padding and, unlike the Settings body, doesn't scroll.
    <div className="modal commands-view">
      <Columns
        className={`sched-columns${showLogs ? " with-logs" : ""}${
          listCollapsed ? " list-collapsed" : ""
        }`}
      >
        <Column
          title="Commands"
          className="sched-list-column"
          // Drag the seam to its right to trade width with the configuration pane; double-click it
          // to go back to the default. Same for the run log's seam below.
          resize={{ cssVar: "--col-list", min: 150, max: 400 }}
          // …or hide the list altogether, down to the rail below, when the configuration pane
          // wants the width more than the list does.
          collapsed={listCollapsed}
          titleAction={
            <IconButton
              className="column-title-action"
              aria-label="Hide the command list"
              title="Hide the command list"
              onClick={() => setCollapsed(true)}
            >
              <ChevronLeftIcon />
            </IconButton>
          }
          rail={
            <>
              <IconButton
                aria-label="Show the command list"
                title="Show the command list"
                onClick={() => setCollapsed(false)}
              >
                <ChevronRightIcon />
              </IconButton>
              <RailNav
                ariaLabel="Command to configure"
                items={commands.map((c) => ({
                  id: c.id,
                  label: commandLabel(c),
                  running: snapshot.running.includes(c.id),
                }))}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
              <IconButton
                aria-label={showLogs ? "Hide the runs column" : "Show the runs column"}
                title={showLogs ? "Hide runs" : "Show runs"}
                aria-pressed={showLogs}
                onClick={toggleLogs}
              >
                <LogsIcon />
              </IconButton>
            </>
          }
          footer={
            <>
              <div className="sched-transfer">
                <Button
                  onClick={() => void onExport()}
                  disabled={commands.length === 0}
                  title="Write every command to a JSON file"
                >
                  <ExportIcon /> Export
                </Button>
                <Button
                  onClick={() => void onImport()}
                  disabled={scheduler.readOnly}
                  title="Append the commands from a JSON file"
                >
                  <ImportIcon /> Import
                </Button>
              </div>
              {/* Toggles the third column. Off by default so the two working columns stay roomy in
                  a narrow window; the choice sticks for the rest of the session. */}
              <Button className="sched-logs-toggle" aria-pressed={showLogs} onClick={toggleLogs}>
                <LogsIcon /> {showLogs ? "Hide logs" : "Logs"}
              </Button>
            </>
          }
        >
          <ScheduledCommandList
            commands={commands}
            snapshot={snapshot}
            selectedId={selectedId}
            pendingId={busyId}
            onSelect={setSelectedId}
            onRun={(id) => void onRun(id)}
            onAdd={onAdd}
          />
        </Column>

        {/* Run / Stop and Delete live in the pane's footer rather than after the last field, so
            they're one click away however far down the form is scrolled. */}
        <Column
          title={selected ? commandLabel(selected) : "Command"}
          className="sched-panel"
          footer={
            selected && (
              <div className="sched-actions">
                {isRunning ? (
                  <Button
                    variant="danger"
                    disabled={busyId === selected.id}
                    onClick={() => void onStop(selected)}
                  >
                    <StopIcon /> Stop
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    disabled={busyId === selected.id || !selected.command.trim()}
                    onClick={() => void onRun(selected.id)}
                  >
                    <PlayIcon /> Run now
                  </Button>
                )}
                {/* Deleting takes the command's run history with it and can't be undone, so it
                    asks first — right here, so the row it's about stays on screen. */}
                <ConfirmPopover
                  triggerClassName="sched-delete"
                  triggerVariant="danger"
                  disabled={scheduler.readOnly}
                  trigger={
                    <>
                      <TrashIcon /> Delete
                    </>
                  }
                  title={`Delete "${commandLabel(selected)}"?`}
                  description={
                    isRunning
                      ? "It's running right now — it will be stopped. Its run history goes too."
                      : "Its run history goes with it. This can't be undone."
                  }
                  confirmLabel="Delete"
                  onConfirm={() => onDelete(selected)}
                />
              </div>
            )
          }
        >
          {scheduler.readOnly && (
            <p className="hint">
              Editing is disabled until the stored file is readable again — fix or remove it, then
              restart the app.
            </p>
          )}
          {selected ? (
            <>
              <Field label="Name" htmlFor="schedName">
                <TextInput
                  id="schedName"
                  placeholder="e.g. Nightly backup"
                  value={selected.name}
                  onValueChange={(v) => scheduler.update(selected.id, { name: v })}
                  disabled={scheduler.readOnly}
                />
              </Field>
              <Field label="Command" htmlFor="schedCommand">
                <TextArea
                  id="schedCommand"
                  className="sched-command"
                  rows={3}
                  placeholder={"e.g. node ~/scripts/backup.js"}
                  value={selected.command}
                  onValueChange={(v) => scheduler.update(selected.id, { command: v })}
                  disabled={scheduler.readOnly}
                />
              </Field>
              <p className="hint">Runs through your login shell, so your normal PATH applies.</p>
              <Field label="Working directory (optional)" htmlFor="schedCwd">
                <TextInput
                  id="schedCwd"
                  placeholder="Defaults to the app's own folder"
                  value={selected.cwd}
                  onValueChange={(v) => scheduler.update(selected.id, { cwd: v })}
                  disabled={scheduler.readOnly}
                />
              </Field>
              {/* Keyed per command: the field holds draft edit state, which must not carry
                  over when the selection changes. */}
              <TimeoutField
                key={`timeout-${selected.id}`}
                seconds={selected.timeoutSeconds}
                onChange={(v) => scheduler.update(selected.id, { timeoutSeconds: v })}
                disabled={scheduler.readOnly}
              />
              <CronField
                value={selected.cron}
                onChange={(v) => scheduler.update(selected.id, { cron: v })}
                disabled={scheduler.readOnly}
              />
              <SwitchField
                id="schedEnabled"
                label="Run on this schedule automatically"
                checked={selected.enabled}
                onChange={(v) => scheduler.update(selected.id, { enabled: v })}
              />
            </>
          ) : (
            // Also the tab's introduction: with no command selected there's nothing else to say
            // here, and this is where someone who has just arrived is looking.
            <p className="hint">
              {scheduler.loading ? (
                "Loading your commands…"
              ) : (
                <>
                  Commands you define yourself — each one is a shell command line (say,{" "}
                  <code>node ~/scripts/backup.js</code>) that can run on a schedule, or just when
                  you press ▶. They run through your login shell, so your normal PATH applies, and
                  they're stored in <code>scheduled-commands.json</code> — which is also what Export
                  and Import use. Add one with “+ Add command”.
                </>
              )}
            </p>
          )}
        </Column>

        {/* Third pane: the selected command's run log, beside its configuration rather than below
            it, so you can watch a run while editing what it does. It divides its own height
            between the run strip and the output, hence scroll={false}. */}
        {showLogs && (
          <Column
            title="Runs"
            className="sched-logs"
            scroll={false}
            resize={{ cssVar: "--col-runs", min: 190, max: 520 }}
          >
            {selected ? (
              <RunHistory runs={runs} />
            ) : (
              <p className="hint">Select a command to see its runs.</p>
            )}
          </Column>
        )}
      </Columns>

      {/* Below the panes, not inside one: a store-level failure isn't about any single command, and
          it must not be scrollable out of sight. Rendered only when there is one — this layout
          spends its height on the panes. */}
      {scheduler.error && <ErrorText>{scheduler.error}</ErrorText>}
    </div>
  );
}

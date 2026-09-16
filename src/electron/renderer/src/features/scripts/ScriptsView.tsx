import { useEffect, useState } from "react";
import { emptyJsScript } from "../../../../../domain/js-script";
import { extractScriptParams } from "../../../../../domain/script-params";
import { Button } from "../../components/Button";
import { CodeEditor } from "../../components/CodeEditor";
import { Column, Columns } from "../../components/Columns";
import { ConfirmPopover } from "../../components/ConfirmPopover";
import { ErrorText } from "../../components/ErrorText";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  ExportIcon,
  ImportIcon,
  LogsIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
} from "../../components/icons";
import { RailNav } from "../../components/RailNav";
import { SwitchField } from "../../components/SwitchField";
import { TextInput } from "../../components/TextInput";
import { useScripts } from "../../hooks/useScripts";
import type { ToastKind } from "../../lib/toasts";
import { api } from "../../stores/api";
import type { JsScript } from "../../types";
import { CronField } from "../scheduler/CronField";
import { RunHistory } from "../scheduler/RunHistory";
import { TimeoutField } from "../scheduler/TimeoutField";
import "../scheduler/CommandsView.scss";
import { ScriptList, scriptLabel } from "./ScriptList";
import { ScriptParamFields } from "./ScriptParamFields";
import "./ScriptsView.scss";

function blankScript(): JsScript {
  return emptyJsScript(crypto.randomUUID());
}

let logsColumnOpen = false;
// Whether the script list is zipped shut to its rail. Module scope for the same reason as the logs
// toggle above: the view remounts on every visit to the tab, and re-collapsing it each time would
// undo a choice the user made about how much room the editor gets.
let listColumnCollapsed = false;

// The Scripts tab: user-defined JS templates with {{param}} holes extracted to fields, each with
// an optional cron schedule and its own run log. Layout matches Commands (list / editor / runs).
export function ScriptsView({ onToast }: { onToast: (kind: ToastKind, text: string) => void }) {
  const store = useScripts();
  const { scripts, snapshot } = store;
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  useEffect(() => {
    if (scripts.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!scripts.some((s) => s.id === selectedId)) setSelectedId(scripts[0].id);
  }, [scripts, selectedId]);

  const selected = scripts.find((s) => s.id === selectedId) ?? null;
  const isRunning = selected != null && snapshot.running.includes(selected.id);
  const isEditingExternally = selected != null && store.editingExternally.includes(selected.id);
  const runs = selected ? snapshot.runs.filter((r) => r.commandId === selected.id) : [];
  const params = selected ? extractScriptParams(selected.source) : [];

  const onAdd = () => {
    const script = blankScript();
    store.add(script);
    setSelectedId(script.id);
  };

  const onRun = async (scriptId: string) => {
    setBusyId(scriptId);
    try {
      await store.flush();
      const result = await api.runJsScript(scriptId);
      if (!result.ok) onToast("error", result.error || "Could not start that script.");
    } finally {
      setBusyId(null);
    }
  };

  const onStop = async (script: JsScript) => {
    setBusyId(script.id);
    try {
      await api.stopJsScript(script.id);
    } finally {
      setBusyId(null);
    }
  };

  // Hand the script to VS Code. The main process owns the temp file and the watcher; saves come
  // back as source edits, so there is nothing to poll or merge here.
  const onEditExternally = async (script: JsScript) => {
    const result = await api.editJsScript(script.id);
    if (!result.ok) onToast("error", result.error || "Could not open VS Code.");
    else if (!store.editingExternally.includes(script.id)) {
      onToast("success", "Opened in VS Code — saves come back here.");
    }
  };

  const onExport = async () => {
    await store.flush();
    const result = await api.exportJsScripts();
    if (result.ok) onToast("success", `Exported to ${result.path}`);
    else if (!result.cancelled) onToast("error", result.error || "Export failed.");
  };

  const onImport = async () => {
    const result = await api.importJsScripts();
    if (!result.ok) {
      if (!result.cancelled) onToast("error", result.error || "Import failed.");
      return;
    }
    if (result.scripts.length === 0) {
      onToast("error", "That file has no scripts in it.");
      return;
    }
    store.append(result.scripts);
    setSelectedId(result.scripts[0].id);
    onToast(
      "success",
      `Imported ${result.scripts.length} script${result.scripts.length === 1 ? "" : "s"} — review, then enable.`,
    );
  };

  const onDelete = (script: JsScript) => {
    if (snapshot.running.includes(script.id)) void api.stopJsScript(script.id);
    store.remove(script.id);
  };

  return (
    <div className="modal commands-view">
      <Columns
        className={`sched-columns${showLogs ? " with-logs" : ""}${
          listCollapsed ? " list-collapsed" : ""
        }`}
      >
        <Column
          title="Scripts"
          className="sched-list-column"
          resize={{ cssVar: "--col-list", min: 150, max: 400 }}
          collapsed={listCollapsed}
          // Zip it shut, for when the script being edited wants the width more than the list does.
          titleAction={
            <IconButton
              className="column-title-action"
              aria-label="Hide the script list"
              title="Hide the script list"
              onClick={() => setCollapsed(true)}
            >
              <ChevronLeftIcon />
            </IconButton>
          }
          // What's left of the pane once it's collapsed: the way back to the list, the list itself
          // as one-letter circles (switching scripts is the thing you'd otherwise have to open the
          // pane for), and the runs toggle that otherwise lives in the footer.
          rail={
            <>
              <IconButton
                aria-label="Show the script list"
                title="Show the script list"
                onClick={() => setCollapsed(false)}
              >
                <ChevronRightIcon />
              </IconButton>
              <RailNav
                ariaLabel="Script to configure"
                items={scripts.map((s) => ({
                  id: s.id,
                  label: scriptLabel(s),
                  running: snapshot.running.includes(s.id),
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
                  disabled={scripts.length === 0}
                  title="Write every script to a JSON file"
                >
                  <ExportIcon /> Export
                </Button>
                <Button
                  onClick={() => void onImport()}
                  disabled={store.readOnly}
                  title="Append the scripts from a JSON file"
                >
                  <ImportIcon /> Import
                </Button>
              </div>
              <Button className="sched-logs-toggle" aria-pressed={showLogs} onClick={toggleLogs}>
                <LogsIcon /> {showLogs ? "Hide logs" : "Logs"}
              </Button>
            </>
          }
        >
          <ScriptList
            scripts={scripts}
            snapshot={snapshot}
            selectedId={selectedId}
            pendingId={busyId}
            onSelect={setSelectedId}
            onRun={(id) => void onRun(id)}
            onAdd={onAdd}
          />
        </Column>

        <Column
          title={selected ? scriptLabel(selected) : "Script"}
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
                    disabled={busyId === selected.id || !selected.source.trim()}
                    onClick={() => void onRun(selected.id)}
                  >
                    <PlayIcon /> Run now
                  </Button>
                )}
                <Button
                  disabled={store.readOnly}
                  onClick={() => void onEditExternally(selected)}
                  title="Open this script in VS Code — saves there come back to the app"
                >
                  <CodeIcon /> {isEditingExternally ? "Show in VS Code" : "Edit in VS Code"}
                </Button>
                <ConfirmPopover
                  triggerClassName="sched-delete"
                  triggerVariant="danger"
                  disabled={store.readOnly}
                  trigger={
                    <>
                      <TrashIcon /> Delete
                    </>
                  }
                  title={`Delete "${scriptLabel(selected)}"?`}
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
          {store.readOnly && (
            <p className="hint">
              Editing is disabled until the stored file is readable again — fix or remove it, then
              restart the app.
            </p>
          )}
          {selected ? (
            <>
              <Field label="Name" htmlFor="scriptName">
                <TextInput
                  id="scriptName"
                  placeholder="e.g. List directory"
                  value={selected.name}
                  onValueChange={(v) => store.update(selected.id, { name: v })}
                  disabled={store.readOnly}
                />
              </Field>
              <CodeEditor
                id="scriptSource"
                label="Script"
                placeholder={"e.g. console.log(fs.readdirSync({{dir}}))"}
                value={selected.source}
                onValueChange={(v) => store.update(selected.id, { source: v })}
                disabled={store.readOnly}
              />
              <p className="hint">
                {isEditingExternally ? (
                  <>
                    Open in VS Code — saving there updates this script. Close the tab to end the
                    session; edits made here in the meantime are replaced by the next save.
                  </>
                ) : (
                  <>
                    Local JavaScript, run with <code>node</code>. Holes like{" "}
                    <code>{"{{dir}}"}</code> become fields below; they are JS expressions, so use{" "}
                    <code>params.dir</code> inside strings. Name a kind to get a control instead of
                    a text box: <code>{"{{on:bool}}"}</code>, <code>{"{{out:dir}}"}</code>,{" "}
                    <code>{"{{pick:one(a|b)}}"}</code>, <code>{"{{tags:many(a|b)}}"}</code> — every
                    value still arrives as a string.
                  </>
                )}
              </p>
              <ScriptParamFields
                params={params}
                values={selected.paramValues}
                disabled={store.readOnly}
                onChange={(name, value) =>
                  store.update(selected.id, {
                    paramValues: { ...selected.paramValues, [name]: value },
                  })
                }
              />
              <Field label="Working directory (optional)" htmlFor="scriptCwd">
                <TextInput
                  id="scriptCwd"
                  placeholder="Defaults to the app's own folder"
                  value={selected.cwd}
                  onValueChange={(v) => store.update(selected.id, { cwd: v })}
                  disabled={store.readOnly}
                />
              </Field>
              <TimeoutField
                key={`timeout-${selected.id}`}
                seconds={selected.timeoutSeconds}
                onChange={(v) => store.update(selected.id, { timeoutSeconds: v })}
                disabled={store.readOnly}
              />
              <CronField
                value={selected.cron}
                onChange={(v) => store.update(selected.id, { cron: v })}
                disabled={store.readOnly}
              />
              <SwitchField
                id="scriptEnabled"
                label="Run on this schedule automatically"
                checked={selected.enabled}
                onChange={(v) => store.update(selected.id, { enabled: v })}
              />
            </>
          ) : (
            <p className="hint">
              {store.loading ? (
                "Loading your scripts…"
              ) : (
                <>
                  JavaScript you write yourself, run locally with <code>node</code>. Put holes like{" "}
                  <code>{"{{dir}}"}</code> in the source and they become fields you fill in before
                  running — so a script can be a reusable template. They can also run on a schedule,
                  and they're stored in <code>js-scripts.json</code>. Add one with “+ Add script”.
                </>
              )}
            </p>
          )}
        </Column>

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
              <p className="hint">Select a script to see its runs.</p>
            )}
          </Column>
        )}
      </Columns>

      {store.error && <ErrorText>{store.error}</ErrorText>}
    </div>
  );
}

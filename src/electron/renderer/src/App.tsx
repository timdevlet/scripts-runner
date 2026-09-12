import { useCallback, useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { IconButton } from "./components/IconButton";
import { TrashIcon } from "./components/icons";
import { SegmentedControl } from "./components/SegmentedControl";
import { ToastStack } from "./components/ToastStack";
import { LogFooter } from "./features/log/LogFooter";
import { LogView } from "./features/log/LogView";
import { CommandsView } from "./features/scheduler/CommandsView";
import { ScriptsView } from "./features/scripts/ScriptsView";
import { SettingsView } from "./features/settings/SettingsView";
import { useLogs } from "./hooks/useLogs";
import { useOpenSettingsEvent } from "./hooks/useOpenSettingsEvent";
import { useToasts } from "./hooks/useToasts";
import { api } from "./stores/api";
import type { AppSettings } from "./types";

type View = "commands" | "scripts" | "settings" | "logs";

const TABS: readonly { value: View; label: string }[] = [
  { value: "commands", label: "Commands" },
  { value: "scripts", label: "Scripts" },
  { value: "settings", label: "Settings" },
  { value: "logs", label: "Logs" },
];

export default function App() {
  const logs = useLogs();
  const toasts = useToasts();
  const [view, setView] = useState<View>("commands");
  const [autoScroll, setAutoScroll] = useState(true);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const openSettings = useCallback(async () => {
    setView("settings");
    setSettings(await api.getSettings());
  }, []);

  const onTabChange = useCallback(
    (next: View) => {
      if (next === "settings") {
        void openSettings();
        return;
      }
      setSettings(null);
      setView(next);
    },
    [openSettings],
  );

  useOpenSettingsEvent(openSettings);

  return (
    <>
      <AppHeader
        title="Scheduler"
        tabs={
          <SegmentedControl
            className="segmented--pill"
            ariaLabel="View"
            value={view}
            options={TABS}
            onChange={onTabChange}
          />
        }
        actions={
          view === "logs" ? (
            <IconButton aria-label="Clear log" title="Clear log" onClick={logs.clear}>
              <TrashIcon />
            </IconButton>
          ) : undefined
        }
      />

      {view === "commands" && <CommandsView onToast={toasts.push} />}
      {view === "scripts" && <ScriptsView onToast={toasts.push} />}
      {view === "settings" && settings && <SettingsView initialSettings={settings} />}
      {view === "logs" && (
        <>
          <LogView entries={logs.entries} autoScroll={autoScroll} />
          <LogFooter
            autoScroll={autoScroll}
            onAutoScrollChange={setAutoScroll}
            count={logs.count}
          />
        </>
      )}

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </>
  );
}

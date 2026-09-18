import { useCallback, useEffect, useState } from "react";
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
import { type Tab, tabRoute } from "./lib/route";
import { api } from "./stores/api";
import { lastRoute, navigate, useRoute } from "./stores/route";
import type { AppSettings } from "./types";

const TABS: readonly { value: Tab; label: string }[] = [
  { value: "scripts", label: "Scripts" },
  { value: "commands", label: "Commands" },
  { value: "settings", label: "Settings" },
  { value: "logs", label: "Logs" },
];

export default function App() {
  const logs = useLogs();
  const toasts = useToasts();
  // Which tab is showing comes from the route (the window's hash — see lib/route.ts), as does the
  // selection inside the Scripts and Commands tabs. That is what lets a tab be left and come back
  // to as it was.
  const { tab: view } = useRoute();
  const [autoScroll, setAutoScroll] = useState(true);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // SettingsView seeds its form from the settings it mounts with, so they are read fresh on every
  // visit and cleared on the way out — a stale copy from an earlier visit must not be what it
  // sees while the new read is still on its way.
  useEffect(() => {
    if (view !== "settings") {
      setSettings(null);
      return;
    }
    let live = true;
    void api.getSettings().then((loaded) => {
      if (live) setSettings(loaded);
    });
    return () => {
      live = false;
    };
  }, [view]);

  // A tab picked from the bar opens where it was last left: the same script or command, with the
  // Runs pane as it was.
  const onTabChange = useCallback((next: Tab) => navigate(lastRoute(next)), []);

  const openSettings = useCallback(() => navigate(tabRoute("settings")), []);
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

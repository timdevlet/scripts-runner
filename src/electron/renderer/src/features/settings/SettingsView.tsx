import { useEffect, useState } from "react";
import { THEME_PREFERENCES } from "../../../../../domain/theme";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { SegmentedControl } from "../../components/SegmentedControl";
import { SettingsGroup } from "../../components/SettingsGroup";
import { SwitchField } from "../../components/SwitchField";
import { updateActionLabel, useUpdate } from "../../hooks/useUpdate";
import { api } from "../../stores/api";
import type { AppSettings, ThemePreference } from "../../types";
import "./SettingsView.scss";

const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = THEME_PREFERENCES.map(
  (value) => ({
    value,
    label: value[0].toUpperCase() + value.slice(1),
  }),
);

export function SettingsView({ initialSettings }: { initialSettings: AppSettings }) {
  const [draft, setDraft] = useState(initialSettings);
  const [appVersion, setAppVersion] = useState("");
  // A newer release on GitHub (or null while up to date), shared with any other update UI.
  const { update: available, act } = useUpdate();
  // Outcome of a manual "Check for updates" click — the auto-check is silent, but a button the
  // user pressed has to say something back even when the answer is "nothing to do".
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState("");

  useEffect(() => {
    void api.getAppVersion().then(setAppVersion);
  }, []);

  const update = (partial: Partial<AppSettings>) => {
    setDraft((current) => ({ ...current, ...partial }));
    void api.saveSettings(partial);
  };

  const onCheck = async (): Promise<void> => {
    setChecking(true);
    setCheckNote("");
    // Forced: this check is a click, so it must hit the network rather than replay a cached
    // answer from the startup check.
    const result = await api.checkForUpdate(true);
    setChecking(false);
    // An update turns into the row above via the store push, so only the quiet answers land here.
    if (!result.ok) setCheckNote(result.error);
    else if (!result.update) setCheckNote("You're up to date.");
  };

  const onAct = async (): Promise<void> => {
    const error = await act();
    setCheckNote(error ?? "");
  };

  return (
    <div className="modal settings-view">
      <SettingsGroup title="Appearance">
        <Field label="Theme" className="inline">
          <SegmentedControl
            ariaLabel="Theme"
            value={draft.theme}
            options={THEME_OPTIONS}
            onChange={(theme) => update({ theme })}
          />
        </Field>
      </SettingsGroup>
      <SettingsGroup title="App">
        <SwitchField
          id="minimizeToTray"
          label="Close window to the tray (keep schedules running)"
          checked={draft.minimizeToTrayOnClose}
          onChange={(minimizeToTrayOnClose) => update({ minimizeToTrayOnClose })}
        />
        <SwitchField
          id="launchAtLogin"
          label="Launch at login"
          checked={draft.launchAtLogin}
          onChange={(launchAtLogin) => update({ launchAtLogin })}
        />
        <p className="hint">
          Schedules only fire while this app is running. Closing to the tray (or launching at login)
          keeps them armed in the background.
        </p>
      </SettingsGroup>
      <SettingsGroup title="Updates">
        <div className="update-row">
          <span>
            {available?.phase === "downloaded"
              ? `Version ${available.version} is downloaded — restart to finish updating.`
              : available
                ? `Version ${available.version} is available${appVersion ? ` (you have ${appVersion})` : ""}.`
                : `You're on version ${appVersion || "…"}.`}
          </span>
          {available ? (
            <Button
              variant="primary"
              pill
              size="small"
              disabled={available.phase === "downloading"}
              onClick={() => void onAct()}
            >
              {updateActionLabel(available)}
            </Button>
          ) : (
            <Button pill size="small" disabled={checking} onClick={() => void onCheck()}>
              {checking ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </div>
        {checkNote && <p className="hint update-note">{checkNote}</p>}
        <p className="hint">
          {available?.mode === "browser"
            ? "The download opens in your browser — replace the app with it to finish updating."
            : "Updates are checked automatically in the background."}
        </p>
      </SettingsGroup>
    </div>
  );
}

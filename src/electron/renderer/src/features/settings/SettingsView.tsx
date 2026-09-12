import { useState } from "react";
import { THEME_PREFERENCES } from "../../../../../domain/theme";
import { Field } from "../../components/Field";
import { SegmentedControl } from "../../components/SegmentedControl";
import { SettingsGroup } from "../../components/SettingsGroup";
import { SwitchField } from "../../components/SwitchField";
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

  const update = (partial: Partial<AppSettings>) => {
    setDraft((current) => ({ ...current, ...partial }));
    void api.saveSettings(partial);
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
    </div>
  );
}

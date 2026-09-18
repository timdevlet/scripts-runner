import { useEffect, useState } from "react";
import { secretNameError } from "../../../../../domain/secrets";
import { Button } from "../../components/Button";
import { ConfirmPopover } from "../../components/ConfirmPopover";
import { ErrorText } from "../../components/ErrorText";
import { SettingsGroup } from "../../components/SettingsGroup";
import { TextInput } from "../../components/TextInput";
import { api, type SecretsResult } from "../../stores/api";
import "./SecretsSection.scss";

// The secret vault: API keys and tokens a command or script refers to by name, so the name is all
// that ends up in script.json or scheduled-commands.json.
//
// Values are shown in place, in plain text: this is the one screen the vault is managed from, and
// a key you can't read is a key you can't check or copy. Each row's field is prefilled; edit it and
// Save (or Enter) writes the new value, and the field snaps back to whatever the vault holds if
// the edit is abandoned.
export function SecretsSection() {
  const [names, setNames] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  // The new-secret row, and the per-secret edits in progress, keyed by name. A name absent from
  // `edits` shows the vault's value.
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});

  const adopt = (result: SecretsResult): boolean => {
    setNames(result.names);
    setValues(result.values);
    setPath(result.path);
    setError(result.ok ? "" : result.error);
    return result.ok;
  };

  useEffect(() => {
    // Absent if the scheduler failed to start; the vault is then the smaller problem, and the
    // section simply stays empty rather than reporting an error it can't explain.
    void api.getSecrets().then(adopt, () => undefined);
  }, []);

  const save = async (name: string, value: string): Promise<boolean> =>
    adopt(await api.setSecret(name, value));

  const onAdd = async (): Promise<void> => {
    const nameError = secretNameError(newName);
    if (nameError) return setError(nameError);
    if (await save(newName.trim(), newValue)) {
      setNewName("");
      setNewValue("");
    }
  };

  const dropEdit = (name: string): void =>
    setEdits((current) => {
      const { [name]: _dropped, ...rest } = current;
      return rest;
    });

  const onSave = async (name: string): Promise<void> => {
    const value = edits[name];
    if (value === undefined || value === values[name]) return dropEdit(name);
    if (await save(name, value)) dropEdit(name);
  };

  return (
    <SettingsGroup title="Secrets">
      {names.length > 0 && (
        <ul className="secret-list">
          {names.map((name) => {
            const shown = edits[name] ?? values[name] ?? "";
            const changed = edits[name] !== undefined && edits[name] !== values[name];
            return (
              <li key={name}>
                <code className="secret-name">{name}</code>
                <TextInput
                  aria-label={`Value of ${name}`}
                  value={shown}
                  onValueChange={(value) => setEdits((current) => ({ ...current, [name]: value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void onSave(name);
                    if (e.key === "Escape") dropEdit(name);
                  }}
                />
                <Button
                  size="small"
                  pill
                  variant={changed ? "primary" : "default"}
                  disabled={!changed || shown === ""}
                  onClick={() => void onSave(name)}
                >
                  Save
                </Button>
                <ConfirmPopover
                  trigger="Remove"
                  triggerClassName="secret-remove"
                  title={`Remove ${name}?`}
                  description="Anything referring to it stops running until it's set again."
                  confirmLabel="Remove"
                  onConfirm={() => void api.removeSecret(name).then(adopt)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <div className="secret-add">
        <TextInput
          aria-label="Secret name"
          placeholder="DB_API_KEY"
          value={newName}
          onValueChange={setNewName}
        />
        <TextInput
          aria-label="Secret value"
          placeholder="Value"
          value={newValue}
          onValueChange={setNewValue}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onAdd();
          }}
        />
        <Button
          variant="primary"
          size="small"
          pill
          disabled={!newValue}
          onClick={() => void onAdd()}
        >
          Add
        </Button>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      <p className="hint">
        Refer to a secret by name — <code>{"{{DB_API_KEY}}"}</code> in a command, or typed into a
        script's parameter field — and the value is passed to the run through its environment
        instead of being written into the command or the script's config. In a command it expands
        like <code>$DB_API_KEY</code> does, so keep it out of single quotes.
      </p>
      <p className="hint">
        Values are kept in {path || "secrets.json"}, readable only by you, and are masked in run
        output. Nothing else the app writes contains them — which is what makes a scripts folder
        safe to put in git.
      </p>
    </SettingsGroup>
  );
}

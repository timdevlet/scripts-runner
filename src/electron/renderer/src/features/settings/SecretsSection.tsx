import { useEffect, useState } from "react";
import { secretNameError } from "../../../../../domain/secrets";
import { Button } from "../../components/Button";
import { ConfirmPopover } from "../../components/ConfirmPopover";
import { ErrorText } from "../../components/ErrorText";
import { SettingsGroup } from "../../components/SettingsGroup";
import { TextInput } from "../../components/TextInput";
import { api } from "../../stores/api";
import "./SecretsSection.scss";

// The secret vault: API keys and tokens a command or script refers to by name, so the name is all
// that ends up in script.json or scheduled-commands.json.
//
// This tab only ever handles names. A value goes one way — typed here, sent to the main process,
// written to secrets.json — and never comes back, so an existing secret's field is blank rather
// than pre-filled, and typing in it replaces the value instead of editing it. That is also why
// there is no "show" toggle: the renderer has nothing to show.
export function SecretsSection() {
  const [names, setNames] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  // The new-secret row, and the per-secret replacement values, keyed by name.
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});

  const adopt = (result: {
    ok: boolean;
    error: string;
    names: string[];
    path: string;
  }): boolean => {
    setNames(result.names);
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

  const onReplace = async (name: string): Promise<void> => {
    if (await save(name, edits[name] ?? "")) {
      setEdits((current) => ({ ...current, [name]: "" }));
    }
  };

  return (
    <SettingsGroup title="Secrets">
      {names.length > 0 && (
        <ul className="secret-list">
          {names.map((name) => (
            <li key={name}>
              <code className="secret-name">{name}</code>
              <TextInput
                type="password"
                aria-label={`New value for ${name}`}
                placeholder="Set — type to replace"
                value={edits[name] ?? ""}
                onValueChange={(value) => setEdits((current) => ({ ...current, [name]: value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onReplace(name);
                }}
              />
              <Button
                size="small"
                pill
                disabled={!(edits[name] ?? "")}
                onClick={() => void onReplace(name)}
              >
                Replace
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
          ))}
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
          type="password"
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
        Refer to a secret by name — <code>{"{{DB_API_KEY}}"}</code> in a command,{" "}
        <code>{"{{DB_API_KEY:secret}}"}</code> in a script — and the value is passed to the run
        through its environment instead of being written into the command or the script's config. In
        a command it expands like <code>$DB_API_KEY</code> does, so keep it out of single quotes.
      </p>
      <p className="hint">
        Values are kept in {path || "secrets.json"}, readable only by you, and are hidden from run
        output. Nothing else the app writes contains them — which is what makes a scripts folder
        safe to put in git.
      </p>
    </SettingsGroup>
  );
}

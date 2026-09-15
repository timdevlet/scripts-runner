import {
  formatManyValue,
  isParamChecked,
  parseManyValue,
  type ScriptParam,
} from "../../../../../domain/script-params";
import { CheckboxMenu } from "../../components/CheckboxMenu";
import { DirectoryInput } from "../../components/DirectoryInput";
import { Field } from "../../components/Field";
import { SelectMenu, type SelectMenuOption } from "../../components/SelectMenu";
import { SwitchField } from "../../components/SwitchField";
import { TextInput } from "../../components/TextInput";

// One field per extracted {{param}}, with the control the hole's kind asks for — a toggle for
// :bool, a dropdown for :one, a checklist for :many, a path + Browse… for :dir, and the plain
// text input for everything else. Fields appear and disappear as the source is edited; stored
// values win, otherwise the template default shows (without being written until the user acts).
//
// Every control reads and writes the same string the text input always did, so switching a hole's
// kind never strands a stored value or changes what the script receives.
export function ScriptParamFields({
  params,
  values,
  disabled,
  onChange,
}: {
  params: ScriptParam[];
  values: Record<string, string>;
  disabled: boolean;
  onChange: (name: string, value: string) => void;
}) {
  if (params.length === 0) return null;
  return (
    <div className="script-params">
      {params.map((param) => {
        const id = `scriptParam-${param.name}`;
        const value = Object.hasOwn(values, param.name) ? values[param.name] : param.defaultValue;
        const set = (next: string) => onChange(param.name, next);

        // The toggle is its own labelled row (label left, switch right), so it skips the Field
        // wrapper the other kinds share.
        if (param.kind === "bool") {
          return (
            <SwitchField
              key={param.name}
              id={id}
              label={param.name}
              checked={isParamChecked(value)}
              disabled={disabled}
              onChange={(checked) => set(checked ? "true" : "false")}
            />
          );
        }

        return (
          <Field key={param.name} label={param.name} htmlFor={id}>
            {param.kind === "dir" ? (
              <DirectoryInput
                id={id}
                value={value}
                placeholder={param.defaultValue || `{{${param.name}}}`}
                disabled={disabled}
                onValueChange={set}
              />
            ) : param.kind === "one" ? (
              <SelectMenu
                value={value}
                options={oneOptions(param, value)}
                ariaLabel={param.name}
                disabled={disabled}
                onValueChange={set}
              />
            ) : param.kind === "many" ? (
              <CheckboxMenu
                values={parseManyValue(value)}
                options={param.options}
                ariaLabel={param.name}
                disabled={disabled}
                onValuesChange={(next) => set(formatManyValue(next))}
              />
            ) : (
              <TextInput
                id={id}
                placeholder={param.defaultValue || `{{${param.name}}}`}
                value={value}
                onValueChange={set}
                disabled={disabled}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}

// The dropdown's options, plus whatever the stored value needs to stay visible:
//  - nothing chosen yet → a "Select…" placeholder, so the trigger isn't blank. It drops out once
//    a real choice is made, which is what keeps it unpickable.
//  - a value the source no longer offers (an option was renamed) → shown as-is rather than
//    silently reading as the first option while the script still receives the old string.
function oneOptions(param: ScriptParam, value: string): SelectMenuOption[] {
  const options: SelectMenuOption[] = param.options.map((option) => ({
    value: option,
    label: option,
  }));
  if (value === "") return [{ value: "", label: "Select…" }, ...options];
  if (!param.options.includes(value)) return [...options, { value, label: value }];
  return options;
}

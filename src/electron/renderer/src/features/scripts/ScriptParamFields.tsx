import type { ScriptParam } from "../../../../../domain/script-params";
import { Field } from "../../components/Field";
import { TextInput } from "../../components/TextInput";

// One text field per extracted {{param}}. Appear and disappear as the source is edited; stored
// values win, otherwise the template default shows (without being written until the user types).
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
        return (
          <Field key={param.name} label={param.name} htmlFor={id}>
            <TextInput
              id={id}
              placeholder={param.defaultValue || `{{${param.name}}}`}
              value={value}
              onValueChange={(next) => onChange(param.name, next)}
              disabled={disabled}
            />
          </Field>
        );
      })}
    </div>
  );
}

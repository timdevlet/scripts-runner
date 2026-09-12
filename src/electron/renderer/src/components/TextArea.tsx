import type { Ref, TextareaHTMLAttributes } from "react";

type TextAreaProps = {
  value: string;
  onValueChange?: (value: string) => void;
  ref?: Ref<HTMLTextAreaElement>;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">;

// Multi-line counterpart to TextInput, with the same defaults (no autocomplete/spellcheck) — for
// values where a line break is meaningful, like a shell command. Styled with the inputs by the
// shared `.field input, .field textarea` rule in Field.scss.
export function TextArea({ value, onValueChange, ...rest }: TextAreaProps) {
  return (
    <textarea
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(e) => onValueChange?.(e.currentTarget.value)}
      {...rest}
    />
  );
}

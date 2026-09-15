import { useState } from "react";
import { api } from "../stores/api";
import { Button } from "./Button";
import { FolderIcon } from "./icons";
import { TextInput } from "./TextInput";
import "./DirectoryInput.scss";

// A folder path: still typeable (paths get pasted, and a script's folder may not exist yet), with
// a Browse… button opening the native chooser. The text field stays the source of truth — the
// dialog just fills it in — so the control behaves like every other param field when the user
// would rather type.
export function DirectoryInput({
  id,
  value,
  placeholder,
  disabled = false,
  onValueChange,
}: {
  id?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  const [picking, setPicking] = useState(false);

  const browse = async (): Promise<void> => {
    setPicking(true);
    try {
      // The current value seeds the dialog's starting folder, so re-picking lands where the last
      // choice did instead of at the home directory.
      const result = await api.pickDirectory(value);
      if (result.ok) onValueChange(result.path);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="dir-input">
      <TextInput
        id={id}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onValueChange={onValueChange}
      />
      <Button size="small" disabled={disabled || picking} onClick={() => void browse()}>
        <FolderIcon />
        Browse…
      </Button>
    </div>
  );
}

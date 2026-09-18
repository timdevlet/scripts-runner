import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { extractSecretRefs } from "../../../../domain/secrets";
import { IconButton } from "./IconButton";
import { KeyIcon } from "./icons";
import { anchoredPanelStyle, useAnchoredPanel } from "./useAnchoredPanel";
import "./SecretPeek.scss";

// A key button beside a field whose value refers to the vault — {{DB_API_KEY}} typed into a script
// param, or into a command line. Pressing it opens a panel listing each referenced name with the
// value it currently stands for, so what the run will receive can be checked without leaving the
// field for Settings. Renders nothing while the value holds no reference, so the row looks like any
// other until one is typed.
//
// `secrets` is the vault as Settings shows it; a name it lacks is called out, since the run would
// be refused for want of it.
export function SecretPeek({
  text,
  secrets,
  label = "Show the secrets this value refers to",
}: {
  text: string;
  secrets: Record<string, string>;
  label?: string;
}) {
  const names = extractSecretRefs(text);
  if (names.length === 0) return null;
  return <Peek names={names} secrets={secrets} label={label} />;
}

// Split from the wrapper so the hooks run only when there is something to peek at.
function Peek({
  names,
  secrets,
  label,
}: {
  names: string[];
  secrets: Record<string, string>;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const position = useAnchoredPanel({ open, onClose: close, rootRef, panelRef, align: "end" });

  return (
    <span ref={rootRef} className="secret-peek">
      <IconButton
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-pressed={open}
        onClick={() => setOpen((v) => !v)}
      >
        <KeyIcon />
      </IconButton>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className={`secret-peek-panel${position ? ` placement-${position.placement}` : ""}`}
            role="dialog"
            aria-label="Secret values"
            style={anchoredPanelStyle(position)}
          >
            <dl>
              {names.map((name) => {
                const value = secrets[name];
                const set = value !== undefined && value !== "";
                return (
                  <div key={name} className="secret-peek-row">
                    <dt>
                      <code>{name}</code>
                    </dt>
                    <dd className={set ? "" : "secret-peek-missing"}>
                      {set ? value : "Not set — add it in Settings → Secrets."}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>,
          document.body,
        )}
    </span>
  );
}

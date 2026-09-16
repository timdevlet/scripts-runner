import { ScrollArea } from "./ScrollArea";
import "./RailNav.scss";

export interface RailItem {
  id: string;
  // The full name. Only its first letter is drawn — the rest of it is the tooltip and the
  // accessible name, which is what makes a one-letter circle usable.
  label: string;
  running?: boolean;
}

// The first letter, as a capital. Spread rather than charAt so an emoji or an accented letter
// comes back whole instead of as half a surrogate pair.
function initial(label: string): string {
  const first = [...label.trim()][0];
  return first ? first.toUpperCase() : "?";
}

// What a collapsed pane (see Column's `rail`) shows in place of its list: one round button per
// row, carrying the first letter of its name. Selecting works exactly as it does in the open
// list — same radiogroup, same selection — so zipping the pane shut costs you the names, not the
// ability to move between them.
//
// It scrolls on its own and takes the rail's spare height, which keeps whatever the caller puts
// after it (the runs toggle) pinned to the bottom however many rows there are.
export function RailNav({
  items,
  selectedId,
  onSelect,
  ariaLabel,
}: {
  items: RailItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  ariaLabel: string;
}) {
  return (
    <ScrollArea className="rail-scroll">
      <div className="rail-nav" role="radiogroup" aria-label={ariaLabel}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={item.id === selectedId}
            className={`rail-dot${item.running ? " running" : ""}`}
            title={item.running ? `${item.label} — running` : item.label}
            aria-label={item.label}
            onClick={() => onSelect(item.id)}
          >
            <span aria-hidden="true">{initial(item.label)}</span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

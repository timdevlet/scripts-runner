import {
  Children,
  type CSSProperties,
  Fragment,
  isValidElement,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ScrollArea } from "./ScrollArea";
import "./Columns.scss";

// How a pane's width is adjusted by dragging the divider next to it. `cssVar` is the custom property
// the caller's grid-template-columns reads its width from — the stylesheet keeps owning the default
// (and what a narrow window does instead), a drag only overrides it.
export interface ColumnResize {
  cssVar: string;
  min?: number;
  max?: number;
}

// Widths the user has dragged, kept for as long as the app runs and keyed by custom property, since
// that's what identifies a pane's width across layouts. The views that use Columns remount on every
// visit to their tab, and having to re-fit the panes each time would be a nuisance (the same
// reasoning as the Commands tab's module-scope logs toggle).
const draggedWidths = new Map<string, number>();

const MIN_WIDTH = 150;
const MAX_WIDTH = 560;
// However generous a pane's own max, it can't take the window: whatever the flexible pane is, it
// keeps the rest.
const MAX_SHARE = 0.4;
const KEY_STEP = 16;

// What Columns reads off its children. Column accepts these; nothing else is introspected.
// `collapsed` is read here only to drop the divider beside a pane that has zipped itself down to
// a rail — there is nothing left to resize.
type PaneProps = { title?: ReactNode; resize?: ColumnResize; collapsed?: boolean };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// The divider in the gap between two panes: drag (or arrow-key) it to resize whichever of the two
// declared `resize`, double-click to hand the width back to the stylesheet.
//
// It sits in the gap rather than inside a pane, so it never covers a pane's own scrollbar — and it's
// absolutely positioned into its grid column, so it takes no track of its own and the caller's
// grid-template-columns stays a plain list of panes.
function Resizer({
  spec,
  // 1 when the pane being sized is to the divider's left (drag right to widen it), -1 when it's to
  // the right.
  grow,
  // 1-based grid column of the pane the divider sits in front of.
  column,
  label,
}: {
  spec: ColumnResize;
  grow: 1 | -1;
  column: number;
  label: string;
}) {
  // Which pane this divider sizes is a matter of where it sits, so the DOM can say — no refs.
  const pane = (divider: HTMLElement): HTMLElement | null => {
    const sibling = grow === 1 ? divider.previousElementSibling : divider.nextElementSibling;
    return sibling instanceof HTMLElement ? sibling : null;
  };

  // Written straight to the grid element: a drag is a CSS variable change and a relayout, with no
  // React render in the loop. The next render re-applies the same value from draggedWidths.
  const resize = (divider: HTMLElement, width: number) => {
    const grid = divider.closest(".columns");
    if (!(grid instanceof HTMLElement)) return;
    const max = Math.min(spec.max ?? MAX_WIDTH, grid.clientWidth * MAX_SHARE);
    const next = Math.round(clamp(width, spec.min ?? MIN_WIDTH, max));
    grid.style.setProperty(spec.cssVar, `${next}px`);
    draggedWidths.set(spec.cssVar, next);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const divider = e.currentTarget;
    const start = pane(divider)?.getBoundingClientRect().width;
    if (start == null) return;
    // Keeps the drag (and the col-resize cursor) with the divider once the pointer leaves it, and
    // stops the pass over the panes from selecting their text.
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add("dragging");
    const onMove = (ev: PointerEvent) => resize(divider, start + (ev.clientX - e.clientX) * grow);
    const onDone = () => {
      divider.classList.remove("dragging");
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onDone);
      divider.removeEventListener("pointercancel", onDone);
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onDone);
    divider.addEventListener("pointercancel", onDone);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? -KEY_STEP : e.key === "ArrowRight" ? KEY_STEP : 0;
    if (step === 0) return;
    const width = pane(e.currentTarget)?.getBoundingClientRect().width;
    if (width == null) return;
    e.preventDefault();
    resize(e.currentTarget, width + step * grow);
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const grid = e.currentTarget.closest(".columns");
    if (grid instanceof HTMLElement) grid.style.removeProperty(spec.cssVar);
    draggedWidths.delete(spec.cssVar);
  };

  return (
    <div
      className="column-resizer"
      // The gap in front of that pane is where the divider lives; the CSS pulls it back across it.
      style={{ gridColumn: column }}
      // So a narrow layout that moves a pane onto its own row can drop its divider.
      data-divider={column}
      // A window-splitter separator should carry aria-valuenow, but the split fraction isn't
      // tracked here; keyboard resizing still works via the arrow-key handler.
      // biome-ignore lint/a11y/useAriaPropsForRole: see above
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
}

// A row of side-by-side panes that fills the height it's given, each pane scrolling on its own.
// That independence is the point: a hundred-row list or a chatty run log scrolls inside its own
// pane instead of pushing everything else off the window.
//
// Column widths (and what a narrow window does with them) belong to the caller — pass a className
// and set grid-template-columns on it. Panes that read their width from a custom property can hand
// it to `resize` and be draggable.
export function Columns({ className, children }: { className?: string; children: ReactNode }) {
  // The children are inspected, not just rendered: a divider goes in the gap between two panes, and
  // which of the pair it sizes (and which way) is decided by whichever one declared `resize`.
  const panes = Children.toArray(children).filter(isValidElement) as ReactElement<PaneProps>[];

  // Re-apply what the user has already dragged. Inline rather than in an effect so the panes are
  // the right width at first paint, and it's the same value the drag wrote, so React's style diff
  // has nothing to undo.
  const widths: Record<string, string> = {};
  for (const p of panes) {
    const saved = p.props.resize && draggedWidths.get(p.props.resize.cssVar);
    if (p.props.resize && saved != null) widths[p.props.resize.cssVar] = `${saved}px`;
  }

  return (
    <div className={className ? `columns ${className}` : "columns"} style={widths as CSSProperties}>
      {panes.map((p, i) => {
        // A divider only exists between two panes, and only if one of them is resizable.
        const before = i > 0 ? panes[i - 1] : null;
        const spec = before?.props.resize ?? (before ? p.props.resize : undefined);
        const sized = before?.props.resize ? before : p;
        return (
          <Fragment key={p.key ?? i}>
            {spec && !sized.props.collapsed && (
              <Resizer
                spec={spec}
                grow={before?.props.resize ? 1 : -1}
                column={i + 1}
                label={
                  typeof sized.props.title === "string"
                    ? `Resize the ${sized.props.title} column`
                    : "Resize column"
                }
              />
            )}
            {p}
          </Fragment>
        );
      })}
    </div>
  );
}

// One pane: a fixed title bar, the body, and a fixed footer — only the body scrolls, so a footer's
// buttons stay put and reachable however long the body gets.
//
// Pass scroll={false} when the children do their own scrolling (RunHistory's strip-over-output
// needs the full height to divide up); the body then just hands them the space. `resize` isn't used
// here — Columns reads it off this element to build the divider beside it.
//
// `collapsed` zips the whole pane down to a narrow rail: title, body and footer all go, and `rail`
// is what's left — a column of icon buttons, one of which brings the pane back. The caller still
// has to narrow the pane's grid track (the widths are its stylesheet's, not ours); what's here is
// only what the pane itself renders. `titleAction` is the control that collapses it, in the title
// bar where its counterpart on the rail is.
export function Column({
  title,
  titleAction,
  footer,
  scroll = true,
  collapsed = false,
  rail,
  className,
  children,
}: PaneProps & {
  titleAction?: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
  rail?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const classes = ["column", collapsed ? "column-rail" : "", className].filter(Boolean).join(" ");

  if (collapsed) {
    return (
      <section className={classes} aria-label={typeof title === "string" ? title : undefined}>
        {rail}
      </section>
    );
  }

  return (
    <section className={classes}>
      {title != null && (
        <h4 className="column-title">
          <span className="column-title-text">{title}</span>
          {titleAction}
        </h4>
      )}
      {scroll ? (
        <ScrollArea className="column-body">{children}</ScrollArea>
      ) : (
        <div className="column-body column-body-plain">{children}</div>
      )}
      {footer != null && <div className="column-foot">{footer}</div>}
    </section>
  );
}

// Where the app is, as a URL hash: the tab, and for the Scripts and Commands tabs which row is
// selected and whether its Runs pane is open. Pure — parsing and formatting only; stores/route.ts
// reads and writes the window's hash.
//
//   #/scripts                    the Scripts tab, nothing chosen yet
//   #/scripts/<id>               that script selected
//   #/scripts/<id>/runs          …with its run log open
//   #/scripts/-/runs             run log open, nothing selected (an empty list)
//   #/commands/<id>[/runs]       the same for a command
//   #/settings   #/logs          the two tabs with no state of their own
//
// Putting the selection in the route rather than in the view's component state is what lets it
// survive a trip to another tab: each view remounts on every visit, and rebuilt state would be
// the first row again.

export type Tab = "scripts" | "commands" | "settings" | "logs";

export interface Route {
  tab: Tab;
  // The selected row on the Scripts / Commands tab; null on the other two, and while nothing is
  // selected.
  id: string | null;
  // Whether the Runs pane is open beside the selected row. Always false off those two tabs.
  runs: boolean;
}

export const TABS: readonly Tab[] = ["scripts", "commands", "settings", "logs"];

// The tabs whose route carries a selection.
export function tabHasSelection(tab: Tab): boolean {
  return tab === "scripts" || tab === "commands";
}

export function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value);
}

export const DEFAULT_ROUTE: Route = { tab: "scripts", id: null, runs: false };

// A bare tab route: the tab with nothing selected and the Runs pane closed.
export function tabRoute(tab: Tab): Route {
  return { tab, id: null, runs: false };
}

// The route a hash stands for. Anything unreadable — an unknown tab, an empty hash — is the
// default route rather than an error: a hash is user-visible state, not trusted input.
export function parseRoute(hash: string): Route {
  const segments = hash
    .replace(/^#/, "")
    .split("/")
    .filter((segment) => segment !== "");
  const tab = segments[0] ?? "";
  if (!isTab(tab)) return DEFAULT_ROUTE;
  if (!tabHasSelection(tab)) return tabRoute(tab);
  const rawId = segments[1] ?? "";
  let id: string | null = null;
  if (rawId !== "" && rawId !== "-") {
    try {
      id = decodeURIComponent(rawId);
    } catch {
      id = null;
    }
  }
  const runs = segments[2] === "runs";
  return { tab, id, runs };
}

export function formatRoute(route: Route): string {
  if (!tabHasSelection(route.tab)) return `#/${route.tab}`;
  const parts: string[] = [route.tab];
  if (route.id !== null) parts.push(encodeURIComponent(route.id));
  else if (route.runs) parts.push("-");
  if (route.runs) parts.push("runs");
  return `#/${parts.join("/")}`;
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.tab === b.tab && a.id === b.id && a.runs === b.runs;
}

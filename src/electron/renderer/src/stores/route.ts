import { useSyncExternalStore } from "react";
import {
  DEFAULT_ROUTE,
  formatRoute,
  isTab,
  parseRoute,
  type Route,
  sameRoute,
  type Tab,
  tabHasSelection,
  tabRoute,
} from "../lib/route";

// The current route, read from and written to the window's hash (see lib/route.ts for the shape).
// One store for the whole renderer: App reads the tab off it, and the Scripts and Commands views
// read their selection and Runs-pane state off it and navigate to change them.
//
// Two things are remembered beyond the hash itself:
//  - the last route of each tab that has a selection, so clicking "Scripts" from the Logs tab
//    goes back to the script that was open there, not to the top of the list;
//  - the whole of that, in localStorage, so a relaunch opens where the last session left off.
//    Browser storage can be unavailable (cleared, blocked), in which case the app simply starts
//    on the default tab.

const STORAGE_KEY = "route";

type Saved = { tab: Tab; byTab: Partial<Record<Tab, string>> };

function readSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Saved>;
    if (typeof value.tab !== "string" || !isTab(value.tab)) return null;
    const byTab: Partial<Record<Tab, string>> = {};
    for (const [tab, hash] of Object.entries(value.byTab ?? {})) {
      if (isTab(tab) && typeof hash === "string") byTab[tab] = hash;
    }
    return { tab: value.tab, byTab };
  } catch {
    return null;
  }
}

function writeSaved(): void {
  try {
    const saved: Saved = { tab: current.tab, byTab };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage is a convenience; the hash still works for the life of the window.
  }
}

const saved = readSaved();
// Per-tab memory of the last route, as a hash string — the same thing the storage holds.
const byTab: Partial<Record<Tab, string>> = saved?.byTab ?? {};

// The window's hash wins when there is one (a reload keeps it); otherwise the saved route, falling
// back to the default. The hash is then made to agree, so the two never disagree from the start.
let current: Route = (() => {
  if (window.location.hash) return parseRoute(window.location.hash);
  if (saved) return parseRoute(byTab[saved.tab] ?? formatRoute(tabRoute(saved.tab)));
  return DEFAULT_ROUTE;
})();
window.history.replaceState(null, "", formatRoute(current));

const listeners = new Set<() => void>();

function remember(route: Route): void {
  if (tabHasSelection(route.tab)) byTab[route.tab] = formatRoute(route);
}

function adopt(route: Route): void {
  if (sameRoute(current, route)) return;
  current = route;
  remember(route);
  writeSaved();
  for (const listener of listeners) listener();
}

remember(current);
writeSaved();

// Back/forward, or a hash typed by hand: the hash is the source of truth, so follow it.
window.addEventListener("hashchange", () => adopt(parseRoute(window.location.hash)));

// Go somewhere. `replace` swaps the current history entry rather than adding one — for the
// corrections a view makes on its own (selecting the first row when the chosen one is gone),
// which shouldn't leave a step in the history.
export function navigate(route: Route, { replace = false } = {}): void {
  const hash = formatRoute(route);
  if (hash === formatRoute(current)) return;
  if (replace) window.history.replaceState(null, "", hash);
  else window.location.hash = hash;
  // Told directly rather than waiting: replaceState never fires hashchange, and setting the hash
  // fires it only later. The event that does follow finds the same route and changes nothing.
  adopt(parseRoute(hash));
}

// Where a tab should open when picked from the tab bar: the last route it was on, if it keeps one.
export function lastRoute(tab: Tab): Route {
  const hash = byTab[tab];
  return hash ? parseRoute(hash) : tabRoute(tab);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

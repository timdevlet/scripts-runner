// Mirrors the theme preference onto <html data-theme="...">. Light/dark/system need no renderer
// involvement — the main process drives them through nativeTheme and the prefers-color-scheme
// media query in global.scss. The attribute exists for palettes beyond that binary: sand maps to
// light chrome, and :root[data-theme="sand"] in global.scss overrides the light palette.
import { api } from "../stores/api";

export function initTheme(): void {
  const apply = (theme: string): void => {
    document.documentElement.dataset.theme = theme;
  };
  // Live changes are pushed by the main process's applyTheme (Settings save).
  api.onThemeChanged(apply);
  // The initial value is fetched — the startup applyTheme runs before the window exists, so
  // there is no push to catch. Skipped if a push already landed first.
  void api.getSettings().then((settings) => {
    if (!document.documentElement.dataset.theme) apply(settings.theme);
  });
}

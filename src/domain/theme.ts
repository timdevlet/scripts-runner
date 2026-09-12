// Theme preference — pure, so the renderer can import it without pulling in node: modules.

export const THEME_PREFERENCES = ["light", "dark", "sand", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export function normalizeTheme(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : "dark";
}

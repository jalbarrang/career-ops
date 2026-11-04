// Shared theme constants and pure helpers. Keeping this module free of React
// and browser globals lets the bootstrap script, provider, and tests agree on
// the same storage key and browser-chrome colors.

export const THEME_STORAGE_KEY = "career-ops:theme";

/** The two themes the app supports. */
export type Theme = "light" | "dark";

export const THEME_COLORS = Object.freeze({
  light: "#f7f6f3",
  dark: "#0a0a0a",
});

/** @param {unknown} value */
export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/** @param {unknown} value @param {"light"|"dark"} fallback */
export function storedTheme(value: unknown, fallback: Theme = "dark"): Theme {
  return isTheme(value) ? value : fallback;
}

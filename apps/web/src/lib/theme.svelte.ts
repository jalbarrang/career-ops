// Runtime theme state, shared app-wide. Replaces the Next app's ThemeProvider.
//
// app.html runs a pre-paint bootstrap that sets the `dark` class and the
// theme-color meta, so the first paint is already correct. This module adopts
// that choice after hydration and keeps it in sync with the OS preference, the
// storage event across tabs, and the toggle.
import { THEME_COLORS, THEME_STORAGE_KEY, isTheme, storedTheme } from "@/lib/theme.ts";

export type Theme = "light" | "dark";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function savedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
  // Consumers outside this module (e.g. HeroGlow) listen for the DOM-level
  // signal rather than subscribing to the store.
  window.dispatchEvent(new Event("themechange"));
}

class ThemeStore {
  theme = $state<Theme>("dark");
  #started = false;

  /** Adopt the class the bootstrap script already applied. Call once, from the layout. */
  start(): void {
    if (this.#started || typeof window === "undefined") return;
    this.#started = true;
    this.theme = currentTheme();

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => {
      // A stored choice wins over later OS changes. With no stored choice, keep
      // the bootstrap behavior live when the system preference changes.
      if (savedTheme()) return;
      const next: Theme = media.matches ? "dark" : "light";
      this.theme = next;
      applyTheme(next);
    });

    window.addEventListener("storage", (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      if (!event.newValue && !event.oldValue) return;
      const next = storedTheme(event.newValue, media.matches ? "dark" : "light") as Theme;
      this.theme = next;
      applyTheme(next);
    });
  }

  set(next: Theme): void {
    this.theme = next;
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* Private browsing/storage-disabled environments remain usable. */
    }
  }

  toggle(): void {
    this.set(this.theme === "dark" ? "light" : "dark");
  }
}

export const themeStore = new ThemeStore();

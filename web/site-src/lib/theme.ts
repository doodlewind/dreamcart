/**
 * Theme runtime. Sets <html data-theme="id">, persists to localStorage. Default
 * "cartridge". Used by ThemeProvider (the React side) and the inline pre-paint
 * snippet injected into every page <head> to avoid a flash of the wrong theme.
 */
import { DEFAULT_THEME, THEME_IDS, type ThemeId } from "../styles/tokens";

export const STORAGE_KEY = "dreamcart-theme";

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
}

export function readStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(v)) return v;
  } catch {
    /* SSR / blocked storage */
  }
  return DEFAULT_THEME;
}

export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute("data-theme", id);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

/**
 * Inline script (stringified) for the page <head>: stamps data-theme BEFORE the
 * body paints. Inlined by the build into every route's HTML.
 */
export const PREPAINT_SNIPPET = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)});var ok=${JSON.stringify(
  THEME_IDS,
)}.indexOf(t)>=0;document.documentElement.setAttribute("data-theme",ok?t:${JSON.stringify(
  DEFAULT_THEME,
)});}catch(e){document.documentElement.setAttribute("data-theme",${JSON.stringify(
  DEFAULT_THEME,
)});}})();`;

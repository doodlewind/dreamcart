/**
 * ThemeProvider — owns the current theme, applies it to <html data-theme>, and
 * exposes it via context. Wrap each page's root in this. The pre-paint snippet in
 * <head> already set data-theme before hydration, so there's no flash; this just
 * keeps React state in sync and persists changes.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_THEME, type ThemeId } from "../styles/tokens";
import { applyTheme, readStoredTheme } from "../lib/theme";

interface ThemeCtx {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}

const Ctx = createContext<ThemeCtx>({ theme: DEFAULT_THEME, setTheme: () => {} });

export function useTheme(): ThemeCtx {
  return useContext(Ctx);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);

  // Adopt whatever the pre-paint snippet stamped (avoids a hydration mismatch).
  useEffect(() => {
    setThemeState(readStoredTheme());
  }, []);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(id);
    applyTheme(id);
  }, []);

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>;
}

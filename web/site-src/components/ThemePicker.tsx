/**
 * ThemePicker — the nav theme selector. A button that opens a menu of the four
 * themes; selecting one calls setTheme (persists + restyles the whole site).
 * Headless markup via data-part; styled in base.ts + per-theme blocks.
 */
import { useEffect, useRef, useState } from "react";
import { THEME_IDS, THEME_LABELS, type ThemeId } from "../styles/tokens";
import { useTheme } from "./ThemeProvider";

/** A tiny inline preview of a theme's accent over its surface. */
function OptionSwatch({ id }: { id: ThemeId }) {
  // Approximate per-theme preview colors (decorative only; the real source of
  // truth is themes.ts). Kept minimal so the picker has no theme dependency loop.
  const previews: Record<ThemeId, [string, string]> = {
    cartridge: ["#121a16", "#39ff88"],
    "psp-silver": ["#e9edf2", "#1f6fff"],
    dmg: ["#9bbc0f", "#0f380f"],
    light: ["#ffffff", "#0a7d4b"],
  };
  const [bg, ac] = previews[id];
  return (
    <span
      data-part="theme-option-swatch"
      style={{ background: bg }}
      aria-hidden="true"
    >
      <span
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          borderRadius: 3,
          background: `linear-gradient(135deg, transparent 55%, ${ac} 55%)`,
        }}
      />
    </span>
  );
}

export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div data-part="theme-picker" ref={ref}>
      <button
        type="button"
        data-part="theme-picker-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Switch theme"
      >
        <span data-part="theme-swatch" />
        <span>{THEME_LABELS[theme]}</span>
        <span aria-hidden="true" style={{ opacity: 0.6 }}>
          ▾
        </span>
      </button>
      {open && (
        <div data-part="theme-menu" role="menu">
          {THEME_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={theme === id}
              data-part="theme-option"
              onClick={() => {
                setTheme(id);
                setOpen(false);
              }}
            >
              <OptionSwatch id={id} />
              <span>{THEME_LABELS[id]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

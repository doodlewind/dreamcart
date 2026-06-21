/**
 * The DreamCart TOKEN CONTRACT.
 *
 * ONE set of CSS custom properties, named by PURPOSE (never by hue). Every theme
 * binds the SAME names; switching theme swaps the bindings only. Components and
 * the base stylesheet reference var(--token) exclusively — raw colors live ONLY
 * inside a theme block in themes.ts.
 *
 * This file is the single source of truth for the token names. It exports:
 *   - TOKEN_NAMES: the canonical list (used by validation / docs).
 *   - ThemeId / THEME_IDS: the four shipped themes.
 *
 * Mirrors the sheru contract idea (packages/ui/src/tokens/schema.ts): purpose
 * tokens + [data-theme=x] [data-part=y] CSS.
 */

export const TOKEN_NAMES = [
  // ── Surfaces & text ──────────────────────────────────────────────────────
  "--bg", // page background
  "--bg-elev", // a raised band/section over --bg
  "--surface", // cards, panels, nav, footer
  "--surface-2", // nested surface / inputs / wells
  "--fg", // primary text
  "--fg-muted", // secondary text
  "--fg-faint", // tertiary / disabled text
  "--border", // hairline borders / dividers
  "--border-strong", // emphasized borders
  // ── Accent / brand ───────────────────────────────────────────────────────
  "--accent", // primary accent (links, focus, brand)
  "--accent-fg", // text/icon ON an accent fill
  "--accent-soft", // tinted accent wash (badges, hover)
  "--accent-2", // secondary accent
  // ── Controls (buttons, theme picker, pickers) ────────────────────────────
  "--btn-face", // default button fill
  "--btn-fg", // default button text
  "--btn-face-hover", // button hover fill
  "--btn-border", // button border
  "--btn-radius", // button corner radius
  // ── Focus ring ───────────────────────────────────────────────────────────
  "--ring", // focus-visible outline color
  // ── The handheld CONSOLE shell ───────────────────────────────────────────
  "--console-shell", // bezel / body of the handheld
  "--console-shell-2", // bezel gradient stop / accent plastic
  "--console-edge", // bezel rim / highlight
  "--console-screen-bg", // the inert screen area behind the canvas
  "--console-screen-border", // screen recess border
  "--console-screen-glow", // screen bezel glow / shadow
  "--console-btn", // d-pad / face button face
  "--console-btn-edge", // d-pad / face button rim
  "--console-btn-active", // pressed button face
  "--console-btn-label", // glyph/label on console buttons
  "--console-text", // branding / small text printed on the shell
  // ── Code / mono surfaces ─────────────────────────────────────────────────
  "--code-bg", // code blocks / source modal / log
  "--code-fg", // code text
  "--code-border",
  // ── Syntax highlighting (highlight.js classes; build-time) ───────────────
  "--code-comment", // comments
  "--code-keyword", // keywords / control flow
  "--code-string", // strings / regexp
  "--code-number", // numbers / booleans / literals
  "--code-function", // function & method names
  "--code-class", // types / classes / attrs / tags / properties
  "--code-variable", // variables / params / symbols
  // ── Typography ───────────────────────────────────────────────────────────
  "--font-sans",
  "--font-mono",
  "--font-display", // headings / hero
  // ── Shadows ──────────────────────────────────────────────────────────────
  "--shadow-1",
  "--shadow-2",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];

export const THEME_IDS = ["cartridge", "psp-silver", "dmg", "light"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = "cartridge";

export const THEME_LABELS: Record<ThemeId, string> = {
  cartridge: "Cartridge",
  "psp-silver": "PSP Silver",
  dmg: "Game Boy DMG",
  light: "Light",
};

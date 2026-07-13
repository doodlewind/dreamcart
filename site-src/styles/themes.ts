/**
 * The DreamCart theme — PURE DATA. The site ships a SINGLE theme, dream-night,
 * derived from the brand logo's palette (deep indigo night, gold accents). It is a
 * token block (binding the purpose tokens from tokens.ts) plus an optional scoped
 * CSS string, selected by [data-theme="dream-night"] on <html>.
 *
 * Raw color values live ONLY here. Everything else references var(--token).
 */
import type { ThemeId, TokenName } from "./tokens";

export interface Theme {
  id: ThemeId;
  name: string;
  /** Purpose-token bindings. Must bind every token in TOKEN_NAMES. */
  tokens: Record<TokenName, string>;
  /** Optional theme-scoped CSS. Every rule MUST be under [data-theme="<id>"]. */
  stylesheet?: string;
}

const SANS =
  '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO =
  '"JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

// ── dream-night (the brand theme) ────────────────────────────────────────────
// Deep indigo night sky, a cratered moon over a teal synthwave grid, gold accents.
export const dreamNight: Theme = {
  id: "dream-night",
  name: "Dream Night",
  tokens: {
    "--bg": "#13121d",
    "--bg-elev": "#1a1828",
    "--surface": "#201d31",
    "--surface-2": "#171524",
    "--fg": "#f1eef8",
    "--fg-muted": "#a39db9",
    "--fg-faint": "#6c6685",
    "--border": "#2a2740",
    "--border-strong": "#3d3a5a",
    "--accent": "#e9b24c",
    "--accent-fg": "#1c1406",
    "--accent-soft": "rgba(233,178,76,0.14)",
    "--accent-2": "#46c7c4",
    "--btn-face": "#232035",
    "--btn-fg": "#f1eef8",
    "--btn-face-hover": "#2c2945",
    "--btn-border": "#383552",
    "--btn-radius": "9px",
    "--ring": "#e9b24c",
    "--console-shell": "#2f2f40",
    "--console-shell-2": "#1d1d29",
    "--console-edge": "#45455c",
    "--console-screen-bg": "#242246",
    "--console-screen-border": "#100f1d",
    "--console-screen-glow": "0 0 34px rgba(70,199,196,0.30)",
    "--console-btn": "#2a2740",
    "--console-btn-edge": "#100f1d",
    "--console-btn-active": "#e9b24c",
    "--console-btn-label": "#e9b24c",
    "--console-text": "#e9b24c",
    "--code-bg": "#15131f",
    "--code-fg": "#e7e2f2",
    "--code-border": "#2a2740",
    "--code-comment": "#6f6a88",
    "--code-keyword": "#c9a6ff",
    "--code-string": "#7fd4c2",
    "--code-number": "#e9b24c",
    "--code-function": "#7cc6ff",
    "--code-class": "#e7c07b",
    "--code-variable": "#ef9ab0",
    "--font-sans": SANS,
    "--font-mono": MONO,
    "--font-display": '"Space Grotesk", ' + SANS,
    "--shadow-1": "0 1px 2px rgba(0,0,0,0.5)",
    "--shadow-2": "0 18px 50px rgba(0,0,0,0.62)",
  },
  stylesheet: /* css */ `
[data-theme="dream-night"] [data-part="console"] {
  background-image: linear-gradient(158deg, var(--console-edge) -10%, var(--console-shell) 24%, var(--console-shell-2) 100%);
}
[data-theme="dream-night"] [data-part="console-screen"] {
  box-shadow: var(--console-screen-glow), inset 0 0 0 2px var(--console-screen-border);
}
[data-theme="dream-night"] [data-part="hero"] {
  background:
    radial-gradient(880px 380px at 80% -10%, rgba(233,178,76,0.12), transparent 60%),
    radial-gradient(720px 380px at 6% 4%, rgba(70,199,196,0.10), transparent 58%);
}
`,
};

export const THEMES: Theme[] = [dreamNight];

/** Build the full theme CSS: token blocks + scoped stylesheets. */
export function themesCss(): string {
  const blocks = THEMES.map((t) => {
    const decls = Object.entries(t.tokens)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    const tokenBlock = `[data-theme="${t.id}"] {\n${decls}\n}`;
    return [tokenBlock, t.stylesheet ?? ""].join("\n");
  });
  return blocks.join("\n\n");
}

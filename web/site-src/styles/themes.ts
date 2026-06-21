/**
 * The four DreamCart themes — PURE DATA. Each theme is a token block (binding the
 * SAME purpose tokens from tokens.ts) plus an optional scoped CSS string. Themes
 * are selected by [data-theme="id"] on <html>. No per-theme component code.
 *
 * Raw color values live ONLY here. Everything else references var(--token).
 *
 *   cartridge  — default, dark, neon-green accent (the cartridge PCB look)
 *   psp-silver — glossy silver/blue (PSP-1000)
 *   dmg        — Game Boy DMG pea-green LCD
 *   light      — clean modern light
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

// ── cartridge (default) ──────────────────────────────────────────────────────
export const cartridge: Theme = {
  id: "cartridge",
  name: "Cartridge",
  tokens: {
    "--bg": "#0a0e0c",
    "--bg-elev": "#0f1512",
    "--surface": "#121a16",
    "--surface-2": "#0c120f",
    "--fg": "#e6f5ec",
    "--fg-muted": "#9bb3a6",
    "--fg-faint": "#5e7268",
    "--border": "#1f2c25",
    "--border-strong": "#33473c",
    "--accent": "#39ff88",
    "--accent-fg": "#04130a",
    "--accent-soft": "rgba(57,255,136,0.14)",
    "--accent-2": "#46d0ff",
    "--btn-face": "#16221b",
    "--btn-fg": "#e6f5ec",
    "--btn-face-hover": "#1d2e24",
    "--btn-border": "#2c3f35",
    "--btn-radius": "8px",
    "--ring": "#39ff88",
    "--console-shell": "#1a1410",
    "--console-shell-2": "#0f0c09",
    "--console-edge": "#3a2f24",
    "--console-screen-bg": "#04140c",
    "--console-screen-border": "#000000",
    "--console-screen-glow": "0 0 36px rgba(57,255,136,0.28)",
    "--console-btn": "#2a221b",
    "--console-btn-edge": "#0b0805",
    "--console-btn-active": "#39ff88",
    "--console-btn-label": "#caa46a",
    "--console-text": "#caa46a",
    "--code-bg": "#0b1410",
    "--code-fg": "#cfe9da",
    "--code-border": "#1c2a22",
    "--font-sans": SANS,
    "--font-mono": MONO,
    "--font-display": '"Space Grotesk", ' + SANS,
    "--shadow-1": "0 1px 2px rgba(0,0,0,0.5)",
    "--shadow-2": "0 18px 50px rgba(0,0,0,0.6)",
  },
  stylesheet: /* css */ `
[data-theme="cartridge"] [data-part="console"] {
  background-image: linear-gradient(160deg, var(--console-shell), var(--console-shell-2));
}
[data-theme="cartridge"] [data-part="console-screen"] {
  box-shadow: var(--console-screen-glow), inset 0 0 0 2px var(--console-screen-border);
}
[data-theme="cartridge"] [data-part="hero"] {
  background:
    radial-gradient(900px 380px at 78% -8%, rgba(57,255,136,0.10), transparent 60%),
    radial-gradient(700px 360px at 8% 0%, rgba(70,208,255,0.08), transparent 55%);
}
`,
};
// ── psp-silver ───────────────────────────────────────────────────────────────
export const pspSilver: Theme = {
  id: "psp-silver",
  name: "PSP Silver",
  tokens: {
    "--bg": "#e9edf2",
    "--bg-elev": "#dfe5ec",
    "--surface": "#f4f7fb",
    "--surface-2": "#e4e9f0",
    "--fg": "#1a2230",
    "--fg-muted": "#54637a",
    "--fg-faint": "#8a98ad",
    "--border": "#c7d0dd",
    "--border-strong": "#a9b6c8",
    "--accent": "#1f6fff",
    "--accent-fg": "#ffffff",
    "--accent-soft": "rgba(31,111,255,0.12)",
    "--accent-2": "#00b3c4",
    "--btn-face": "#ffffff",
    "--btn-fg": "#1a2230",
    "--btn-face-hover": "#eef3f9",
    "--btn-border": "#bcc7d6",
    "--btn-radius": "9px",
    "--ring": "#1f6fff",
    "--console-shell": "#f2f5f9",
    "--console-shell-2": "#c9d2de",
    "--console-edge": "#ffffff",
    "--console-screen-bg": "#0a1020",
    "--console-screen-border": "#2a3344",
    "--console-screen-glow": "0 0 30px rgba(31,111,255,0.25)",
    "--console-btn": "#e7ecf3",
    "--console-btn-edge": "#aab6c6",
    "--console-btn-active": "#1f6fff",
    "--console-btn-label": "#41506a",
    "--console-text": "#5a6a78",
    "--code-bg": "#0f1626",
    "--code-fg": "#dde6f4",
    "--code-border": "#26314a",
    "--font-sans": SANS,
    "--font-mono": MONO,
    "--font-display": '"Space Grotesk", ' + SANS,
    "--shadow-1": "0 1px 2px rgba(40,60,90,0.12)",
    "--shadow-2": "0 20px 48px rgba(40,60,90,0.2)",
  },
  stylesheet: /* css */ `
[data-theme="psp-silver"] [data-part="console"] {
  background-image: linear-gradient(155deg, #ffffff 0%, var(--console-shell) 30%, var(--console-shell-2) 100%);
}
[data-theme="psp-silver"] [data-part="console"]::before {
  content: "";
  position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: linear-gradient(180deg, rgba(255,255,255,0.7), transparent 22%);
  mix-blend-mode: screen;
}
[data-theme="psp-silver"] [data-part="console-screen"] {
  box-shadow: var(--console-screen-glow), inset 0 0 0 2px var(--console-screen-border);
}
`,
};

// ── dmg (Game Boy) ───────────────────────────────────────────────────────────
export const dmg: Theme = {
  id: "dmg",
  name: "Game Boy DMG",
  tokens: {
    "--bg": "#cdd2b6",
    "--bg-elev": "#c2c8a8",
    "--surface": "#d7dcc0",
    "--surface-2": "#bcc2a2",
    "--fg": "#202810",
    "--fg-muted": "#46522c",
    "--fg-faint": "#6d7a4f",
    "--border": "#9aa37a",
    "--border-strong": "#7c855f",
    "--accent": "#0f380f",
    "--accent-fg": "#9bbc0f",
    "--accent-soft": "rgba(15,56,15,0.12)",
    "--accent-2": "#306230",
    "--btn-face": "#c2c8a8",
    "--btn-fg": "#202810",
    "--btn-face-hover": "#cbd0b1",
    "--btn-border": "#8b9468",
    "--btn-radius": "4px",
    "--ring": "#0f380f",
    "--console-shell": "#8b9468",
    "--console-shell-2": "#6f7752",
    "--console-edge": "#a7ae85",
    "--console-screen-bg": "#9bbc0f",
    "--console-screen-border": "#0f380f",
    "--console-screen-glow": "inset 0 0 0 6px #2c3b1a",
    "--console-btn": "#5a2a52",
    "--console-btn-edge": "#3a1635",
    "--console-btn-active": "#0f380f",
    "--console-btn-label": "#e6e8d4",
    "--console-text": "#2c3b1a",
    "--code-bg": "#0f380f",
    "--code-fg": "#9bbc0f",
    "--code-border": "#306230",
    "--font-sans": SANS,
    "--font-mono": MONO,
    "--font-display": '"Space Grotesk", ' + SANS,
    "--shadow-1": "0 1px 0 rgba(15,56,15,0.25)",
    "--shadow-2": "0 10px 0 rgba(15,56,15,0.2)",
  },
  stylesheet: /* css */ `
[data-theme="dmg"] { image-rendering: pixelated; }
[data-theme="dmg"] [data-part="console"] {
  background-image: linear-gradient(160deg, var(--console-shell), var(--console-shell-2));
  border-radius: 18px 18px 42px 18px;
}
[data-theme="dmg"] [data-part="console-screen"] {
  box-shadow: var(--console-screen-glow);
}
/* DMG has no smooth shadows; flatten cards a touch. */
[data-theme="dmg"] [data-part="card"] { border-width: 2px; }
`,
};

// ── light ────────────────────────────────────────────────────────────────────
export const light: Theme = {
  id: "light",
  name: "Light",
  tokens: {
    "--bg": "#ffffff",
    "--bg-elev": "#f6f8fa",
    "--surface": "#ffffff",
    "--surface-2": "#f2f4f7",
    "--fg": "#0f1720",
    "--fg-muted": "#56616e",
    "--fg-faint": "#8b96a3",
    "--border": "#e4e8ee",
    "--border-strong": "#cdd4dd",
    "--accent": "#0a7d4b",
    "--accent-fg": "#ffffff",
    "--accent-soft": "rgba(10,125,75,0.10)",
    "--accent-2": "#2563eb",
    "--btn-face": "#ffffff",
    "--btn-fg": "#0f1720",
    "--btn-face-hover": "#f2f4f7",
    "--btn-border": "#d6dce4",
    "--btn-radius": "8px",
    "--ring": "#0a7d4b",
    "--console-shell": "#e7ebf0",
    "--console-shell-2": "#cfd6df",
    "--console-edge": "#ffffff",
    "--console-screen-bg": "#0b1220",
    "--console-screen-border": "#1f2a3a",
    "--console-screen-glow": "0 0 26px rgba(10,125,75,0.18)",
    "--console-btn": "#ffffff",
    "--console-btn-edge": "#c2cad4",
    "--console-btn-active": "#0a7d4b",
    "--console-btn-label": "#56616e",
    "--console-text": "#56616e",
    "--code-bg": "#0f1720",
    "--code-fg": "#e6edf3",
    "--code-border": "#23303f",
    "--font-sans": SANS,
    "--font-mono": MONO,
    "--font-display": '"Space Grotesk", ' + SANS,
    "--shadow-1": "0 1px 2px rgba(15,23,32,0.06)",
    "--shadow-2": "0 16px 40px rgba(15,23,32,0.1)",
  },
};

export const THEMES: Theme[] = [cartridge, pspSilver, dmg, light];

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

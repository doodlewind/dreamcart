/**
 * The base stylesheet — references ONLY tokens (var(--*)). No raw colors. This is
 * the theme-agnostic layout/structure layer; themes restyle by rebinding tokens
 * and (rarely) adding [data-theme] [data-part] rules in themes.ts.
 *
 * Components mark their structural hooks with data-part="..."; rules here select
 * those parts so all four themes inherit the same layout for free.
 */
export const baseCss = /* css */ `
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap");

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
:root { color-scheme: dark; }

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
img, canvas, svg { display: block; max-width: 100%; }
h1, h2, h3, h4 { font-family: var(--font-display); line-height: 1.15; margin: 0 0 .5em; font-weight: 700; }
code, pre, kbd { font-family: var(--font-mono); }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 3px; }

.container { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
.container-narrow { max-width: 820px; margin: 0 auto; padding: 0 24px; }

/* ── Top nav ─────────────────────────────────────────────────────────────── */
[data-part="nav"] {
  position: sticky; top: 0; z-index: 50;
  display: flex; align-items: center; gap: 18px;
  height: 58px; padding: 0 24px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: saturate(1.2) blur(10px);
  border-bottom: 1px solid var(--border);
}
[data-part="nav-brand"] {
  display: inline-flex; align-items: center; gap: 10px;
  font-family: var(--font-display); font-weight: 700; font-size: 18px;
  color: var(--fg); white-space: nowrap;
}
[data-part="nav-brand"]:hover { text-decoration: none; }
/* Brand mark = the DreamCart cartridge logo bitmap. */
[data-part="nav-brand-mark"] {
  width: 30px; height: 30px; flex: none;
  background: center / contain no-repeat url("/logo.png");
  filter: drop-shadow(0 2px 3px rgba(0,0,0,0.45));
}
[data-part="nav-links"] { display: flex; align-items: center; gap: 4px; margin-left: 8px; }
[data-part="nav-link"] {
  color: var(--fg-muted); padding: 7px 11px; border-radius: 7px; font-weight: 500;
  font-size: 14px; white-space: nowrap;
}
[data-part="nav-link"]:hover { color: var(--fg); background: var(--accent-soft); text-decoration: none; }
[data-part="nav-link"][aria-current="page"] { color: var(--accent); background: var(--accent-soft); }
/* GitHub logo link: icon-only, vertically centered. */
[data-part="nav-link"][data-icon="github"] { display: inline-flex; align-items: center; padding: 7px 9px; }
[data-part="nav-link"][data-icon="github"] svg { display: block; }
[data-part="nav-spacer"] { flex: 1; }

@media (max-width: 760px) {
  [data-part="nav-links"] { flex-wrap: wrap; justify-content: flex-end; margin-left: 0; }
  [data-part="nav-link"] { padding: 7px 8px; }
}

/* ── Buttons ─────────────────────────────────────────────────────────────── */
[data-part="button"] {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 40px; padding: 0 16px; border-radius: var(--btn-radius);
  background: var(--btn-face); color: var(--btn-fg);
  border: 1px solid var(--btn-border); font: inherit; font-weight: 600; font-size: 14px;
  cursor: pointer; text-decoration: none; transition: background .12s, transform .05s;
}
[data-part="button"]:hover { background: var(--btn-face-hover); text-decoration: none; }
[data-part="button"]:active { transform: translateY(1px); }
[data-part="button"][data-variant="primary"] {
  background: var(--accent); color: var(--accent-fg); border-color: transparent;
}
[data-part="button"][data-variant="primary"]:hover { filter: brightness(1.06); }
[data-part="button"][data-variant="ghost"] { background: transparent; border-color: transparent; color: var(--fg-muted); }
[data-part="button"][data-variant="ghost"]:hover { color: var(--fg); background: var(--accent-soft); }
[data-part="button"][data-size="sm"] { height: 32px; padding: 0 11px; font-size: 13px; }

/* ── Modal / Drawer ──────────────────────────────────────────────────────── */
[data-part="overlay"] {
  position: fixed; inset: 0; z-index: 100;
  background: color-mix(in srgb, #000 55%, transparent);
  display: flex; align-items: center; justify-content: center; padding: 24px;
  animation: dc-fade .15s ease;
}
[data-part="modal"] {
  width: min(960px, 100%); max-height: 88vh; display: flex; flex-direction: column;
  background: var(--surface); color: var(--fg);
  border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-2);
  overflow: hidden; animation: dc-pop .16s ease;
}
[data-part="modal"][data-variant="drawer"] {
  margin-left: auto; height: 100%; max-height: 100vh; width: min(640px, 100%);
  border-radius: 0; animation: dc-slide .18s ease;
}
[data-part="overlay"][data-variant="drawer"] { padding: 0; }
[data-part="modal-header"] {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; border-bottom: 1px solid var(--border);
}
[data-part="modal-title"] { font-family: var(--font-display); font-weight: 700; font-size: 15px; margin: 0; }
[data-part="modal-close"] {
  margin-left: auto; width: 32px; height: 32px; border-radius: 8px; cursor: pointer;
  background: transparent; border: 1px solid var(--border); color: var(--fg-muted);
  font-size: 16px; line-height: 1; display: grid; place-items: center;
}
[data-part="modal-close"]:hover { color: var(--fg); background: var(--accent-soft); }
[data-part="modal-body"] { padding: 16px; overflow: auto; }
@keyframes dc-fade { from { opacity: 0; } }
@keyframes dc-pop { from { opacity: 0; transform: scale(.97); } }
@keyframes dc-slide { from { transform: translateX(20px); opacity: .4; } }

/* ── Cards / sections ────────────────────────────────────────────────────── */
[data-part="card"] {
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  padding: 20px; box-shadow: var(--shadow-1);
}
.section { padding: 72px 0; }
.section--elev { background: var(--bg-elev); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.eyebrow { color: var(--accent); font-weight: 600; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; }
.muted { color: var(--fg-muted); }
.lede { font-size: 18px; color: var(--fg-muted); max-width: 60ch; }
.grid { display: grid; gap: 18px; }
.grid--3 { grid-template-columns: repeat(3, 1fr); }
.grid--2 { grid-template-columns: repeat(2, 1fr); }
@media (max-width: 820px) { .grid--3, .grid--2 { grid-template-columns: 1fr; } }
.badge {
  display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px;
  background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 600;
}

/* ── Hero ────────────────────────────────────────────────────────────────── */
[data-part="hero"] { padding: 96px 0 72px; position: relative; overflow: hidden; }
[data-part="hero"] h1 {
  font-size: clamp(34px, 6vw, 60px); letter-spacing: -0.02em; margin-bottom: 18px;
}
[data-part="hero"] .accent { color: var(--accent); }
[data-part="hero"]::before {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background:
    radial-gradient(60ch 40ch at 18% -10%, var(--accent-soft), transparent 70%),
    linear-gradient(var(--border) 1px, transparent 1px) 0 0 / 100% 28px,
    linear-gradient(90deg, var(--border) 1px, transparent 1px) 0 0 / 28px 100%;
  opacity: .5; -webkit-mask-image: linear-gradient(180deg, #000, transparent 85%);
  mask-image: linear-gradient(180deg, #000, transparent 85%);
}
.hero-cart {
  margin-bottom: 22px; display: inline-flex; align-items: center; gap: 20px;
}
/* The big first-screen logo — a raster cartridge, lifted off the dark page with a
   soft drop-shadow plus a faint gold glow (matches the brand accent). */
.hero-cart .hero-cart-chip {
  height: 132px; width: auto; flex: none; display: block;
  filter: drop-shadow(0 22px 34px rgba(0,0,0,0.6)) drop-shadow(0 6px 16px rgba(233,178,76,0.16));
}
.hero-cart-word { font-family: var(--font-display); font-weight: 700; font-size: 40px; letter-spacing: -.01em; }
@media (max-width: 560px) {
  .hero-cart { gap: 14px; }
  .hero-cart .hero-cart-chip { height: 96px; }
  .hero-cart-word { font-size: 30px; }
}
.hero-stats { display: flex; flex-wrap: wrap; gap: 28px; margin-top: 40px; }
.hero-stat { min-width: 84px; }
.hero-stat b { display: block; font-family: var(--font-display); font-size: 26px; color: var(--fg); line-height: 1.1; }
.hero-stat span { font-size: 13px; color: var(--fg-muted); }

/* ── Feature / capability grid ─────────────────────────────────────────────── */
.feat-grid { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); margin-top: 30px; }
.feat-grid--2 { grid-template-columns: repeat(2, 1fr); }
@media (max-width: 880px) { .feat-grid, .feat-grid--2 { grid-template-columns: 1fr; } }
.feat {
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  padding: 20px; box-shadow: var(--shadow-1); transition: border-color .15s, transform .15s;
}
.feat:hover { border-color: var(--border-strong); transform: translateY(-2px); }
.feat h3 { font-size: 16px; margin: 0 0 6px; display: flex; align-items: center; gap: 9px; }
.feat p { margin: 0; color: var(--fg-muted); font-size: 14px; line-height: 1.55; }
.feat .feat-ic {
  width: 30px; height: 30px; border-radius: 8px; flex: none;
  display: grid; place-items: center; font-size: 15px;
  background: var(--accent-soft); color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}
.feat code { font-size: .85em; }

/* ── Contract diagram ──────────────────────────────────────────────────────── */
.contract { display: grid; grid-template-columns: 1fr; gap: 14px; margin-top: 30px; }
.contract-row {
  display: grid; grid-template-columns: 140px 1fr; gap: 16px; align-items: center;
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px;
}
@media (max-width: 640px) { .contract-row { grid-template-columns: 1fr; gap: 6px; } }
.contract-row .contract-tier { font-family: var(--font-display); font-weight: 700; font-size: 14px; }
.contract-row .contract-tier span { display: block; font-family: var(--font-sans); font-weight: 400; font-size: 12px; color: var(--fg-faint); }
.contract-row .contract-api { color: var(--fg-muted); font-size: 13px; }
.contract-row code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; font-size: 12px; color: var(--fg); }

/* ── Platforms ─────────────────────────────────────────────────────────────── */
.platform-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 30px; }
@media (max-width: 880px) { .platform-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 480px) { .platform-grid { grid-template-columns: 1fr; } }
.platform {
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  padding: 20px; box-shadow: var(--shadow-1);
}
.platform h3 { font-size: 17px; margin: 0 0 4px; }
.platform .platform-host { font-size: 13px; color: var(--fg-muted); margin: 0 0 12px; }
.platform dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 13px; }
.platform dt { color: var(--fg-faint); }
.platform dd { margin: 0; color: var(--fg); }

/* ── Games showcase ────────────────────────────────────────────────────────── */
.game-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 30px; }
@media (max-width: 880px) { .game-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 520px) { .game-grid { grid-template-columns: 1fr; } }
.game-card {
  display: flex; flex-direction: column; gap: 10px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  padding: 16px; box-shadow: var(--shadow-1); color: var(--fg);
  transition: border-color .15s, transform .15s;
}
.game-card:hover { border-color: var(--accent); transform: translateY(-2px); text-decoration: none; }
.game-card .game-screen {
  aspect-ratio: 480 / 272; border-radius: 8px; overflow: hidden;
  background: var(--console-screen-bg); border: 2px solid var(--console-screen-border);
  display: grid; place-items: center; position: relative;
}
.game-card .game-screen .game-glyph { font-size: 30px; opacity: .92; }
.game-card .game-name { font-family: var(--font-display); font-weight: 700; font-size: 15px; }
.game-card .game-tag { font-size: 12px; color: var(--fg-muted); }
.game-card .game-kind {
  position: absolute; top: 7px; left: 7px; font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .05em; padding: 2px 7px; border-radius: 999px;
  background: color-mix(in srgb, var(--bg) 72%, transparent); color: var(--accent);
  border: 1px solid var(--border);
}

/* ── Footer (constant chrome) ────────────────────────────────────────────── */
[data-part="footer"] {
  margin-top: 64px; padding: 22px 24px;
  border-top: 1px solid var(--border); background: var(--surface);
  color: var(--fg-faint); font-size: 13px;
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
}
[data-part="footer"] a { color: var(--fg-muted); }
[data-part="footer-mark"] { font-weight: 500; }

/* ── Code blocks / source modal / console log ────────────────────────────── */
pre, [data-part="code"] {
  background: var(--code-bg); color: var(--code-fg); border: 1px solid var(--code-border);
  border-radius: 10px; padding: 14px 16px; overflow: auto; font-size: 13px; line-height: 1.5;
  margin: 0 0 16px;
}
:not(pre) > code {
  background: var(--surface-2); color: var(--fg);
  border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; font-size: .9em;
}

/* ── Syntax highlighting — highlight.js classes mapped to syntax tokens, so every
   theme recolors code to match (no client JS; colors come from themes.ts). ─────── */
.hljs-comment, .hljs-quote { color: var(--code-comment); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag, .hljs-section,
.hljs-meta .hljs-keyword { color: var(--code-keyword); font-weight: 600; }
.hljs-string, .hljs-regexp, .hljs-meta .hljs-string, .hljs-template-tag,
.hljs-addition { color: var(--code-string); }
.hljs-number, .hljs-built_in, .hljs-bullet, .hljs-deletion { color: var(--code-number); }
.hljs-title, .hljs-title.function_, .hljs-section .hljs-title { color: var(--code-function); }
.hljs-type, .hljs-class .hljs-title, .hljs-title.class_, .hljs-attr, .hljs-attribute,
.hljs-property, .hljs-name, .hljs-selector-class, .hljs-selector-id,
.hljs-tag { color: var(--code-class); }
.hljs-variable, .hljs-params, .hljs-symbol, .hljs-template-variable,
.hljs-link, .hljs-meta { color: var(--code-variable); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
[data-part="source-editor"] {
  width: 100%; min-height: 360px; resize: vertical;
  background: var(--code-bg); color: var(--code-fg); border: 1px solid var(--code-border);
  border-radius: 10px; padding: 14px 16px; font-family: var(--font-mono); font-size: 13px; line-height: 1.5;
}
[data-part="console-log"] {
  background: var(--code-bg); color: var(--code-fg); border: 1px solid var(--code-border);
  border-radius: 10px; padding: 10px 12px; font-family: var(--font-mono); font-size: 12px;
  max-height: 180px; overflow: auto; white-space: pre-wrap;
}

/* ── Docs / changelog shell ──────────────────────────────────────────────── */
.docs-shell {
  display: grid; grid-template-columns: 220px minmax(0,1fr) 200px; gap: 36px;
  align-items: start; padding-top: 36px; padding-bottom: 64px;
}
.docs-sidebar, .docs-toc { position: sticky; top: 74px; align-self: start; font-size: 14px; }
.docs-sb-title {
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--fg-faint); font-weight: 600; margin: 18px 0 8px;
}
.docs-sb-section:first-child .docs-sb-title { margin-top: 0; }
.docs-sidebar ul, .docs-toc ul { list-style: none; margin: 0; padding: 0; }
.docs-sidebar li a, .docs-toc li a {
  display: block; padding: 5px 10px; border-radius: 7px; color: var(--fg-muted);
}
.docs-sidebar li a:hover, .docs-toc li a:hover { color: var(--fg); background: var(--accent-soft); text-decoration: none; }
.docs-sidebar li a[aria-current="page"] { color: var(--accent); background: var(--accent-soft); font-weight: 600; }
.docs-toc li[data-depth="3"] a { padding-left: 22px; font-size: 13px; }
.docs-article { min-width: 0; max-width: 760px; }
.docs-article h1 { font-size: 32px; margin-bottom: .4em; }
.docs-article h2 { font-size: 23px; margin-top: 1.6em; padding-top: .2em; }
.docs-article h3 { font-size: 18px; margin-top: 1.4em; }
.docs-article p, .docs-article li { color: var(--fg); }
.docs-article ul, .docs-article ol { padding-left: 22px; }
.docs-article li { margin: .3em 0; }
.docs-article a { text-decoration: underline; text-underline-offset: 2px; }
.docs-article table { border-collapse: collapse; width: 100%; margin: 0 0 16px; font-size: 14px; }
.docs-article th, .docs-article td { border: 1px solid var(--border); padding: 7px 10px; text-align: left; }
.docs-article th { background: var(--surface-2); }
.docs-article blockquote {
  margin: 0 0 16px; padding: 8px 16px; border-left: 3px solid var(--accent);
  background: var(--accent-soft); border-radius: 0 8px 8px 0; color: var(--fg-muted);
}
.docs-article .anchor { color: var(--fg-faint); margin-left: 8px; opacity: 0; text-decoration: none; }
.docs-article h2:hover .anchor, .docs-article h3:hover .anchor { opacity: 1; }
@media (max-width: 980px) {
  .docs-shell { grid-template-columns: 1fr; }
  .docs-sidebar, .docs-toc { position: static; }
  .docs-toc { display: none; }
}

/* ════════════════════════════════════════════════════════════════════════════
   THE HANDHELD CONSOLE SHELL (headless; themed via [data-theme] [data-part])
   data-layout="horizontal" (PSP-like, wide) | "vertical" (GBA-SP-like, narrow)
   ════════════════════════════════════════════════════════════════════════════ */
[data-part="console"] {
  position: relative; isolation: isolate;
  background: var(--console-shell); color: var(--console-text);
  border: 1px solid var(--console-edge);
  box-shadow: var(--shadow-2);
}
[data-part="console"][data-layout="horizontal"] {
  display: grid; align-items: center; gap: 20px;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas: "shoulders shoulders shoulders" "left screen right" "startsel startsel startsel";
  padding: 26px 30px; border-radius: 28px;
  width: min(840px, 100%);
}
[data-part="console"][data-layout="vertical"] {
  display: grid; justify-items: center; gap: 18px;
  grid-template-columns: 1fr 1fr;
  grid-template-areas: "shoulders shoulders" "screen screen" "left right" "startsel startsel";
  padding: 22px; border-radius: 22px;
  width: min(420px, 100%);
}
[data-part="console"][data-layout="vertical"] [data-part="console-dpad-zone"] { justify-self: start; }
[data-part="console"][data-layout="vertical"] [data-part="console-face-zone"] { justify-self: end; }
[data-part="console-shoulders"] {
  grid-area: shoulders; display: flex; justify-content: space-between; width: 100%;
}
[data-part="console-dpad-zone"] { grid-area: left; display: grid; gap: 14px; justify-items: center; }
[data-part="console-face-zone"] { grid-area: right; display: grid; gap: 14px; justify-items: center; }
[data-part="console-startsel"] { grid-area: startsel; display: flex; gap: 16px; justify-content: center; align-items: center; }

[data-part="console-screen"] {
  grid-area: screen; position: relative;
  background: var(--console-screen-bg);
  border: 6px solid var(--console-screen-border); border-radius: 10px;
  aspect-ratio: 480 / 272; width: 100%; max-width: 480px; margin: 0 auto;
  display: grid; place-items: center; overflow: hidden;
}
[data-part="console-screen"] canvas {
  width: 100%; height: 100%; image-rendering: pixelated; display: block;
}
[data-part="console-brand"] {
  position: absolute; bottom: 8px; right: 14px; z-index: 1;
  font-family: var(--font-display); font-weight: 700; font-size: 11px;
  color: var(--console-text); opacity: .8; letter-spacing: .04em; pointer-events: none;
}

/* Generic console buttons */
[data-part="console-btn"] {
  background: var(--console-btn); color: var(--console-btn-label);
  border: 1px solid var(--console-btn-edge); cursor: pointer;
  display: grid; place-items: center; font: inherit; font-weight: 700; font-size: 13px;
  box-shadow: 0 2px 0 var(--console-btn-edge); user-select: none; -webkit-user-select: none;
  touch-action: none;
}
[data-part="console-btn"]:active, [data-part="console-btn"][data-pressed="true"] {
  background: var(--console-btn-active); color: var(--accent-fg);
  transform: translateY(2px); box-shadow: none;
}
[data-part="console-btn"]:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

/* D-pad: a 3x3 grid cross */
[data-part="console-dpad"] {
  display: grid; grid-template-columns: repeat(3, 34px); grid-template-rows: repeat(3, 34px);
  gap: 0;
}
[data-part="console-dpad"] [data-part="console-btn"] { width: 34px; height: 34px; }
[data-part="console-dpad"] [data-dir="up"] { grid-area: 1 / 2; border-radius: 7px 7px 0 0; }
[data-part="console-dpad"] [data-dir="left"] { grid-area: 2 / 1; border-radius: 7px 0 0 7px; }
[data-part="console-dpad"] [data-dir="center"] { grid-area: 2 / 2; background: var(--console-btn); border: 1px solid var(--console-btn-edge); box-shadow: none; cursor: default; }
[data-part="console-dpad"] [data-dir="right"] { grid-area: 2 / 3; border-radius: 0 7px 7px 0; }
[data-part="console-dpad"] [data-dir="down"] { grid-area: 3 / 2; border-radius: 0 0 7px 7px; }

/* Analog nub (decorative; PSP look) */
[data-part="console-nub"] {
  width: 40px; height: 40px; border-radius: 50%;
  background: radial-gradient(circle at 38% 34%, var(--console-edge), var(--console-btn) 70%);
  border: 1px solid var(--console-btn-edge); box-shadow: inset 0 0 6px rgba(0,0,0,.4);
}

/* Face buttons (△ ○ ✕ □) in a diamond */
[data-part="console-face"] {
  display: grid; grid-template-columns: repeat(3, 34px); grid-template-rows: repeat(3, 34px);
}
[data-part="console-face"] [data-part="console-btn"] { width: 34px; height: 34px; border-radius: 50%; }
[data-part="console-face"] [data-btn="triangle"] { grid-area: 1 / 2; }
[data-part="console-face"] [data-btn="square"] { grid-area: 2 / 1; }
[data-part="console-face"] [data-btn="circle"] { grid-area: 2 / 3; }
[data-part="console-face"] [data-btn="cross"] { grid-area: 3 / 2; }

/* Shoulder buttons */
[data-part="console-btn"][data-shoulder] { width: 78px; height: 26px; border-radius: 6px 6px 12px 12px; }

/* Start / Select pills */
[data-part="console-startsel"] [data-part="console-btn"] {
  height: 22px; min-width: 56px; padding: 0 12px; border-radius: 999px; font-size: 11px;
  letter-spacing: .06em; text-transform: uppercase;
}

/* ── Playground page (/play) ─────────────────────────────────────────────── */
.play-intro { padding-top: 40px; }
.play-title { font-size: clamp(28px, 4vw, 40px); letter-spacing: -.02em; margin: 6px 0 14px; }

.play-toolbar {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  margin: 26px auto 4px;
}
.play-toolbar-spacer { flex: 1 1 auto; }

/* Cartridge-slot picker */
.play-slot {
  display: inline-flex; align-items: center; gap: 10px;
  background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: 12px; padding: 6px 6px 6px 14px; box-shadow: var(--shadow-1);
}
.play-slot-label {
  font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: var(--fg-faint);
}
[data-part="play-select"] {
  appearance: none; -webkit-appearance: none;
  background: var(--bg-elev); color: var(--fg);
  border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 30px 8px 12px; font: inherit; font-weight: 600; font-size: 14px;
  cursor: pointer; min-width: 200px;
  background-image: linear-gradient(45deg, transparent 50%, var(--fg-muted) 50%),
                    linear-gradient(135deg, var(--fg-muted) 50%, transparent 50%);
  background-position: right 14px center, right 9px center;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
}
[data-part="play-select"]:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

.play-fps {
  font-variant-numeric: tabular-nums; font-family: var(--font-mono);
}
.play-controls-hint {
  font-size: 12.5px; color: var(--fg-muted);
  max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.play-transport { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.play-stage {
  display: grid; place-items: center;
  padding: 22px 16px 64px;
}
.play-screen-mount { width: 100%; height: 100%; display: block; }

/* Console log header inside the Code drawer */
.play-console-head {
  display: flex; align-items: baseline; justify-content: space-between;
  margin: 22px 0 8px;
}
.play-console-title {
  font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: var(--fg-faint);
}
.play-console-clear {
  background: none; border: none; cursor: pointer; padding: 0;
  font: inherit; font-size: 12px; color: var(--accent);
}
.play-console-clear:hover { text-decoration: underline; }

@media (max-width: 760px) {
  .play-toolbar { gap: 10px; }
  .play-controls-hint { display: none; }
  .play-slot { flex: 1 1 100%; }
  [data-part="play-select"] { flex: 1; min-width: 0; }
  .play-toolbar-spacer { display: none; }
  .play-transport { flex: 1 1 100%; justify-content: space-between; }
}
`;

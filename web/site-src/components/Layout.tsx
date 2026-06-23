/**
 * Layout — the shared page chrome wrapping EVERY route. ThemeProvider + top Nav +
 * the page content + the constant footer mark. Page entries render
 * <Layout active="...">…page body…</Layout>.
 *
 * The footer mirrors sheru's .site-footer in spirit: a muted, token-driven bar
 * reading "© 2026 TypeSafe Limited", carried on every route.
 */
import type { ReactNode } from "react";
import { ThemeProvider } from "./ThemeProvider";
import { Nav, type NavKey } from "./Nav";

const GITHUB = "https://github.com/doodlewind/dreamcart";

export function Layout({
  active = null,
  children,
  /** Set false on the Playground so the console can use full height. */
  contained = true,
}: {
  active?: NavKey;
  children: ReactNode;
  contained?: boolean;
}) {
  return (
    <ThemeProvider>
      <Nav active={active} />
      <main>{contained ? children : children}</main>
      <footer data-part="footer">
        <span data-part="footer-mark">© 2026 TypeSafe Limited</span>
        <span aria-hidden="true">·</span>
        <a href="/docs/">Docs</a>
        <a href="/changelog/">Changelog</a>
        <a href={GITHUB} target="_blank" rel="noopener">
          GitHub
        </a>
        <span style={{ marginLeft: "auto", color: "var(--fg-faint)" }}>
          Self-contained game cartridges for tiny worlds
        </span>
      </footer>
    </ThemeProvider>
  );
}

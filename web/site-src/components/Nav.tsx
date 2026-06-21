/**
 * Nav — the top navigation present on every page. Links: Engine (/#engine),
 * Playground (/play/), Docs (/docs/), Changelog (/changelog/), GitHub (external),
 * plus the live ThemePicker. `active` highlights the current route.
 * Headless markup via data-part; styled in base.ts.
 */
import { ThemePicker } from "./ThemePicker";

export type NavKey = "engine" | "play" | "docs" | "changelog" | null;

const GITHUB = "https://github.com/doodlewind/dreamcart";

const LINKS: { key: Exclude<NavKey, null>; label: string; href: string }[] = [
  { key: "engine", label: "Engine", href: "/#engine" },
  { key: "play", label: "Playground", href: "/play/" },
  { key: "docs", label: "Docs", href: "/docs/" },
  { key: "changelog", label: "Changelog", href: "/changelog/" },
];

export function Nav({ active = null }: { active?: NavKey }) {
  return (
    <nav data-part="nav" aria-label="Primary">
      <a data-part="nav-brand" href="/">
        <span data-part="nav-brand-mark">DC</span>
        DreamCart
      </a>
      <div data-part="nav-spacer" />
      <div data-part="nav-links">
        {LINKS.map((l) => (
          <a
            key={l.key}
            data-part="nav-link"
            href={l.href}
            aria-current={active === l.key ? "page" : undefined}
          >
            {l.label}
          </a>
        ))}
        <a
          data-part="nav-link"
          data-icon="github"
          href={GITHUB}
          target="_blank"
          rel="noopener"
          aria-label="DreamCart on GitHub"
          title="GitHub"
        >
          <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
        </a>
      </div>
      <ThemePicker />
    </nav>
  );
}

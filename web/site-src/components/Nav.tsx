/**
 * Nav — the top navigation present on every page. Links: Engine (/#engine),
 * Playground (/play/), Docs (/docs/), Changelog (/changelog/), GitHub (external),
 * plus the live ThemePicker. `active` highlights the current route.
 * Headless markup via data-part; styled in base.ts.
 */
import { useState } from "react";
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
  const [open, setOpen] = useState(false);
  return (
    <nav data-part="nav" data-open={open} aria-label="Primary">
      <a data-part="nav-brand" href="/">
        <span data-part="nav-brand-mark">DC</span>
        DreamCart
      </a>
      <div data-part="nav-spacer" />
      <button
        type="button"
        data-part="button"
        data-nav-toggle="true"
        data-variant="ghost"
        data-size="sm"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ☰
      </button>
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
        <a data-part="nav-link" href={GITHUB} target="_blank" rel="noopener">
          GitHub ↗
        </a>
      </div>
      <ThemePicker />
    </nav>
  );
}

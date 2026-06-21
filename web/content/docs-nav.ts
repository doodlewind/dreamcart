/**
 * Docs navigation — the ordered list of doc slugs and their titles/sections. The
 * build renders one HTML page per slug (from content/docs/<slug>.md) and uses this
 * for the sidebar order. CONTENT AGENTS: fill the matching .md files; add a slug
 * here only if you add a new docs page.
 */
export interface DocSlug {
  slug: string; // file is content/docs/<slug>.md; route is /docs/<slug>/ ("" => /docs/)
  title: string;
}
export interface DocSection {
  title: string;
  pages: DocSlug[];
}

export const DOCS_NAV: DocSection[] = [
  {
    title: "Overview",
    pages: [
      { slug: "", title: "Overview & architecture" },
      { slug: "getting-started", title: "Getting started" },
    ],
  },
  {
    title: "Engine",
    pages: [
      { slug: "runtime-contract", title: "Runtime contract" },
      { slug: "framework", title: "Framework SDK" },
      { slug: "3d", title: "3D" },
    ],
  },
  {
    title: "Pipeline & platforms",
    pages: [
      { slug: "assets", title: "Assets & .dcpak" },
      { slug: "worlds", title: "World import" },
      { slug: "platforms", title: "Platforms & builds" },
    ],
  },
  {
    title: "Reference",
    pages: [{ slug: "api", title: "API reference" }],
  },
];

/** Flat ordered list of all doc pages. */
export const DOCS_PAGES: DocSlug[] = DOCS_NAV.flatMap((s) => s.pages);

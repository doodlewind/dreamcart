// Assembles web/site/ — the static directory deployed to Cloudflare Pages
// (dreamcart.games). Builds the Bun+React MPA, renders docs+changelog markdown at
// build time, and wires the Playground to the vanilla engine.
//
//   bun web/deploy-build.ts            # full build into web/site/
//   bun web/deploy-build.ts --dev      # unminified + sourcemaps
//
// Routes produced (each a static dir with index.html):
//   /            Home / Engine        (entry: site-src/entries/home.tsx)
//   /play/       Playground           (entry: site-src/entries/play.tsx) + engine.js + games.generated.js
//   /docs/[...]  Docs (one page/slug) (entry: site-src/entries/docs.tsx)
//   /changelog/  Changelog            (entry: site-src/entries/changelog.tsx)
import { rm, mkdir, copyFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildGames } from "./build-games.ts";
import { siteCss } from "./site-src/styles/site-css.ts";
import { PREPAINT_SNIPPET } from "./site-src/lib/theme.ts";
import { renderMarkdown } from "./site-src/lib/markdown.ts";
import { DOCS_NAV, DOCS_PAGES } from "./content/docs-nav.ts";
import type { DocsPageData } from "./site-src/pages/DocsPage.tsx";
import type { ChangelogPageData } from "./site-src/pages/ChangelogPage.tsx";

const DEV = process.argv.includes("--dev");
const here = new URL(".", import.meta.url).pathname; // the web/ dir
const out = join(here, "site");
const srcEntries = join(here, "site-src/entries");
const contentDir = join(here, "content");

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** Build one client entry (.tsx) to a single ESM file at site/<outRel>. */
async function buildEntry(entry: string, outRel: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(srcEntries, entry)],
    target: "browser",
    format: "esm",
    minify: !DEV,
    sourcemap: DEV ? "linked" : "none",
    define: { "process.env.NODE_ENV": JSON.stringify(DEV ? "development" : "production") },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed: ${entry}`);
  }
  // Single JS artifact (CSS is shipped separately via site.css).
  const js = result.outputs.find((o) => o.kind === "entry-point" || o.path.endsWith(".js"));
  if (!js) throw new Error(`no JS output for ${entry}`);
  const dest = join(out, outRel);
  await mkdir(join(dest, ".."), { recursive: true });
  await Bun.write(dest, await js.text());
  return dest;
}

/** Emit a route's index.html: prepaint theme + css + #root + optional data + scripts. */
async function writeHtml(opts: {
  dir: string; // e.g. "" for /, "play" for /play/, "docs/3d" for /docs/3d/
  title: string;
  description: string;
  cssHref: string; // root-absolute path to site.css
  bundleHref: string; // root-absolute path to the route's JS bundle
  /** Extra <script> tags inserted BEFORE the bundle (e.g. engine.js, data globals). */
  preScripts?: string;
}): Promise<void> {
  const dest = join(out, opts.dir, "index.html");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${opts.title}</title>
    <meta name="description" content="${opts.description}" />
    <link
      rel="icon"
      href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='14'>🎮</text></svg>"
    />
    <script>${PREPAINT_SNIPPET}</script>
    <link rel="stylesheet" href="${opts.cssHref}" />
  </head>
  <body>
    <div id="root"></div>
${opts.preScripts ?? ""}
    <script type="module" src="${opts.bundleHref}"></script>
  </body>
</html>
`;
  await mkdir(join(dest, ".."), { recursive: true });
  await Bun.write(dest, html);
}

// Framework games (framework/games/*.js) are bundled into runtime/src/game/<name>.js
// by framework/build.ts before the manifest is generated — those bundles are build
// artifacts (gitignored), so a clean checkout / CI / Cloudflare deploy holds only the
// committed raw-*.js until this runs. The bundle only needs the committed assets.dcstore
// + the authored game sources, so it works on a fresh tree. If it fails (e.g. a private
// asset store is missing), we still build the site with whatever games are present.
async function bundleFrameworkGames(): Promise<void> {
  const proc = Bun.spawn(["bun", join(here, "../framework/build.ts")], {
    cwd: join(here, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    console.warn(`⚠ framework bundle skipped (exit ${code}); building with existing game bundles only.\n${err.trim()}`);
  }
}

export async function buildSite(): Promise<void> {
  const startedAt = performance.now();

  // (a) bundle framework games, then refresh the game manifest.
  await bundleFrameworkGames();
  const nGames = await buildGames();

  // Fresh output dir.
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // Shared stylesheet.
  const css = siteCss();
  await mkdir(join(out, "assets"), { recursive: true });
  await Bun.write(join(out, "assets/site.css"), css);
  const CSS = "/assets/site.css";

  // (b) Home.
  await buildEntry("home.tsx", "assets/home.js");
  await writeHtml({
    dir: "",
    title: "DreamCart — Self-contained game cartridges for tiny worlds",
    description:
      "An isomorphic JavaScript game runtime: one .js game runs unchanged on PSP, Web, 3DS and Android, powered by QuickJS.",
    cssHref: CSS,
    bundleHref: "/assets/home.js",
  });

  // (c) Playground — needs engine.js + games.generated.js as plain scripts first.
  await buildEntry("play.tsx", "assets/play.js");
  await mkdir(join(out, "play"), { recursive: true });
  await copyFile(join(here, "engine.js"), join(out, "play/engine.js"));
  await copyFile(join(here, "games.generated.js"), join(out, "play/games.generated.js"));
  await writeHtml({
    dir: "play",
    title: "Playground — DreamCart",
    description: "Run DreamCart games in a themeable handheld console, right in your browser.",
    cssHref: CSS,
    bundleHref: "/assets/play.js",
    preScripts:
      `    <script src="/play/engine.js"></script>\n` +
      `    <script src="/play/games.generated.js"></script>`,
  });

  // (d) Docs — render every slug's markdown, one static page each.
  await buildEntry("docs.tsx", "assets/docs.js");
  const navData = DOCS_NAV.map((s) => ({
    title: s.title,
    pages: s.pages.map((p) => ({ slug: p.slug, title: p.title })),
  }));
  let missing = 0;
  for (const page of DOCS_PAGES) {
    const file = join(contentDir, "docs", `${page.slug === "" ? "index" : page.slug}.md`);
    let md = "";
    if (await Bun.file(file).exists()) md = await Bun.file(file).text();
    else {
      console.warn(`  ⚠ missing docs content: ${relative(here, file)}`);
      missing++;
      md = `# ${page.title}\n\n_Content coming soon._`;
    }
    const { html, headings } = renderMarkdown(md);
    const data: DocsPageData = {
      slug: page.slug,
      title: page.title,
      bodyHtml: html,
      nav: navData,
      headings,
    };
    await writeHtml({
      dir: page.slug === "" ? "docs" : `docs/${page.slug}`,
      title: `${page.title} — DreamCart Docs`,
      description: `DreamCart documentation: ${page.title}.`,
      cssHref: CSS,
      bundleHref: "/assets/docs.js",
      preScripts: `    <script>window.__DOCS_DATA__=${jsonScript(data)};</script>`,
    });
  }

  // (e) Changelog.
  await buildEntry("changelog.tsx", "assets/changelog.js");
  {
    const file = join(contentDir, "changelog.md");
    const md = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "# Changelog\n";
    const { html, headings } = renderMarkdown(md);
    const data: ChangelogPageData = {
      bodyHtml: html,
      weeks: headings.filter((h) => h.depth === 2),
    };
    await writeHtml({
      dir: "changelog",
      title: "Changelog — DreamCart",
      description: "Weekly summaries of new DreamCart capabilities.",
      cssHref: CSS,
      bundleHref: "/assets/changelog.js",
      preScripts: `    <script>window.__CHANGELOG_DATA__=${jsonScript(data)};</script>`,
    });
  }

  const elapsed = Math.round(performance.now() - startedAt);
  console.log(
    `✓ web/site assembled — / · /play/ (${nGames} games) · /docs/ (${DOCS_PAGES.length} pages` +
      `${missing ? `, ${missing} stub` : ""}) · /changelog/  (${elapsed} ms)`,
  );
}

/** Safe JSON for embedding in an inline <script> (escapes </ to avoid breakout). */
function jsonScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

if (import.meta.main) {
  await buildSite();
}

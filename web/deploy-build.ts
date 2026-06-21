// Assembles web/site/ — the static directory deployed to Cloudflare Pages
// (dreamcart.games). Builds the Bun+React MPA, renders docs+changelog markdown at
// build time, emits full SEO metadata (canonical, Open Graph, Twitter, JSON-LD,
// sitemap, robots), content-hashes the JS/CSS bundles for safe long-term caching,
// and wires the Playground to the vanilla engine.
//
//   bun web/deploy-build.ts            # full build into web/site/
//   bun web/deploy-build.ts --dev      # unminified + sourcemaps
//
// Routes produced (each a static dir with index.html):
//   /            Home / Engine        (entry: site-src/entries/home.tsx)
//   /play/       Playground           (entry: site-src/entries/play.tsx) + engine.js + games.generated.js
//   /docs/[...]  Docs (one page/slug) (entry: site-src/entries/docs.tsx)
//   /changelog/  Changelog            (entry: site-src/entries/changelog.tsx)
//
// OG images + favicons are committed under web/static/ (regenerate with `bun run og`);
// this build copies them verbatim, so a clean CI/Cloudflare build needs no browser.
import { rm, mkdir, copyFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
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
const staticDir = join(here, "static");

/** Canonical origin. No trailing slash. */
const SITE_URL = "https://dreamcart.games";
const SITE_NAME = "DreamCart";
/** Brand theme-color = the cartridge (default) theme background. */
const THEME_COLOR = "#0a0e0c";

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
/** Short content hash for cache-busting (wyhash → 8 hex chars). */
const hash = (s: string) => Bun.hash(s).toString(16).padStart(16, "0").slice(0, 8);
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Root-absolute path ("" → /, "play" → /play/) → absolute canonical URL. */
const canonical = (dir: string) => `${SITE_URL}/${dir ? dir + "/" : ""}`;

/** Build one client entry (.tsx) to a CONTENT-HASHED ESM file under /assets; returns its href. */
async function buildEntry(entry: string, name: string): Promise<string> {
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
  const js = result.outputs.find((o) => o.kind === "entry-point" || o.path.endsWith(".js"));
  if (!js) throw new Error(`no JS output for ${entry}`);
  const text = await js.text();
  const href = `/assets/${name}.${hash(text)}.js`;
  await Bun.write(join(out, href.slice(1)), text);
  return href;
}

interface PageMeta {
  dir: string; // route dir: "" | "play" | "docs/3d" | "changelog"
  title: string; // <title> (full, incl. brand)
  ogTitle: string; // shorter social title
  description: string;
  cssHref: string;
  bundleHref: string;
  ogImage: string; // root-absolute (e.g. /og/home.png)
  ogType?: string; // default "website"
  jsonLd?: object[];
  preScripts?: string;
}

/** Emit a route's index.html with full SEO metadata. */
async function writeHtml(m: PageMeta): Promise<void> {
  const url = canonical(m.dir);
  const ogImageAbs = SITE_URL + m.ogImage;
  const ld = (m.jsonLd ?? [])
    .map((o) => `    <script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`)
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(m.title)}</title>
    <meta name="description" content="${esc(m.description)}" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <meta name="theme-color" content="${THEME_COLOR}" />
    <link rel="canonical" href="${url}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon.png" sizes="32x32" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta property="og:type" content="${m.ogType ?? "website"}" />
    <meta property="og:site_name" content="${SITE_NAME}" />
    <meta property="og:title" content="${esc(m.ogTitle)}" />
    <meta property="og:description" content="${esc(m.description)}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${ogImageAbs}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${esc(m.ogTitle)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(m.ogTitle)}" />
    <meta name="twitter:description" content="${esc(m.description)}" />
    <meta name="twitter:image" content="${ogImageAbs}" />
${ld ? ld + "\n" : ""}    <script>${PREPAINT_SNIPPET}</script>
    <link rel="stylesheet" href="${m.cssHref}" />
  </head>
  <body>
    <div id="root"></div>
${m.preScripts ?? ""}
    <script type="module" src="${m.bundleHref}"></script>
  </body>
</html>
`;
  await mkdir(join(out, m.dir), { recursive: true });
  await Bun.write(join(out, m.dir, "index.html"), html);
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

/** WebSite JSON-LD shared by every page. */
const WEBSITE_LD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE_NAME,
  url: SITE_URL + "/",
  description:
    "An isomorphic JavaScript game runtime — one .js game runs unchanged on PSP, Web, 3DS and Android.",
};
/** SoftwareApplication JSON-LD for the home page. */
const SOFTWARE_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "GameApplication",
  operatingSystem: "Sony PSP, Web, Nintendo 3DS, Android",
  url: SITE_URL + "/",
  description:
    "Self-contained game cartridges for tiny worlds: an isomorphic JS game runtime powered by QuickJS, with hardware-accelerated 3D and a themeable browser Playground.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: { "@type": "Organization", name: "doodlewind", url: "https://github.com/doodlewind/dreamcart" },
};

export async function buildSite(): Promise<void> {
  const startedAt = performance.now();

  // (a) bundle framework games, then refresh the game manifest.
  await bundleFrameworkGames();
  const nGames = await buildGames();

  // Fresh output dir.
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "assets"), { recursive: true });

  // Committed static assets (favicons, OG images) — copied verbatim.
  if (existsSync(staticDir)) await cp(staticDir, out, { recursive: true });

  // Shared stylesheet — content-hashed.
  const css = siteCss();
  const CSS = `/assets/site.${hash(css)}.css`;
  await Bun.write(join(out, CSS.slice(1)), css);

  const routes: string[] = []; // for sitemap

  // (b) Home.
  routes.push("");
  await writeHtml({
    dir: "",
    title: "DreamCart — Self-contained game cartridges for tiny worlds",
    ogTitle: "DreamCart — game cartridges for tiny worlds",
    description:
      "An isomorphic JavaScript game runtime: one .js game runs unchanged on PSP, Web, 3DS and Android, powered by QuickJS — with hardware-accelerated 3D and a themeable browser Playground.",
    cssHref: CSS,
    bundleHref: await buildEntry("home.tsx", "home"),
    ogImage: "/og/home.png",
    jsonLd: [WEBSITE_LD, SOFTWARE_LD],
  });

  // (c) Playground — needs engine.js + games.generated.js as plain scripts first.
  routes.push("play");
  await mkdir(join(out, "play"), { recursive: true });
  await copyFile(join(here, "engine.js"), join(out, "play/engine.js"));
  await copyFile(join(here, "games.generated.js"), join(out, "play/games.generated.js"));
  await writeHtml({
    dir: "play",
    title: "Playground — DreamCart",
    ogTitle: "DreamCart Playground",
    description:
      "Run DreamCart games in a themeable handheld console, right in your browser — the same .js that runs on PSP, 3DS and Android.",
    cssHref: CSS,
    bundleHref: await buildEntry("play.tsx", "play"),
    ogImage: "/og/play.png",
    jsonLd: [WEBSITE_LD],
    preScripts:
      `    <script src="/play/engine.js"></script>\n` +
      `    <script src="/play/games.generated.js"></script>`,
  });

  // (d) Docs — render every slug's markdown, one static page each.
  const docsBundle = await buildEntry("docs.tsx", "docs");
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
    const data: DocsPageData = { slug: page.slug, title: page.title, bodyHtml: html, nav: navData, headings };
    const dir = page.slug === "" ? "docs" : `docs/${page.slug}`;
    routes.push(dir);
    await writeHtml({
      dir,
      title: `${page.title} — DreamCart Docs`,
      ogTitle: `${page.title} — DreamCart Docs`,
      description: `DreamCart documentation: ${page.title}. Architecture, runtime contract and lib API for the isomorphic game runtime.`,
      cssHref: CSS,
      bundleHref: docsBundle,
      ogImage: "/og/docs.png",
      ogType: "article",
      jsonLd: [WEBSITE_LD],
      preScripts: `    <script>window.__DOCS_DATA__=${jsonScript(data)};</script>`,
    });
  }

  // (e) Changelog.
  routes.push("changelog");
  {
    const file = join(contentDir, "changelog.md");
    const md = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "# Changelog\n";
    const { html, headings } = renderMarkdown(md);
    const data: ChangelogPageData = { bodyHtml: html, weeks: headings.filter((h) => h.depth === 2) };
    await writeHtml({
      dir: "changelog",
      title: "Changelog — DreamCart",
      ogTitle: "DreamCart Changelog",
      description: "Weekly summaries of new DreamCart capabilities — the isomorphic game runtime for PSP, Web, 3DS and Android.",
      cssHref: CSS,
      bundleHref: await buildEntry("changelog.tsx", "changelog"),
      ogImage: "/og/changelog.png",
      ogType: "article",
      jsonLd: [WEBSITE_LD],
      preScripts: `    <script>window.__CHANGELOG_DATA__=${jsonScript(data)};</script>`,
    });
  }

  // (f) SEO infra: sitemap, robots, caching headers.
  await writeSeoInfra(routes);

  const elapsed = Math.round(performance.now() - startedAt);
  console.log(
    `✓ web/site assembled — / · /play/ (${nGames} games) · /docs/ (${DOCS_PAGES.length} pages` +
      `${missing ? `, ${missing} stub` : ""}) · /changelog/ · sitemap+robots+_headers  (${elapsed} ms)`,
  );
}

/** sitemap.xml, robots.txt and the Cloudflare Pages _headers cache policy. */
async function writeSeoInfra(routes: string[]): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const priority = (dir: string) => (dir === "" ? "1.0" : dir === "play" || dir === "docs" ? "0.9" : "0.7");
  const urls = routes
    .map(
      (dir) =>
        `  <url><loc>${canonical(dir)}</loc><lastmod>${today}</lastmod>` +
        `<changefreq>${dir === "changelog" ? "weekly" : "monthly"}</changefreq>` +
        `<priority>${priority(dir)}</priority></url>`,
    )
    .join("\n");
  await Bun.write(
    join(out, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
  await Bun.write(join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  // Hashed bundles are immutable; everything else (HTML, engine.js, games.generated.js,
  // favicons, OG images) must revalidate so deploys are never served stale.
  await Bun.write(
    join(out, "_headers"),
    [
      "/*",
      "  Cache-Control: public, max-age=0, must-revalidate",
      "/assets/*",
      "  Cache-Control: public, max-age=31536000, immutable",
      "",
    ].join("\n"),
  );
}

/** Safe JSON for embedding in an inline <script> (escapes </ to avoid breakout). */
function jsonScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

if (import.meta.main) {
  await buildSite();
}

/**
 * Build-time markdown -> HTML. Uses `marked` with slugged h2/h3 headings (anchor
 * links + a collected TOC). Code blocks are syntax-highlighted at BUILD TIME with
 * highlight.js into class-based <span>s (hljs-keyword, hljs-string, …) — no client
 * JS ships; the `.hljs-*` colors are token-driven in base.ts/themes.ts, so every
 * theme recolors syntax to match. Runs only in the Bun build, never in the browser.
 */
import { Marked } from "marked";
import hljs from "highlight.js";
import type { DocHeading } from "../pages/DocsPage";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Render markdown, returning the HTML and the collected h2/h3 headings. */
export function renderMarkdown(md: string): {
  html: string;
  headings: DocHeading[];
} {
  const headings: DocHeading[] = [];
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      code({ text, lang }) {
        // highlight.js escapes its own output; only fall back to manual escaping
        // for unknown / no language. Strip a trailing newline marked passes through.
        const language = (lang ?? "").trim().split(/\s+/)[0];
        let inner: string;
        if (language && hljs.getLanguage(language)) {
          inner = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        } else {
          inner = escapeHtml(text);
        }
        const cls = language ? `hljs language-${language}` : "hljs";
        return `<pre data-part="code"><code class="${cls}">${inner}</code></pre>\n`;
      },
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const plain = text.replace(/<[^>]+>/g, "");
        if (depth === 1) return `<h1>${text}</h1>\n`;
        const slug = slugify(plain);
        if (depth === 2 || depth === 3) headings.push({ depth, text: plain, slug });
        return `<h${depth} id="${slug}">${text}<a class="anchor" href="#${slug}" aria-hidden="true">#</a></h${depth}>\n`;
      },
    },
  });
  const html = marked.parse(md) as string;
  return { html, headings };
}

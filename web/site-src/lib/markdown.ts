/**
 * Build-time markdown -> HTML. Uses `marked` with slugged h2/h3 headings (anchor
 * links + a collected TOC). Code blocks render as token-themed <pre><code> (no
 * client JS / no syntax highlighter — keeps pages tiny; themes recolor via tokens).
 * Runs only in the Bun build (Node-ish), never shipped to the browser.
 */
import { Marked } from "marked";
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
        const cls = lang ? ` class="language-${lang}"` : "";
        return `<pre data-part="code"><code${cls}>${escapeHtml(text)}</code></pre>\n`;
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

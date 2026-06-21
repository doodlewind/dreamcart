/**
 * Assembles the full site stylesheet at build time: base (token-referencing
 * layout) + the four theme blocks (token bindings + scoped CSS). The build writes
 * the result to web/site/assets/site.css and links it from every page.
 */
import { baseCss } from "./base";
import { themesCss } from "./themes";

export function siteCss(): string {
  return [
    "/* DreamCart site styles — generated from web/site-src/styles. */",
    baseCss,
    "",
    "/* ── Themes (token bindings + scoped overrides) ── */",
    themesCss(),
  ].join("\n");
}

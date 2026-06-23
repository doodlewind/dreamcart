/** Client entry shared by every /docs/<slug>/ page. The per-page HTML injects the
 *  rendered data as window.__DOCS_DATA__ (a DocsPageData JSON blob); this reads it
 *  and renders the docs shell. One bundle, N static pages. */
import { createRoot } from "react-dom/client";
import { DocsPage, type DocsPageData } from "../pages/DocsPage";

declare global {
  interface Window {
    __DOCS_DATA__?: DocsPageData;
  }
}

const root = document.getElementById("root");
const data = window.__DOCS_DATA__;
if (root && data) createRoot(root).render(<DocsPage data={data} />);

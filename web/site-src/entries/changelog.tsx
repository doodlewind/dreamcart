/** Client entry for "/changelog/". The HTML injects window.__CHANGELOG_DATA__
 *  (a ChangelogPageData JSON blob); this reads it and renders the changelog. */
import { createRoot } from "react-dom/client";
import { ChangelogPage, type ChangelogPageData } from "../pages/ChangelogPage";

declare global {
  interface Window {
    __CHANGELOG_DATA__?: ChangelogPageData;
  }
}

const root = document.getElementById("root");
const data = window.__CHANGELOG_DATA__;
if (root && data) createRoot(root).render(<ChangelogPage data={data} />);

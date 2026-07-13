/** Client entry for "/play/" — mounts PlayPage. engine.js + games.generated.js are
 *  loaded as plain <script> tags in the HTML template BEFORE this bundle, so
 *  window.DreamCart and window.GAMES exist by the time PlayPage mounts. */
import { createRoot } from "react-dom/client";
import { PlayPage } from "../pages/PlayPage";

const root = document.getElementById("root");
if (root) createRoot(root).render(<PlayPage />);

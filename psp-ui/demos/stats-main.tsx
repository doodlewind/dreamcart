// demos/stats-main.tsx — mounting entry for the dashboard demo (hero-main.tsx
// host contract: globalThis.ui + globalThis.__dcpak set by the host BEFORE
// eval, ops passed to render() explicitly, ui:img.* uploaded before mounting —
// this demo ships no images, the loop keeps the entry shape identical).
//
// Extra wiring unique to this demo: render() installs globalThis.frame; we
// wrap it so statsFrame(buttons) runs first each frame — it edge-detects
// UP/DOWN for the tab switch and steps the capped count-up frame signal —
// then the engine handler does its usual input/focus/sweep pass.

import Stats, { statsFrame } from "./stats.tsx";
import { dcpakEntries, dcpakGet, registerTexture, render } from "../src/index.ts";
import type { HostOps } from "../src/host.ts";
import { STYLE_IDS } from "../src/styles.generated.ts";

const ui = (globalThis as { ui?: HostOps }).ui;
if (!ui) {
  throw new Error("stats-main: host must set globalThis.ui (HostOps) before eval");
}

// Skipped on the PSP native host (__textures): dcpak.rs uploaded at boot.
const IMG_PREFIX = "ui:img.";
if (!(ui as { __textures?: unknown }).__textures) {
  for (const key of dcpakEntries(IMG_PREFIX)) {
    const blob = dcpakGet(key);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const w = dv.getUint16(0, true);
    const h = dv.getUint16(2, true);
    const psm = blob[4];
    const handle = ui.uploadTexture(blob.subarray(8), w, h, psm);
    if (handle >= 0) registerTexture(key.slice(IMG_PREFIX.length), handle);
  }
}

render(() => <Stats />, { ops: ui, styles: STYLE_IDS });

// Wrap the engine frame handler AFTER render() installed it.
const g = globalThis as { frame?: (buttons: number) => void };
const engineFrame = g.frame;
if (typeof engineFrame !== "function") {
  throw new Error("stats-main: render() did not install globalThis.frame");
}
g.frame = (buttons: number) => {
  statsFrame(buttons); // demo input (tabs) + capped count-up step
  engineFrame(buttons); // engine input/focus/onPress + renderer sweep
};

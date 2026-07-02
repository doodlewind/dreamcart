// demos/cards-main.tsx — mounting entry for the card-carousel demo (the exact
// hero-main.tsx host contract): globalThis.ui + globalThis.__dcpak are set by
// the host BEFORE eval; we pass ops to render() explicitly (strict mode) and
// upload any ui:img.* entries before mounting (this demo ships none — the
// loop keeps the entry shape identical across demos).

import Cards from "./cards.tsx";
import { dcpakEntries, dcpakGet, registerTexture, render } from "../src/index.ts";
import type { HostOps } from "../src/host.ts";
import { STYLE_IDS } from "../src/styles.generated.ts";

const ui = (globalThis as { ui?: HostOps }).ui;
if (!ui) {
  throw new Error("cards-main: host must set globalThis.ui (HostOps) before eval");
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

render(() => <Cards />, { ops: ui, styles: STYLE_IDS });

// demos/hero-main.tsx — mounting entry for the hero demo. demos/hero.tsx only
// exports the component; this entry mounts it, so `bun scripts/build.ts
// demos/hero-main.tsx` yields the bundle the web host (host-web/engine.js)
// and the golden harness (test/golden.ts) actually run.
//
// Host contract (both hosts follow it):
//   - globalThis.ui       = a HostOps (wasm-ops.js) — set BEFORE eval
//   - globalThis.__dcpak  = dist/hero-main.dcpak bytes — set BEFORE eval
// We pass those ops to render() EXPLICITLY. On web/test hosts that means an
// injected host → strict mode + render() feeds ui:styles / ui:font.* from the
// pack through loadStyles/loadFontAtlas. On PSP, detectHost recognizes the
// native namespace (ui.__textures, set only by ffi.rs) and keeps the psp/
// non-strict contract — the native dcpak walker already fed everything.
// Images are not auto-uploaded by the runtime on injected hosts (host.ts
// docs), so this entry uploads every ui:img.* entry and registers its texture
// handle under the bare image name before mounting.

import Hero from "./hero.tsx";
import { dcpakEntries, dcpakGet, registerTexture, render } from "../src/index.ts";
import type { HostOps } from "../src/host.ts";
import { STYLE_IDS } from "../src/styles.generated.ts";

const ui = (globalThis as { ui?: HostOps }).ui;
if (!ui) {
  throw new Error("hero-main: host must set globalThis.ui (HostOps) before eval");
}

// Upload dcpak images BEFORE mounting — <image src="logo.png"> resolves its
// texture handle at mount time. IMG entry layout: compiler/dcpak.ts header.
// Skipped on the PSP native host (__textures set by ffi.rs): dcpak.rs already
// uploaded every image at boot; render()'s PSP branch binds those handles.
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

render(() => <Hero />, { ops: ui, styles: STYLE_IDS });

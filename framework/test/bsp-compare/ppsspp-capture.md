# Capturing a PSP frame for the WebGL↔PPSSPP textured gate

The `bsp-compare` scene is a **static** pose (no input, no animation), so the PSP frame is
reproducible — any settled post-boot frame is the identical frame and is directly
comparable to the 480×272 WebGL ground truth. This is the **host gate** that closes the
ground-truth loop: it diffs what the PSP engine *actually* renders against the WebGL
reference.

## Automated (default): headless capture

```sh
bun run bsp-loop box        # ground truth (oracle + WebGL) + PSP capture + host gate
```

This is fully headless and deterministic — no GUI window, no screenshot hotkey, no
Accessibility permission. `framework/test/bsp-compare/ppsspp-shoot.ts` does it:

1. Builds the compare EBOOT **with the `capture` cargo feature**
   (`PSPJS_GAME=bsp-compare.js bun runtime/build.ts --features capture`). That feature adds
   one call per presented frame in `runtime/src/main.rs`:
   `sceIoDevctl("emulator:", 0x20 /* EMIT_SCREENSHOT */, …)`. It is a no-op on real
   hardware and the GUI emulator; only **PPSSPPHeadless** consumes it.
2. Runs `PPSSPPHeadless --graphics=software --screenshot=<blank> --max-mse=0 --timeout=12`.
   The software renderer is the hardware-closest path (nearest filtering, locked 1×,
   no upscale/MSAA). Each emitted frame is compared to the blank expected; `--max-mse=0`
   makes every emit "fail", so PPSSPP dumps the **actual** framebuffer to `__testfailure.bmp`
   in CWD (persists across the run even though the static game never exits).
3. Decodes that bitmap: PPSSPP writes a minimal 54-byte BMP header (which ImageMagick
   rejects) + raw **512-stride BGRA** pixels, **bottom-up**, no alpha. ppsspp-shoot strips
   the header and `magick`-converts `-alpha off -flip`, cropping the 512 stride to the
   visible 480 → `box.ppsspp.png`.
4. Runs the textured gate: `diff.ts box.webgl.png box.ppsspp.png --out box.host`
   (IoU≥0.995 & meanRGB≤8). On `box` this passes at **meanRGB ≈ 1.2** (the residual is
   16-bit color + dithering).

Read `box.host.score.json` (IoU + meanRGB) and `box.host.sidebyside.png`
(WebGL | PSP | heatmap; RED = structural error, GREEN→YELLOW = texture/shading delta).

### Building PPSSPPHeadless (one-time, ~10 min)

The macOS PPSSPP **GUI** has no `--screenshot` CLI, but `PPSSPPHeadless` (built from
source) does deterministic software-rendered capture:

```sh
brew install cmake sdl3 sdl3_ttf sdl3_image
git clone --recurse-submodules --shallow-submodules https://github.com/hrydgard/ppsspp.git ~/ppsspp-src
cmake -S ~/ppsspp-src -B ~/ppsspp-src/build -DCMAKE_BUILD_TYPE=Release -DHEADLESS=ON -DUSING_QT_UI=OFF
cmake --build ~/ppsspp-src/build -j"$(sysctl -n hw.ncpu)" --target PPSSPPHeadless
```

ppsspp-shoot looks for the binary at `~/ppsspp-src/build/PPSSPPHeadless` (override with
`PPSSPP_HEADLESS=…`). With it present, `CAPTURE_BACKEND` defaults to `headless`.

## Fallback: GUI screenshot (semi-automatic)

If you can't build headless, `CAPTURE_BACKEND=gui bun framework/test/bsp-compare/ppsspp-shoot.ts`
launches the installed `PPSSPPSDL.app` (software 1× via `capture.ini`), settles, and
triggers the internal F12 screenshot via `osascript`. This needs **Accessibility
permission** for your terminal (System Settings → Privacy & Security → Accessibility) and
is wall-clock-timed, so prefer headless.

## Other (copyrighted) maps

Bake locally (`bun run bsp <map> --bake-only`), import+register the module in
`bsp-compare.js`'s `MAPS`, then re-run — but never commit the map, its module, or the
captured frames (all gitignored). Only the committed CC0 `box` is the standard.

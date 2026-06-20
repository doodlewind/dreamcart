# Capturing a PPSSPP frame for the WebGL↔PPSSPP textured gate

The `bsp-compare` scene is a **static** pose (no input, no animation), so the PPSSPP
frame is reproducible — any capture after boot shows the identical frame and is
directly comparable to the 480×272 WebGL ground truth.

This step is **manual** (the macOS PPSSPP build is GUI-only — no headless/`--screenshot`
CLI, verified). The committed CI gate is the deterministic `bsp-compare` render golden
in `framework/test/golden.ts`; this textured host comparison is a local diagnostic.

## Steps

1. Build the compare EBOOT (default map = the committed CC0 `box`):
   ```sh
   PSPJS_GAME=bsp-compare.js bun runtime/build.ts
   ```
2. Launch + let it boot (~15–20 s for the small box bundle):
   ```sh
   open -a PPSSPPSDL "$PWD/runtime/target/mipsel-sony-psp/debug/EBOOT.PBP"
   ```
3. Capture a clean 480×272 framebuffer. Two options:
   - **Internal screenshot** (cleanest): in PPSSPP set `ScreenshotMode = 1` +
     `ScreenshotsAsPNG = True` (Graphics settings or `~/.config/ppsspp/PSP/SYSTEM/ppsspp.ini`
     while it's not running), bind a Screenshot hotkey under Settings → Controls if none
     exists, press it; the PNG lands in `~/.config/ppsspp/PSP/SCREENSHOT/`.
   - **Window grab** (fallback): `screencapture` the PPSSPP window and crop to the
     framebuffer rect (retina-scale aware). Less precise — use only for a visual check.
   Save the result as `framework/test/bsp-compare/<map>.ppsspp.png`.
4. Run the textured gate (after `bun framework/test/bsp-compare/run.ts` produced the WebGL frame):
   ```sh
   bun framework/test/bsp-compare/diff.ts \
     framework/test/bsp-compare/box.webgl.png \
     framework/test/bsp-compare/box.ppsspp.png \
     --out framework/test/bsp-compare/box.host
   ```
   Read `box.host.score.json` (IoU + meanRGB) and `box.host.heatmap.png` (RED = a face
   present on one host only = structural error; GREEN/YELLOW = texture/shading delta).

Real (copyrighted) maps: bake them locally (`bun run bsp <map> --bake-only`), point
`bsp-compare.js` at the module, and repeat — but never commit the map, its module, or
the captured frames (all gitignored).

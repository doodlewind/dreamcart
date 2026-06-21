# Platforms & builds

DreamCart is **isomorphic**: a single game `.js` runs unchanged on four very
different machines. Each target is a thin *host* that implements the same tiny
native contract — `gfx.clear`, `gfx.fillRect`, `log`, and a `frame(buttons)`
callback driven ~60 times a second with a fixed controller bitmask — plus the
optional `g3d` 3D contract. The game never knows which host it is running on.

| Platform | Host language | Runtime | 2D / 3D backend | Status |
|----------|---------------|---------|-----------------|--------|
| PSP | Rust (`rust-psp`) | QuickJS | sceGu / sceGu + sceGum | Runs (PPSSPP + hardware/Vita) |
| Web | TypeScript / JS | Browser JS engine | Canvas2D / WebGL2 | Runs (the [Playground](/play/)) |
| 3DS | C (`libctru`) | QuickJS | citro2d / citro3d | Runs (Azahar + hardware) |
| Android (dual-screen) | Kotlin + WebView | Browser JS engine | Canvas2D / WebGL2 | Runs (3DS-style handheld) |

The logical screen is always **480×272** (the PSP panel). Hosts that render to a
different physical resolution uniform-scale and letterbox that fixed canvas, so
layout and input mapping stay identical everywhere. For the contract itself see
[Runtime contract](/docs/runtime-contract/); for the cross-host 3D wire format
see [3D](/docs/3d/).

## One command to run any target

`bun run play <web|psp|3ds> [game]` builds the chosen game for that target and
launches the matching emulator:

```sh
bun run play web              # open the Playground (pick a game from the dropdown)
bun run play web maze         # Playground, jump straight to a game
bun run play psp raw-tetris   # build EBOOT.PBP + launch PPSSPP
bun run play 3ds rpg          # build .3dsx + launch a 3DS emulator (Azahar/Citra)
```

Run `bun run play` with no args to print the game list. The sections below cover
each target's build directly, what it needs installed, and where the artifact
lands.

## PSP

The PSP host (`runtime/src/main.rs`) is a `no_std` Rust program built with
[`rust-psp`](https://github.com/overdrivenpotato/rust-psp). It owns the process:
it sets up the GU with a double-buffered 480×272 framebuffer, reads the
controller, embeds a QuickJS runtime/context, registers the native API, and runs
the per-vblank loop. Each frame Rust opens the GE display list (`sceGuStart`),
calls JS `frame(buttons)` — whose `gfx.*` / `g3d.*` calls enqueue GE commands —
then `sceGuFinish` / `sceGuSync` / `sceDisplayWaitVblankStart` / `sceGuSwapBuffers`.

A few PSP-specific facts worth knowing when targeting the 32 MB device:

- **QuickJS uses the Rust/PSP allocator.** It is created via `JS_NewRuntime2`
  (`runtime/src/qjs_alloc.rs`) because rust-psp's startup sets up no C heap, so
  newlib `malloc` is unusable. A segregated **O(1) arena allocator**
  (`runtime/src/arena.rs`) sits underneath; it fixed kernel-object exhaustion
  and the per-frame allocation bottleneck on real hardware (see
  [the PSP performance guide](/docs/3d/)).
- **2D is `sceGuClear` + textured/flat quads; 3D is `sceGu` + `sceGum`.** The
  3D path (`runtime/src/gfx3d.rs`) implements the frozen `g3d` contract: meshes
  upload once behind small-int handles, and one little-endian command buffer
  crosses the FFI per frame. The big perf unlock is the **retained native scene**
  (cull + draw in Rust rather than per-node QuickJS) — read more under
  [3D](/docs/3d/).
- **VFPU + deep recursion** need the right thread flags; `sceGum*` emits VFPU
  instructions and QuickJS compiling the framework bundles recurses fairly deep,
  both handled in `main.rs`.

### Build a single EBOOT

```sh
PSPJS_GAME=raw-tetris.js bun run psp     # builds runtime/target/.../EBOOT.PBP
```

`bun runtime/build.ts` wires the cross-compile toolchain (LLVM for MIPS,
`cargo psp`, the pinned `nightly-2026-05-28` Rust toolchain, and the PSPSDK in
`mipsel-sony-psp/`). Apple's `ar`/`clang` cannot target MIPS, so the build forces
`llvm-ar`/`llvm-ranlib` and a `clang` cross target; getting that wrong shows up as
`undefined symbol: JS_*`. The benign "linking abicalls code with non-abicalls
code" warning flood (prebuilt newlib is `+abicalls`, rust-psp is `+noabicalls`)
is suppressed by default; set `PSPJS_SHOW_LINKER_MESSAGES=1` to see raw linker
output.

Open the result in [PPSSPP](https://www.ppsspp.org/):

```sh
open -a PPSSPPSDL --args runtime/target/mipsel-sony-psp/debug/EBOOT.PBP
```

### Build every game for a memory stick

```sh
bun run psp:all          # -> dist/psp/PSP/GAME/<game>/EBOOT.PBP
```

Copy `dist/psp/PSP` to the root of the memory stick; each game appears as its own
homebrew entry, packed with a generated menu title, `ICON0.PNG`, and `PIC1.PNG`
preview derived from the game's `// @title` header. For real PSP/Vita startup
debugging there is a trace EBOOT:

```sh
bun run psp:trace        # -> dist/psp-trace/PSP/GAME/dreamcart-raw-snake-trace/EBOOT.PBP
```

On PS Vita (Adrenaline) the final path is
`ux0:pspemu/PSP/GAME/dreamcart-raw-snake-trace/EBOOT.PBP`.

## Web

The Web host (`web/engine.js`) is a plain vanilla global — no framework, no
bundler at runtime — that implements the identical `gfx` / input / `frame`
contract on a Canvas, with WebGL2 backing the optional `g3d` 3D path. It exposes
`window.PSPJS`:

```js
window.PSPJS = {
  W: 480, H: 272,
  BTN: { SELECT: 0x01, START: 0x08, UP: 0x10, RIGHT: 0x20, DOWN: 0x40, LEFT: 0x80,
         LTRIGGER: 0x100, RTRIGGER: 0x200, TRIANGLE: 0x1000, CIRCLE: 0x2000,
         CROSS: 0x4000, SQUARE: 0x8000 },
  mount(canvasEl), load(jsString, dcpakBase64?), start(), stop(),
  setPaused(bool), step(), pressVirtual(bit, bool), getButtons(),
  onLog(cb), onFps(cb), isPaused()
};
```

The game list is generated into `window.GAMES` (`web/build-games.ts`), keyed by
file name, carrying each game's title, on-screen controls, source, and baked
`.dcpak` (see [Assets & .dcpak](/docs/assets/)). The [Playground](/play/) loads
`engine.js` + `games.generated.js` as plain `<script>` tags and drives them.

### Local development

```sh
bun run serve        # Bun.serve dev server -> http://localhost:8123
```

`web/serve.ts` regenerates the game manifest on startup; open the page (append
`?game=rpg.js` to jump to one). Because the Web engine speaks the same contract,
every game file runs in the browser exactly as it does on the PSP.

### Build the static site

```sh
bun run site         # -> web/site/  (Home, /play/, /docs/, /changelog/)
```

`web/deploy-build.ts` bakes the games, builds the React site, renders the docs
and changelog markdown, and copies `engine.js` + `games.generated.js` into
`web/site/play/`. `bun run deploy` then ships `web/site/` to Cloudflare Pages.

## 3DS

The 3DS host (`runtime-3ds/source/main.c`) is a C app built on
[`libctru`](https://github.com/devkitPro/libctru). It embeds QuickJS and runs the
exact same game `.js`, rendering 2D via **citro2d** and 3D via **citro3d**. The
480×272 logical screen is uniform-scaled to fit the **400×240** top screen and
vertically centered; logs go to the bottom screen.

The 3D path implements the same `g3d` wire contract as PSP and the software
reference renderer — `OP_*` / `FMT_*` / `DC3D_MAGIC` constants are kept
byte-for-byte identical and asserted in `framework/test/contract.ts`. Meshes are
copied into persistent `linearAlloc` buffers on upload (the GPU DMAs from linear,
cache-coherent memory).

### Build a .3dsx

The build runs the `devkitpro/devkitarm` toolchain inside Docker, so no host
toolchain or sudo is needed — just Docker (e.g. OrbStack or Docker Desktop):

```sh
PSPJS_GAME=raw-tetris.js bun run 3ds   # -> runtime-3ds/dreamcart-3ds.3dsx
```

Run the `.3dsx` in [Azahar](https://azahar-emu.org/) (the maintained Citra fork)
or on real hardware.

## Android (dual-screen)

The Android target (`android/`) turns a **dual-screen Android handheld**
(3DS-style: two physical internal displays, not a folding phone) into a DreamCart
console. It reuses the **exact** Web engine — there is no separate Android game
runtime:

- **Top screen** runs the games in a hardware-accelerated full-screen `WebView`
  loading `web/engine.js` + `games.generated.js`, including the WebGL2 3D path.
  Same contract as every other target.
- **Bottom screen** is a native Android `Presentation` showing the game library
  (tap a title to switch). It is non-focusable so it never steals the physical
  keys.
- **Input** is the device's physical D-pad / ABXY buttons, intercepted in
  `MainActivity` and funneled through `Runtime.press(bit, down)` using the
  canonical DreamCart bitmask — identical to `web/engine.js` `BTN` and
  `framework/src/input.ts`. L1/R1 flip through the library (the contract has no
  L/R, so games never read them).

A Kotlin `Runtime` singleton marshals JS⇄native on the main loop, and a
`WebBridge` (`@JavascriptInterface`) reports the library / current game / logs
back from the WebView. Verified end-to-end on an AYN Thor.

### Build & install

```sh
bun run android            # sync engine + games into assets, then assembleDebug
bun run android:install    # gradle installDebug + launch the activity
```

`bun android/sync-assets.ts` copies `engine.js` and builds `games.generated.js`
into the app's assets, reusing whatever games are in `runtime/src/game/`. Run
`bun run bake && bun framework/build.ts` first to include the framework games
(raw games need no build step). The resulting APK lands at
`android/app/build/outputs/apk/debug/app-debug.apk`.

## Shared toolchain

Everything is driven by [Bun](https://bun.sh) — there is no Python or Make glue.
A single bootstrap installs every cross-toolchain (LLVM, PPSSPP, Azahar, the
pinned Rust nightly + `cargo-psp`, the PSPSDK, and the devkitARM Docker image):

```sh
bun install
bun run bootstrap        # idempotent; reports anything it can't auto-install
```

The same game bundle runs on every target, so the headless golden + contract
tests (`bun run test`) catch crashes and visual regressions in shared code once
and protect all four platforms at the same time. See
[Getting started](/docs/getting-started/) for the full project layout.

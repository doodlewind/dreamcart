# Getting Started

DreamCart is an isomorphic JavaScript game runtime: the *same* game `.js` file runs
unchanged on Sony PSP, the Web, Nintendo 3DS, and a dual-screen Android handheld.
This page takes you from a fresh clone to a running game, explains the repository
layout, and shows how to add a game of your own.

Everything runs on [Bun](https://bun.sh) — there is no Python or Make glue. The PSP
and 3DS targets need extra native toolchains (handled by `bun run bootstrap`), but
the Web target needs nothing beyond Bun.

## Prerequisites

- **[Bun](https://bun.sh)** — the only requirement for the Web playground.
- **[PPSSPP](https://www.ppsspp.org/)** (`brew install --cask ppsspp`) — to run the PSP build.
- **A 3DS emulator** such as [Azahar](https://azahar-emu.org/) in `/Applications` — to run the 3DS build.
- **Docker** (e.g. [OrbStack](https://orbstack.dev)) — only needed to *build* the 3DS `.3dsx` (uses the `devkitpro/devkitarm` image; no host toolchain install).

The PSP and 3DS toolchains are optional. If you only want to write games and run
them in the browser, you can stop after `bun install`.

## Install

```sh
git clone https://github.com/doodlewind/dreamcart.git
cd dreamcart
bun install
```

To target real hardware/emulators (PSP + 3DS), run the one-shot, idempotent
bootstrap, which installs and pins everything else — git submodules, LLVM (Apple
clang can't target MIPS), PPSSPP, Azahar, the pinned Rust nightly + `rust-src`,
`cargo-psp` and friends, the PSPSDK, and the devkitARM Docker image:

```sh
bun run bootstrap
```

`bun run bootstrap` reports anything it can't auto-install (Homebrew or Docker
missing, Docker daemon stopped); fix those and re-run. For the Web playground you
can skip it entirely. PSP dependencies are pinned in `toolchains/psp.json` and
installed under `${XDG_CACHE_HOME:-$HOME/.cache}/pocket-stack`, shared with
PocketJS. Set `PSP_SDK` (or the compatible `PSPDEV` alias) only to deliberately
override that cache.

## Run a game

The fastest path is the one-command launcher. It builds the chosen game for the
chosen platform and launches the matching emulator:

```sh
bun run play web              # open the playground (pick a game from the list)
bun run play web maze         # playground, jump straight to a game
bun run play psp raw-tetris   # build EBOOT.PBP + launch PPSSPP
bun run play 3ds rpg          # build .3dsx + launch a 3DS emulator
```

Run `bun run play` with no arguments to print usage and the full game list. For
`web` the game argument is optional — the playground has a dropdown. For `psp` and
`3ds` the launcher first rebuilds the framework game bundles so they are current.

### Web only

For an iterative web loop, start the dev server directly. It regenerates the game
manifest on startup and serves the playground (edit + run, switch games, view
source, on-screen + keyboard controls):

```sh
bun run serve        # -> http://localhost:8123  (PORT=3000 to change)
```

Open <http://localhost:8123/> (or `?game=rpg.js` to jump to a game). The browser
host ([`web/engine.js`](https://github.com/doodlewind/dreamcart/blob/main/web/engine.js))
implements the identical `gfx` / input / `frame` contract on Canvas, so the same
game files that ship to PSP run in the browser.

### PSP only

You can also build the EBOOT for a single game directly. `PSPJS_GAME` selects which
game is embedded:

```sh
PSPJS_GAME=raw-tetris.js bun run psp     # builds runtime/.../EBOOT.PBP
bun run psp:all                          # build every game into a PSP memory-stick layout
```

`bun run psp:all` writes `dist/psp/PSP/GAME/<game>/EBOOT.PBP` — copy `dist/psp/PSP`
to the root of a memory stick and each game appears as its own homebrew entry. Open
a single EBOOT in PPSSPP with:

```sh
open -a PPSSPPSDL --args runtime/target/mipsel-sony-psp/debug/EBOOT.PBP
```

### 3DS only

The 3DS build produces a `.3dsx` via the devkitARM Docker image (no host toolchain
or sudo needed):

```sh
PSPJS_GAME=raw-tetris.js bun run 3ds     # -> runtime-3ds/dreamcart-3ds.3dsx
```

Run the `.3dsx` in Azahar or on real hardware. See
[Platforms & builds](/docs/platforms/) for the full per-target story.

## Build & test

`bun run build` runs the full pipeline — bake assets, type-check, bundle each
game, then regenerate the web manifest:

```sh
bun run build          # bake -> typecheck -> bundle -> web manifest
bun run test           # contract + golden + smoke tests
```

The bundler (`framework/build.ts`, via `Bun.build`) inlines the framework into
each `framework/games/*.js` and writes the result to `runtime/src/game/<name>.js`,
so the PSP / Web / 3DS steps embed framework games exactly like the raw demos.

The test suite includes **golden tests**: each framework game is rendered
*headlessly under Bun* (a `gfx` mock → RGBA framebuffer) through a deterministic
seeded sequence with scripted input, then byte-compared to a committed golden PNG.
Because the same bundle runs on every platform, this catches crashes and visual
regressions in the shared code. Regenerate goldens with
`UPDATE=1 bun framework/test/golden.ts`.

## Project layout

```text
dreamcart/
├─ runtime/          PSP host: Rust (rust-psp) + QuickJS (runtime/src/main.rs)
│  └─ src/game/      raw-*.js demos + bundled framework games (build output)
├─ runtime-3ds/      3DS host: C (libctru/citro2d) + QuickJS (source/main.c)
├─ framework/        the isomorphic SDK (TypeScript) + games (JavaScript)
│  ├─ src/           Scene/Input/Rng/Graphics/TileMap/g3d/scene3d/… modules
│  ├─ games/         framework games authored in plain JS (snake.js, rpg.js, …)
│  ├─ bake/          asset bakers (font, sprites, glTF, scene, BSP)
│  └─ test/          golden + contract + smoke tests
├─ web/              browser host (engine.js) + playground + the dreamcart.games site
├─ android/          dual-screen Android handheld (WebView over the web engine)
├─ quickjs-rs/       QuickJS FFI (submodule fork; PSP shims)
├─ rust-psp/         rust-psp + cargo-psp toolchain (submodule fork)
└─ docs/             design docs (3D, .dcpak, BSP import, PSP performance)
```

There are two kinds of games, distinguished by naming convention:

- **`raw-*` — raw low-level demos** in `runtime/src/game/`. Each is a single,
  self-contained `.js` file that uses only the bare native contract. They exist to
  exercise the low-level API directly, with no framework.
- **Unprefixed — framework games** in `framework/games/`. Authored against the
  framework SDK and bundled (framework inlined) into the same runtime.

See [Runtime contract](/docs/runtime-contract/) for the native contract that both
kinds sit on, and [Framework SDK](/docs/framework/) for the higher-level API.

## How to add a game

### A raw game

A raw game is one `.js` file that uses only the host globals `gfx.clear`,
`gfx.fillRect`, `log`, and a `frame(buttons)` function the host calls once per
vblank (~60 Hz). You never run your own loop — pacing is the host's job. `buttons`
is the PSP controller bitmask (`UP=0x10`, `RIGHT=0x20`, `DOWN=0x40`, `LEFT=0x80`,
`CROSS=0x4000`, `START=0x08`, …).

Drop a file in `runtime/src/game/`, e.g. `runtime/src/game/raw-blink.js`:

```js
// @title Blink (raw API)
// @order 99
// @controls CROSS to flash
// The Rust host calls frame(buttons) once per vblank (~60 Hz).
var BTN_CROSS = 0x4000;

function frame(buttons) {
  var on = (buttons & BTN_CROSS) !== 0;
  gfx.clear(0, 0, 0);
  if (on) gfx.fillRect(200, 116, 80, 40, 0, 255, 120);
  log('cross=' + on);
}
```

The header comments are the single source of truth for the menu: `// @title`,
`// @order`, and `// @controls`. Adding the file is all that's needed — no build
script edit. Run it with `bun run play web raw-blink` or
`PSPJS_GAME=raw-blink.js bun run psp`.

### A framework game

A framework game is plain JavaScript that imports the SDK from `../src/index` and
calls `start()` with a root `Scene`. Games stay JS (the project's firm boundary is
that game logic is JS), but get full editor/CI type-checking via `// @ts-check` +
JSDoc types imported from the SDK.

Create `framework/games/blink.js`:

```js
// @ts-check
// @title Blink
// @order 99
// @controls CROSS to flash
import { start, Scene, Btn, Colors, rgb, SCREEN_W, SCREEN_H } from '../src/index';

/** @import { UpdateContext, Graphics } from '../src/index' */

class RootScene extends Scene {
  on = false;

  /** @param {UpdateContext} ctx */
  update(ctx) {
    // edge-detecting input: pressed() is true only on the down transition
    if (ctx.input.pressed(Btn.Cross)) this.on = !this.on;
  }

  /** @param {Graphics} g */
  draw(g) {
    g.clear(rgb(0, 0, 0));
    if (this.on) g.rect(SCREEN_W / 2 - 40, SCREEN_H / 2 - 20, 80, 40, Colors.green);
    g.textCentered('PRESS CROSS', SCREEN_W / 2, 16, Colors.white, 2);
  }
}

start(() => new RootScene(), { seed: 1337 });
```

Key SDK pieces, all from `../src/index`:

- **`start(() => new Scene, opts)`** — entry point; `opts.seed` seeds the
  deterministic `Rng`.
- **`Scene` / `Node`** — the scene tree; override `onEnter(ctx)`, `update(ctx)` and
  `draw(g)`.
- **`UpdateContext` (`ctx`)** — `input`, `rng`, `dt` (1/60), `t`, `frame`, `engine`.
- **`Input`** (`ctx.input`) — edge-detecting: `held(btn)`, `pressed(btn)`,
  `released(btn)`, `dir()` (d-pad vector), `axis()` (analog, falling back to d-pad).
- **`Btn`** — the canonical button bitmask (`Btn.Cross`, `Btn.Start`, `Btn.Up`, …),
  identical on every platform.
- **`Graphics`** (`g`) — `clear`, `rect`, `rectOutline`, `sprite`, `text`,
  `textCentered`; plus `Colors`, `rgb()`, `SCREEN_W` (480), `SCREEN_H` (272), and
  the baked 8×8 `SPRITES`.

Then bundle and run:

```sh
bun run build                 # bundles framework/games/blink.js -> runtime/src/game/blink.js
bun run play web blink        # try it in the playground
bun run play psp blink        # build EBOOT + launch PPSSPP
```

For 3D games, import the 3D modules (`g3d`, `Scene3D`, `mesh`, `material`,
`light`, `skin`, `math`) from the barrel `../src/index` as usual; only the 3D-only
subsystems — `CharController` from `../src/controller`, `ActionMap` from
`../src/action`, scene descriptions from `../src/scene-desc` — are imported directly,
because they are deliberately not re-exported from `index` so 2D games don't pull them
into their bundle. See [3D](/docs/3d/) for the g3d contract and
[Assets & .dcpak](/docs/assets/) for baking meshes, sprites, and fonts.

## Next steps

- [Overview & architecture](/docs/) — the isomorphic model and the contract layers.
- [Runtime contract](/docs/runtime-contract/) — the tiny native contract in full.
- [Framework SDK](/docs/framework/) — Scene/Node, Input, Rng, Graphics, TileMap, DialogueBox.
- [3D](/docs/3d/) — the g3d contract, Scene3D, the native scene offload, glTF skinning.
- [Platforms & builds](/docs/platforms/) — PSP, Web, 3DS, and Android targets.

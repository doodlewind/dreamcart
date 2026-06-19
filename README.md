# DreamCart
An **isomorphic** JavaScript game runtime — the *same* game `.js` runs unchanged on
Sony **PSP**, the **Web**, and Nintendo **3DS**, powered by [QuickJS](https://bellard.org/quickjs/)
(plus [rust-psp](https://github.com/overdrivenpotato/rust-psp) on PSP and
[libctru/citro2d](https://github.com/devkitPro/libctru) on 3DS).

Each platform implements the same tiny native contract — `gfx.clear(r,g,b)`,
`gfx.fillRect(x,y,w,h,r,g,b)`, `log(msg)`, and a `frame(buttons)` function called
once per frame with a fixed controller bitmask — so games in
[`runtime/src/game/`](runtime/src/game/) are written once and run everywhere.
An **optional** `g3d` contract adds 3D the same way: meshes uploaded once + one
batched draw-list per frame, with all scene/physics/math logic in shared JS and a
native engine per platform (see [`docs/3d-design.md`](docs/3d-design.md) and the
`cube3d`/`racing3d`/`fps3d` games).

| Platform | Host | Graphics (2D / 3D) | Status |
|----------|------|--------------------|--------|
| PSP | Rust (rust-psp) + QuickJS | sceGu / sceGu+sceGum | ✅ runs (PPSSPP) |
| Web | Canvas + RAF | Canvas2D / WebGL2 | ✅ runs ([Playground](web/index.html)) |
| 3DS | C (libctru) + QuickJS | citro2d / citro3d | ✅ runs (Azahar/hardware) |
| Android (dual-screen) | Kotlin + WebView (web engine) | Canvas2D / WebGL2 | ✅ runs (3DS-style handheld; top=game, bottom=native UI) — see [`android/`](android/) |

![Snake running on PPSSPP](docs/snake.png)

## Games
There are two kinds of games, by naming convention:

- **`raw-*` — raw low-level demos.** Each is a single self-contained `.js` file
  that uses only the bare native contract (`gfx.clear`, `gfx.fillRect`, `log`, and
  a `frame(buttons)` loop; numbers drawn with a tiny rectangle pixel-font). They
  exist to exercise the low-level API directly, with no framework.
- **Unprefixed — framework games.** Authored against the framework (see
  [Framework](#framework-typescript-sdk-javascript-games) below) and bundled into
  the same runtime.

The raw low-level demos live in [`runtime/src/game/`](runtime/src/game/):

| Game | File | Controls |
|------|------|----------|
| Snake (default) | `raw-snake.js` | D-pad steer; walls wrap; START restart |
| Pong | `raw-pong.js` | UP/DOWN move paddle (vs AI) |
| 2048 | `raw-g2048.js` | D-pad slide; START restart |
| Breakout | `raw-breakout.js` | LEFT/RIGHT paddle, CROSS launch |
| Tetris | `raw-tetris.js` | LEFT/RIGHT move, DOWN soft-drop, CROSS/UP rotate, START restart |
| Platformer | `raw-platformer.js` | LEFT/RIGHT run, CROSS jump, START restart |

Select which one to embed at build time with `PSPJS_GAME`:

``` sh
PSPJS_GAME=raw-tetris.js bun run psp     # builds EBOOT.PBP for Tetris
```

Build every raw and framework game into a PSP memory-stick layout:

``` sh
bun run psp:all
# -> dist/psp/PSP/GAME/<game>/EBOOT.PBP
```

Copy `dist/psp/PSP` to the root of the PSP memory stick; each game appears as a
separate homebrew entry under `PSP/GAME/<game>/`. The script also packs each
EBOOT with a generated PSP menu title, `ICON0.PNG`, and `PIC1.PNG` placeholder
preview based on the game's `// @title`.

For real PSP/Vita smoke testing, build a minimal diagnostic EBOOT:

``` sh
bun run psp:diag
# -> dist/psp-diag/PSP/GAME/dreamcart-diag/EBOOT.PBP
```

It first prints boot, memory, EDRAM, and controller state through the PSP debug
screen, then switches to a GU color-cycle loop. If a device hangs, the last
visible line identifies the failing phase. For the normal game path with
on-screen startup stages, build with `PSPJS_DIAG_MODE=trace bun run psp`.

## Play (one command)
`bun run play <web|psp|3ds> [game]` builds the chosen game and launches the
matching emulator:

``` sh
bun run play web              # open the playground (pick a game from the list)
bun run play web maze         # playground, jump straight to a game
bun run play psp raw-tetris   # build EBOOT + launch PPSSPP
bun run play 3ds rpg          # build .3dsx + launch a 3DS emulator (Azahar/Citra/…)
```

Run `bun run play` with no args to see the game list. For Web you don't need a
game arg — the playground has a dropdown. PSP needs PPSSPP
(`brew install --cask ppsspp`); 3DS needs a 3DS emulator in `/Applications`
(it prints the built `.3dsx` path + install hint if none is found).

## Framework (TypeScript SDK, JavaScript games)
The raw `gfx`/`frame` contract is deliberately tiny. On top of it lives a small,
**isomorphic** game framework ([`framework/`](framework/)) that runs the same on
**all three platforms**. The SDK ([`framework/src/`](framework/src)) is written in
**TypeScript**, but games themselves are authored in **plain JavaScript** — the
project's firm boundary is that game business logic is JS. Games still get full
editor/CI type-checking via `// @ts-check` + JSDoc types imported from the SDK
(see [`framework/games/tsconfig.json`](framework/games/tsconfig.json)). Each game
is bundled (framework inlined) per platform, so PSP/Web/3DS execute identical code.

It provides: a scene/entity tree (`Scene`/`Node` with `update`/`draw`), the game
loop, edge-detecting `Input`, a seeded deterministic `Rng`, `Graphics`
(`rect`/`sprite`/`text`), palette `Bitmap`s with a baked **8×8 ASCII font** and
sprites, a `TileMap` with camera, and a `DialogueBox`. Assets are *baked* to TS
data modules (`framework/bake/`).

Six framework games live in [`framework/games/`](framework/games/), including a
Jin-Yong-flavoured **wuxia story game** (`rpg.js`) — start in your room, walk out
the door, and roam the village talking to villagers and the elder:

![Wuxia village (framework RPG)](docs/village.png)

The browser **Playground** lets you switch all games (raw + framework) and view
their JavaScript source:

![Playground](docs/playground.png)

``` sh
bun install
bun run build          # bake assets -> typecheck -> bundle games -> web manifest
bun run test           # golden + smoke tests
```

`bun run build` bundles each `framework/games/*.js` (framework inlined, via
`Bun.build`) to `runtime/src/game/<name>.js`, so the PSP/Web/3DS build steps embed
them exactly like the raw demos (e.g. `PSPJS_GAME=rpg.js bun run psp`).

### Golden tests
`framework/test/golden.ts` renders each framework game's bundle **headlessly under
Bun** (a gfx mock → RGBA framebuffer), runs a deterministic seeded sequence with
scripted input, and byte-compares the framebuffer to a committed golden
(`framework/test/goldens/*.png`); it also runs a no-crash **smoke pass** over the
`raw-*` demos (seeded `Math.random`). A sibling
[`framework/test/contract.ts`](framework/test/contract.ts) asserts the controller
button bitmask is identical across the Web and 3DS hosts, the framework SDK, and
every raw demo's `BTN_*` constants (the raw games are eval'd as a string and so
can't `import` the canonical `Btn`, so the test enforces they never drift).
Because the same bundle runs on every platform, this catches crashes and visual
regressions in the shared code. Run with
`bun run test`; regenerate goldens with `UPDATE=1 bun framework/test/golden.ts`.

## Architecture
- **Rust host** (`runtime/src/main.rs`) owns the process: it sets up the GU
  (double-buffered 480x272), the controller, and a QuickJS runtime/context, then
  registers the native API and runs the per-frame loop (Rust opens the GE display
  list, calls JS `frame(buttons)`, then finishes/syncs/swaps).
- **2D graphics + input bridge** (`runtime/src/gfx.rs`, `runtime/src/bridge.rs`)
  exposes to JS:
  - `gfx.clear(r, g, b)`
  - `gfx.fillRect(x, y, w, h, r, g, b)`
  - `log(msg)`
  - `frame(buttons)` is defined by the game; `buttons` is the PSP controller bitmask
    (`UP=0x10`, `RIGHT=0x20`, `DOWN=0x40`, `LEFT=0x80`, `CROSS=0x4000`, `START=0x08`).
- **QuickJS allocator** (`runtime/src/qjs_alloc.rs`): QuickJS is created with
  `JS_NewRuntime2` so it allocates through the Rust/PSP allocator (rust-psp's
  startup sets up no C heap, so newlib `malloc` is unusable).
- **FFI bindings**: extended in `quickjs-rs/libquickjs-sys/src/lib.rs`.

## Setup (from a fresh clone, macOS)
Install [Bun](https://bun.sh) and [Homebrew](https://brew.sh) (and Docker, e.g.
[OrbStack](https://orbstack.dev), for the 3DS build), then one command sets up
**everything**:

``` sh
git clone https://github.com/doodlewind/dreamcart.git
cd dreamcart
bun install
bun run bootstrap
```

`bun run bootstrap` ([scripts/bootstrap.ts](scripts/bootstrap.ts)) is idempotent
and installs/configures:
- submodules (`bun run setup`)
- **LLVM** (`brew install llvm` — Apple clang can't target MIPS)
- **PPSSPP** (`brew install --cask ppsspp`) — PSP emulator
- **Azahar** (downloaded from GitHub releases) — 3DS emulator
- **Rust** `nightly-2026-05-28` + `rust-src`, and pins the repo override
- **cargo-psp / prxgen / pack-pbp / mksfo** (built from the `rust-psp` submodule)
- the **PSPSDK** (prebuilt newlib) into `mipsel-sony-psp/`
- the **`devkitpro/devkitarm`** Docker image (3DS toolchain)

It reports anything it can't auto-install (Homebrew/Docker not present, Docker
daemon stopped); fix those and re-run. Then everything runs on Bun — there's no
Python/Make glue.

> The `quickjs-rs` and `rust-psp` submodules point at `doodlewind/*` forks.
> Those forks carry DreamCart's PSP C/stdio shims, 32-bit `size_t` ABI/API
> exports, and PSP nightly/tooling compatibility fixes. LLVM `llvm-ar` is used
> for the static archive (Apple `ar` silently drops MIPS objects →
> `undefined symbol: JS_*`).

## Run on PSP
Open the EBOOT in [PPSSPP](https://www.ppsspp.org/):

``` sh
open -a PPSSPPSDL --args runtime/target/mipsel-sony-psp/debug/EBOOT.PBP
```

## Web (Playground)
Start the `Bun.serve` dev server and open the Playground (edit + run, switch
games, view source, on-screen + keyboard controls):

``` sh
bun run serve        # -> http://localhost:8123  (PORT=3000 to change)
```

Open <http://localhost:8123/> (or `?game=rpg.js` to pick one). The server
([`web/serve.ts`](web/serve.ts)) regenerates the game manifest on startup. Each
game's menu title, order and on-screen controls come from a header comment in
its own source (`// @title` / `// @order` / `// @controls`) — the single source
of truth, so adding a game needs no edit to the build script. The Playground
implements the identical `gfx`/`input`/`frame` contract on Canvas
([`web/engine.js`](web/engine.js)), so the same game files run in the browser.

## 3DS
Builds a `.3dsx` homebrew app using the `devkitpro/devkitarm` Docker image — no
host toolchain install or sudo needed (just Docker, e.g. OrbStack/Docker Desktop):

``` sh
PSPJS_GAME=raw-tetris.js bun run 3ds   # -> runtime-3ds/dreamcart-3ds.3dsx
```

Run the `.3dsx` in [Azahar](https://azahar-emu.org/) (the maintained Citra fork)
or on real hardware. The 3DS host ([`runtime-3ds/source/main.c`](runtime-3ds/source/main.c))
embeds QuickJS and renders the same games via citro2d (scaled to the 400×240 top
screen), with logs on the bottom screen.

## License
MIT

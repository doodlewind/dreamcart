# PSP.js
An **isomorphic** JavaScript game runtime — the *same* game `.js` runs unchanged on
Sony **PSP**, the **Web**, and Nintendo **3DS**, powered by [QuickJS](https://bellard.org/quickjs/)
(plus [rust-psp](https://github.com/overdrivenpotato/rust-psp) on PSP and
[libctru/citro2d](https://github.com/devkitPro/libctru) on 3DS).

Each platform implements the same tiny native contract — `gfx.clear(r,g,b)`,
`gfx.fillRect(x,y,w,h,r,g,b)`, `log(msg)`, and a `frame(buttons)` function called
once per frame with a fixed controller bitmask — so games in
[`runtime/src/game/`](runtime/src/game/) are written once and run everywhere.

| Platform | Host | Graphics | Status |
|----------|------|----------|--------|
| PSP | Rust (rust-psp) + QuickJS | sceGu | ✅ runs (PPSSPP) |
| Web | Canvas + RAF | Canvas2D | ✅ runs ([Playground](web/index.html)) |
| 3DS | C (libctru) + QuickJS | citro2d | ✅ builds `.3dsx` (Azahar/hardware) |

![Snake running on PPSSPP](docs/snake.png)

## Games
Each game is a single self-contained `.js` file using only `gfx.clear`,
`gfx.fillRect`, `log`, and a `frame(buttons)` loop (numbers are drawn with a tiny
rectangle pixel-font). Select which one to embed at build time with `PSPJS_GAME`:

| Game | File | Controls |
|------|------|----------|
| Snake (default) | `snake.js` | D-pad steer; walls wrap; START restart |
| Pong | `pong.js` | UP/DOWN move paddle (vs AI) |
| 2048 | `g2048.js` | D-pad slide; START restart |
| Breakout | `breakout.js` | LEFT/RIGHT paddle, CROSS launch |
| Tetris | `tetris.js` | LEFT/RIGHT move, DOWN soft-drop, CROSS/UP rotate, START restart |
| Platformer | `platformer.js` | LEFT/RIGHT run, CROSS jump, START restart |

``` sh
PSPJS_GAME=tetris.js bun run psp     # builds EBOOT.PBP for Tetris
```

## Play (one command)
`bun run play <web|psp|3ds> [game]` builds the chosen game and launches the
matching emulator:

``` sh
bun run play web              # open the playground (pick a game from the list)
bun run play web fw-maze      # playground, jump straight to a game
bun run play psp tetris       # build EBOOT + launch PPSSPP
bun run play 3ds fw-rpg       # build .3dsx + launch a 3DS emulator (Azahar/Citra/…)
```

Run `bun run play` with no args to see the game list. For Web you don't need a
game arg — the playground has a dropdown. PSP needs PPSSPP
(`brew install --cask ppsspp`); 3DS needs a 3DS emulator in `/Applications`
(it prints the built `.3dsx` path + install hint if none is found).

## Framework (TypeScript)
The raw `gfx`/`frame` contract is deliberately tiny. On top of it lives a small,
**isomorphic, TypeScript** game framework ([`framework/`](framework/)) that the
same way runs on **all three platforms** — it's plain JS compiled from TS and
bundled into each game, so PSP/Web/3DS all execute the identical code.

It provides: a scene/entity tree (`Scene`/`Node` with `update`/`draw`), the game
loop, edge-detecting `Input`, a seeded deterministic `Rng`, `Graphics`
(`rect`/`sprite`/`text`), palette `Bitmap`s with a baked **8×8 ASCII font** and
sprites, a `TileMap` with camera, and a `DialogueBox`. Assets are *baked* to TS
data modules (`framework/bake/`).

Five framework games live in [`framework/games/`](framework/games/), including a
Jin-Yong-flavoured **wuxia story game** — start in your room, walk out the door,
and roam the village talking to villagers and the elder:

![Wuxia village (framework RPG)](docs/village.png)

The browser **Playground** lets you switch all games (raw + framework) and view
their source (TypeScript for framework games):

![Playground](docs/playground.png)

``` sh
bun install
bun run build          # bake assets -> typecheck -> bundle games -> web manifest
bun run test           # golden tests
```

`bun run build` bundles each `framework/games/*.ts` (framework inlined, via
`Bun.build`) to `runtime/src/game/<name>.js`, so the PSP/Web/3DS build steps embed
them exactly like the raw games (e.g. `PSPJS_GAME=fw-rpg.js bun run psp`).

### Golden tests
`framework/test/golden.mjs` renders each game's bundle **headlessly in Node**
(a gfx mock → RGBA framebuffer), runs a deterministic seeded sequence with
scripted input, and byte-compares the framebuffer to a committed golden
(`framework/test/goldens/*.png`). Because the same bundle runs on every platform,
this catches crashes and visual regressions in the shared code. Run with
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
git clone https://github.com/doodlewind/psp-js.git
cd psp-js
bun install
bun run bootstrap
```

`bun run bootstrap` ([scripts/bootstrap.ts](scripts/bootstrap.ts)) is idempotent
and installs/configures:
- submodules + their patches (`bun run setup`)
- **LLVM** (`brew install llvm` — Apple clang can't target MIPS)
- **PPSSPP** (`brew install --cask ppsspp`) — PSP emulator
- **Azahar** (downloaded from GitHub releases) — 3DS emulator
- **Rust** `nightly-2021-11-01-x86_64-apple-darwin` + `rust-src` (Rosetta on Apple
  Silicon — host arch is irrelevant to the MIPS output), and pins the repo override
- **cargo-psp / prxgen / pack-pbp / mksfo** (built from the `rust-psp` submodule)
- the **PSPSDK** (prebuilt newlib) into `mipsel-sony-psp/`
- the **`devkitpro/devkitarm`** Docker image (3DS toolchain)

It reports anything it can't auto-install (Homebrew/Docker not present, Docker
daemon stopped); fix those and re-run. Then everything runs on Bun — there's no
Python/Make glue.

> The `rust-psp` / `quickjs-rs` submodule patches ([patches/](patches)) let them
> compile on a 1.58-era nightly and fix the 32-bit `size_t` ABI for QuickJS; LLVM
> `llvm-ar` is used for the static archive (Apple `ar` silently drops MIPS objects
> → `undefined symbol: JS_*`).

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

Open <http://localhost:8123/> (or `?game=fw-rpg.js` to pick one). The server
([`web/serve.ts`](web/serve.ts)) regenerates the game manifest on startup. The
Playground implements the identical `gfx`/`input`/`frame` contract on Canvas
([`web/engine.js`](web/engine.js)), so the same game files run in the browser.

## 3DS
Builds a `.3dsx` homebrew app using the `devkitpro/devkitarm` Docker image — no
host toolchain install or sudo needed (just Docker, e.g. OrbStack/Docker Desktop):

``` sh
PSPJS_GAME=tetris.js bun run 3ds   # -> runtime-3ds/psp-js-3ds.3dsx
```

Run the `.3dsx` in [Azahar](https://azahar-emu.org/) (the maintained Citra fork)
or on real hardware. The 3DS host ([`runtime-3ds/source/main.c`](runtime-3ds/source/main.c))
embeds QuickJS and renders the same games via citro2d (scaled to the 400×240 top
screen), with logs on the bottom screen.

## License
MIT

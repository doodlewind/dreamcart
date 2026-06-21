# Overview & architecture

DreamCart is an **isomorphic** JavaScript game runtime: the *same* game `.js` file
runs unchanged on a Sony **PSP**, the **Web**, a Nintendo **3DS**, and a dual-screen
**Android** handheld. You write a game once, in plain JavaScript, and it boots on
hardware with as little as 32 MB of RAM.

This page sets the mental model for the rest of the docs. Read it first, then dive
into the [runtime contract](/docs/runtime-contract/), the
[framework SDK](/docs/framework/), or [3D](/docs/3d/).

## What DreamCart is

- **One game, every platform.** Game logic is portable JavaScript. There is no
  per-platform fork of your game — the *exact same* bundle executes on each target.
- **Powered by [QuickJS](https://bellard.org/quickjs/).** A small, fast, spec-modern
  JavaScript engine embeds into each host, so you get real ES2020+ on tiny hardware
  (closures, classes, generators, `TypedArray`, …) — not a cut-down dialect.
- **A tiny native contract.** Each platform implements the same handful of native
  functions (clear the screen, fill a rectangle, log a line) and calls your game's
  `frame(buttons)` once per vblank (~60 Hz). That contract is the entire portability
  surface — see [Runtime contract](/docs/runtime-contract/).
- **Optional hardware 3D.** A second, equally small contract (`g3d`) uploads meshes
  once and submits one batched draw-list per frame, backed by a native renderer on
  each platform (sceGu/sceGum on PSP, WebGL2 on Web, citro3d on 3DS). See
  [3D](/docs/3d/).
- **An optional framework SDK.** On top of the raw contract sits a small isomorphic
  game framework (scene tree, input, RNG, graphics, tilemaps, dialogue, 3D scene
  graph). It is *optional*: you can write directly against the native contract, or
  lean on the SDK. See [Framework SDK](/docs/framework/).

## What DreamCart is not

- **Not an engine you script from C++.** The engine is the *host*; your game is JS.
  The boundary is firm: game business logic is JavaScript, and the framework SDK
  (authored in TypeScript) is *inlined into your bundle* at build time.
- **Not a browser/Electron wrapper.** PSP and 3DS builds are native homebrew
  (`rust-psp` + QuickJS on PSP; `libctru`/citro on 3DS). There is no DOM, no WebView
  on those targets — only the native contract.
- **Not a "near-portable" abstraction with platform `#ifdef`s in your game.** The
  same `.js` bundle is byte-for-byte identical across platforms; a
  [golden-test harness](/docs/framework/) renders each game headlessly and
  byte-compares the framebuffer, and a contract test asserts the button bitmask is
  identical on every host. Portability is enforced, not hoped for.

## The layered contract

DreamCart is best understood as a stack of contracts, each strictly built on the one
below it. You can stop at any layer.

```
┌──────────────────────────────────────────────────────────┐
│  Your game (.js)         snake.js · rpg.js · fps3d.js …    │
├──────────────────────────────────────────────────────────┤
│  Framework SDK (TS, inlined)   Scene · Input · Graphics ·  │
│  optional                      Rng · TileMap · Scene3D …   │
├───────────────────────────────┬──────────────────────────┤
│  Raw 2D contract              │  Optional g3d contract     │
│  gfx.clear / gfx.fillRect /   │  uploadMesh + submit       │
│  log + frame(buttons)         │  (one draw-list / frame)   │
├───────────────────────────────┴──────────────────────────┤
│  Native host per platform                                  │
│  PSP (rust-psp) · Web (Canvas/WebGL2) · 3DS (libctru) ·    │
│  Android (dual-screen WebView)                             │
└──────────────────────────────────────────────────────────┘
```

### Layer 1 — the raw native contract

Every host installs two globals and then calls one function your game defines. The
whole 2D surface is:

```js
gfx.clear(r, g, b);                  // clear the screen to an RGB color
gfx.fillRect(x, y, w, h, r, g, b);   // draw one filled rectangle
log(msg);                            // print to the host's debug overlay

// You define this; the host calls it once per vblank (~60 Hz):
function frame(buttons) { /* read buttons, draw the world */ }
```

`buttons` is a fixed controller bitmask, identical on every platform
(`UP = 0x10`, `RIGHT = 0x20`, `DOWN = 0x40`, `LEFT = 0x80`, `CROSS = 0x4000`,
`START = 0x08`, …). The host owns the loop and pacing — your game never spins its
own loop. A complete game in this layer (a `raw-*` demo) uses nothing but these
functions, drawing numbers with a tiny rectangle pixel-font. See
[Runtime contract](/docs/runtime-contract/) for the full bitmask and the
"write once, run everywhere" guarantee.

### Layer 2 — the optional framework SDK

The raw contract is deliberately tiny. The framework (`framework/src/`) is a small,
isomorphic SDK that turns it into something pleasant to author against: a
`Scene`/`Node` tree with `update`/`draw`, a fixed-timestep game loop, edge-detecting
`Input`, a seeded deterministic `Rng`, a `Graphics` helper (rects, sprites, baked
8×8 ASCII text), palette `Bitmap`s, a camera `TileMap`, and a `DialogueBox`.

```js
// @ts-check
import { start, Scene, Btn, Colors, rgb, SCREEN_W, SCREEN_H } from '../src/index';

class RootScene extends Scene {
  px = SCREEN_W / 2;

  /** @param {import('../src/index').UpdateContext} ctx */
  update(ctx) {
    const d = ctx.input.dir();          // d-pad or analog, -1..1 each axis
    this.px += d.x * 2;
    if (ctx.input.pressed(Btn.Start)) this.px = SCREEN_W / 2;
  }

  /** @param {import('../src/index').Graphics} g */
  draw(g) {
    g.clear(Colors.dark);
    g.rect(this.px - 8, SCREEN_H / 2 - 8, 16, 16, rgb(64, 184, 64));
    g.text('HELLO DREAMCART', 8, 8, Colors.white);
  }
}

start(() => new RootScene(), { seed: 1337 });
```

The SDK is written in **TypeScript** but games are authored in **plain JavaScript** —
`// @ts-check` + JSDoc gives full editor and CI type-checking against the SDK types
without compiling your game. Each game is bundled with the framework *inlined*
(`Bun.build`) per platform, so every target executes identical code. See
[Framework SDK](/docs/framework/) for the full module list.

### The optional 3D contract

Hardware 3D works the same way: upload geometry once, then submit a single batched
command buffer per frame. Scene, physics, and math live in shared JS; a native
renderer per platform consumes the buffer. The framework's `Scene3D` builds that
buffer for you, and a **retained native scene** can cull and draw entirely in Rust
on PSP (the key on-device performance unlock). See [3D](/docs/3d/).

## How a frame runs

1. The native host reads the controller into the fixed bitmask (PSP packs the analog
   stick into the high 16 bits; digital-only hosts leave them zero).
2. The host calls your `frame(buttons)`.
3. Under the framework, `Engine.tick` advances input edges, runs `update` over the
   scene tree, renders the optional 3D pass first, then draws the 2D tree as a HUD
   on top.
4. The host finishes the display list and swaps buffers. Repeat ~60×/second.

The host owns timing; your game is a pure `(state, input) -> next state + draw`
function. That determinism is what makes the same bundle byte-identical across
platforms and testable headlessly.

## Beyond the core

DreamCart also ships an asset and world pipeline so games stay small and boot fast:

- **Asset baking + `.dcpak`.** Fonts, sprites, glTF models, scenes, and BSP maps are
  baked to a binary container instead of base64-in-JS (which slowed QuickJS boot).
  See [Assets & .dcpak](/docs/assets/).
- **World import.** Import GoldSrc/Half-Life/CS1.6 BSP v30 maps into textured,
  walkable scenes. See [World import](/docs/worlds/).
- **Platform builds.** PSP (rust-psp), Web (Canvas/WebGL2), 3DS (libctru), and a
  dual-screen Android handheld. See [Platforms & builds](/docs/platforms/).

## Where to go next

- New here? Start with [Getting started](/docs/getting-started/) — install, build,
  and run a game on Web, PSP, or 3DS with one command.
- Want the portability primitives? Read the [Runtime contract](/docs/runtime-contract/).
- Building a real game? Read the [Framework SDK](/docs/framework/) and, for 3D,
  the [3D](/docs/3d/) guide.
- Looking up a specific export? See the [API reference](/docs/api/).

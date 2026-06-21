# Changelog

Dated summaries of new capabilities shipping in DreamCart — the isomorphic game
runtime where one `.js` cartridge runs unchanged on PSP, Web, 3DS, and Android.
Each entry is a development push (every couple of days), newest first. PR numbers
link to the [GitHub repository](https://github.com/doodlewind/dreamcart).

## 2026-06-19 — Engine subsystems and world import

A big push: the shared gameplay layer grew up (a reusable character controller, an
ActionMap, and fully data-driven scenes), the asset pipeline moved off base64 to a
real binary container, and the runtime learned to import real GoldSrc/Half-Life BSP
levels into walkable scenes.

### Engine

- **Shared `CharController` + analog input contract** — one movement controller that
  every game and platform feeds the same way; `walk3d` migrated to it byte-for-byte
  and a new `controller3d` demo shows it off ([#21](https://github.com/doodlewind/dreamcart/pull/21)).
- **`ActionMap` + data-driven scenes** — input bindings and scene graphs are now plain
  data, decoupled from per-game code; includes a pre-merge refactor of the scene layer
  ([#23](https://github.com/doodlewind/dreamcart/pull/23)).
- **`adventure3d` scene-ification** — the adventure arena is now described entirely by
  data, with a byte-exact result against the old hand-built scene ([#25](https://github.com/doodlewind/dreamcart/pull/25)).

### 3D & worlds

- **GoldSrc BSP map import** — parse and bake Half-Life / CS 1.6 BSP v30 maps into the
  engine (`bsp.ts` parser + `bake-bsp.ts` + `bsp3d.js`), plus a PSP↔ground-truth render
  loop and a `.dcpak` migration for BSP assets ([#15](https://github.com/doodlewind/dreamcart/pull/15)).
- **Procedural CC0 BSP generation** — `BspBuilder` synthesizes BSP geometry from scratch
  (no copyrighted maps needed), with a z-fighting test scene ([#24](https://github.com/doodlewind/dreamcart/pull/24)).

### Tooling

- **`.dcpak` binary asset format** — assets are baked into a compact binary container
  instead of base64-embedded JS, killing the QuickJS boot-time megabyte parse that was
  hanging large games ([#19](https://github.com/doodlewind/dreamcart/pull/19)).

### Fixes

- **Quieter PSP builds** — the benign "linking abicalls code with non-abicalls code"
  warning flood (prebuilt newlib vs. rust-psp) is now suppressed by default ([#20](https://github.com/doodlewind/dreamcart/pull/20)).
- **PSP Vita runtime** fixes so all game bundles run correctly ([#12](https://github.com/doodlewind/dreamcart/pull/12)),
  plus a normalized PSP SDK and rust-psp submodule cleanup ([#9](https://github.com/doodlewind/dreamcart/pull/9),
  [#10](https://github.com/doodlewind/dreamcart/pull/10), [#11](https://github.com/doodlewind/dreamcart/pull/11)).

## 2026-06-17 — Advanced 3D and the PSP performance unlock

The runtime went from drawing flat triangles to a full hardware-accelerated 3D stack —
textures, lighting, and glTF skinning — and then made it actually fast on a PSP by
moving the per-frame hot path out of interpreted JS and into native Rust.

### 3D

- **Advanced 3D contract (g3d v2)** — textured and hardware-lit static meshes, plus a
  glTF→PSP bake pipeline for real assets (Kenney nature & car, the animated Fox)
  ([#6](https://github.com/doodlewind/dreamcart/pull/6)).
- **Hardware skinning** — bone-batched glTF animation took the animated Fox from 6 to
  30 FPS, then a **native animation sampler** took it from 30 to 60 FPS.
- **Retained native scene** — culling and drawing now happen in Rust rather than
  per-node QuickJS; this is the key PSP performance unlock. A hybrid path keeps static
  geometry baked while still allowing per-frame rigid dynamics (`car3d`).
- **`mergeMeshes`** bakes a static scene into a single draw call, and a new
  `outdoor3d` scene maxes out the hardware as a showcase.

### Engine

- **Native text rendering** — `drawText` rasterizes glyphs in Rust instead of JS,
  batching glyph quads for fast 2D text on device.
- New demo games landed: `walk3d` (animated skinned Fox), `car3d` (driving scene),
  `skin3d` (interactive Fox showcase), and `outdoor3d`.

### Fixes

- **O(1) segregated arena allocator** — fixed kernel-object exhaustion that crashed
  large bundles, and removed the per-frame allocation bottleneck.
- Stopped baked glTF assets from leaking into every game bundle (a PSP boot hang),
  and cached static nodes' world matrices and bounds in `Scene3D`.

### Tooling & docs

- **`psp-emulator-debug` skill** — drive PPSSPP on macOS to screenshot the render,
  read crash reports, and check in-game FPS while debugging the PSP runtime.
- **PSP performance field guide** documenting the allocator, native offload, and
  profiling workflow.

## 2026-06-15 — Isomorphic 3D and dual-screen Android

The foundation push: the project became DreamCart, gained a shared 3D layer that runs
the same game logic across every platform, and added a dual-screen Android handheld.

### 3D

- **Isomorphic 3D layer** — shared scene/physics/math in JS with a native engine per
  platform (sceGu/sceGum on PSP, WebGL2 on Web, citro3d on 3DS) ([#4](https://github.com/doodlewind/dreamcart/pull/4)).
- **Reversed-Z depth on Web** now works without the `EXT_clip_control` extension.

### Platforms

- **Dual-screen Android runtime** — the DreamCart handheld app, with 3D via the shared
  WebGL2 engine ([#5](https://github.com/doodlewind/dreamcart/pull/5)).
- Finished the Web and 3DS hosts and pinned cross-platform conventions.

### Tooling & docs

- **Project rename** psp-js → **DreamCart**, with the `dreamcart.games` site
  ([#3](https://github.com/doodlewind/dreamcart/pull/3)).
- **`tech-explainer` skill** plus the first explainer (depth / reversed-Z).

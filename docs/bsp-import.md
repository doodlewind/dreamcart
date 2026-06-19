# GoldSrc / CS 1.6 BSP map import

Import a classic **GoldSrc BSP version 30** map (Half-Life / Counter-Strike 1.6) into
the DreamCart `g3d` engine and walk it on PSP/Web/3DS. The shape is: parse the real
format → a chunked, textured `BakedMesh` module (the same module shape the engine's
glTF/baked assets use) → a small walkable loader game (`bsp3d.js`).

## Pipeline

| File | Role |
|------|------|
| `framework/bake/bsp.ts` | Pure BSP v30 parser (header + 15 lumps, signed-surfedge face reconstruction, texinfo UVs, embedded miptex + palette → RGBA, entity `info_player_start`). No I/O, so tests import it directly. |
| `framework/bake/fetch-bsp.ts` | Bun `fetch()` that vendors a real map under `assets/vendor/bsp/` at build time. |
| `framework/bake/bake-bsp.ts` | Takes `models[0]` (worldspawn) faces; drops sky/trigger/clip faces; converts Hammer (Z-up, inches) → engine (Y-up, metres); fan-triangulates; bakes a directional/lightmap shade into per-vertex COLOR; chunks by (grid cell, texture); auto-decimates by face area to fit the PSP module budget; emits `framework/src/assets-bsp-<map>.ts` (sub-meshes + a `textures[]` array + spawn + wall AABBs). |
| `framework/src/bsp-walk.ts` | Shared deterministic walker + AABB collision (used by both the game and the walk test). |
| `framework/games/bsp3d.js` | Walkable loader: a `Material` per texture, camera-following ground/sky, the skinned soldier, the shared walker. Swap map by changing one import line. |

## Coordinates, textures, lighting

- **Coords**: `engine = (hammerX, hammerZ, -hammerY) × 0.0254`. UVs are computed from the
  *unconverted* Hammer vertex (the texinfo S/T planar projection).
- **Textures**: one PSM_8888 texture per used miptex, downsampled to ≤64² (PSP textures
  live in main RAM; small textures keep the module under budget so geometry isn't
  decimated). BSP UVs exceed `[0,1]` by design and the GE REPEATs, so each texture tiles
  correctly with no atlas.
- **Lighting**: a face's lightmap block (or a directional fallback) is averaged and folded
  into the per-vertex COLOR; the GE modulates the texture over it. This costs zero extra
  VRAM and makes the vertex-colour software rasterizer render meaningful relief.

## Licensing

- **Committed**: a hand-authored **CC0** `framework/test/fixtures/box.bsp` (a real BSP v30:
  one textured room + a spawn) and its baked module `assets-bsp-box.ts`. This is the
  deterministic E2E fixture — original work, safe to redistribute.
- **Not committed**: classic Valve maps (e.g. Half-Life `c1a0`) are Valve-copyright. They
  are *fetched at build time* (like the PSP SDK) and their baked modules
  are `.gitignore`d (`assets/vendor/bsp/*.bsp`, `assets-bsp-c1a0*.ts`). Do not commit them.

## End-to-end test (`bun run test`)

Four committed, deterministic, no-network/no-hardware stages over `box.bsp`:

1. **Parse** (`bsp-parse.test.ts`) — valid lump directory, faces reconstruct into
   non-degenerate convex rings, finite UVs, a decoded texture, one in-bounds spawn.
2. **Bake** (`bsp-bake.test.ts`) — decodable meshes, valid indices/stride, a meaningful
   (non-black, non-uniform) per-vertex COLOR, sane AABBs/spawn, in budget, and the
   committed module byte-equals a fresh bake (determinism / drift guard).
3. **Render** (golden in `golden.ts`) — `bsp3d` runs through the software rasterizer for
   90 frames; byte-exact pixel + draw-list goldens (`bsp3d.rgbz/.png/.dc3d`).
4. **Walkability** (`bsp-walk.test.ts`) — the shared walker moves the player, keeps it in
   bounds, and a wall stops it (no pass-through); a trajectory golden catches physics drift.

A manual PPSSPP smoke step verifies a real fetched map (`PSPJS_GAME=bsp3d.js` with the
import switched to `c1a0`) boots, textures, and walks at ~60 FPS.

## WAD textures (classic CS maps)

Classic CS maps (`de_dust2`, …) keep most textures in external **WAD3** files, not in the
`.bsp`. `bsp.ts` parses WAD3 (`parseWad` / `resolveWadTextures`), and `bake-bsp.ts`
auto-loads any vendored `assets/vendor/bsp/*.wad` and fills the map's WAD-referenced
textures by name. `halflife.wad` + `cs_dust.wad` fully texture `de_dust2`/`de_dust`; maps
that need cstrike-only WADs (not freely available) import with the missing textures as a
flat fallback — geometry + walkability still work.

## Importing real classic maps locally

```sh
bun framework/bake/fetch-bsp.ts cs            # the classic CS batch (8 maps + WADs, gitignored)
bun framework/bake/test-bsp-maps.ts           # systematic import test: parse+bake+assert every vendored map
bun framework/bake/bake-bsp.ts de_dust2       # -> framework/src/assets-bsp-de-dust2.ts (gitignored)
# point framework/games/bsp3d.js at BSP_DE_DUST2, then: PSPJS_GAME=bsp3d.js bun runtime/build.ts
```

`test-bsp-maps.ts` is a local systematic harness (the maps are copyrighted, so it is NOT a
committed CI test): it bakes every vendored `.bsp` and asserts a valid v30, real geometry,
a usable spawn, and a bake under the PSP budget — verified across `c1a0`, `de_dust2`,
`de_dust`, `cs_assault`, `de_aztec`, `cs_office`, `de_inferno`, `de_nuke`, `de_train`.

## v1 limitations

- Worldspawn (`models[0]`) only — brush entities (doors/lifts) are skipped.
- Lighting is one averaged colour per face (not per-luxel lightmaps as a second texture).
- Collision is wall-rect AABBs + a flat floor height, not full brush/clipnode collision.
- A large complex map decimates small faces to fit the PSP budget.

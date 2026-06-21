# World import

DreamCart can turn worlds that already exist — a classic shooter map — into a textured,
walkable PSP/Web/3DS scene. The importer parses the source format **offline** into the
engine's baked-mesh modules, then loads those as static, frustum-culled geometry at runtime.

- **GoldSrc BSP** — import Half-Life / Counter-Strike 1.6 maps (`.bsp` version 30).

The importer follows the project rule that heavy work happens at bake time, never on the
PSP. The baker may use full floating-point trig, earcut triangulation and hashing; the
runtime only array-looks-up decoded bytes and submits one batched draw list per frame.
See [3D](/docs/3d/) for the `Scene3D` / `Material` / `meshFromBaked` APIs used below, and
[Assets & .dcpak](/docs/assets/) for how baked modules are stored.

## GoldSrc / Half-Life BSP maps

A GoldSrc **BSP v30** map (Half-Life, Counter-Strike 1.6, and the rest of the GoldSrc
catalogue) is parsed from its real binary format into chunked, textured `BakedMesh`
modules — the same module shape the engine's glTF and procedural assets use — then walked
with the shared deterministic walker and AABB collision.

### Pipeline

| File | Role |
|------|------|
| `framework/bake/bsp.ts` | Pure BSP v30 parser: header + 15 lumps, signed surfedge face reconstruction, texinfo planar UVs, embedded miptex + palette decoded to RGBA, and the `info_player_start` entity. No I/O, so tests import it directly. Also parses external **WAD3** texture archives (`parseWad` / `resolveWadTextures`). |
| `framework/bake/fetch-bsp.ts` | Pure Bun `fetch()` that vendors a real map under `assets/vendor/bsp/` at build time (copyrighted maps are never committed). |
| `framework/bake/bake-bsp.ts` | Takes `models[0]` (worldspawn) faces, drops sky/trigger/clip faces, converts Hammer space (Z-up, inches) to engine space (Y-up, metres), fan-triangulates, folds a per-face shade into per-vertex color, chunks by `(grid cell, texture)`, decimates small faces to fit the PSP module budget, and emits `framework/src/assets-bsp-<map>.ts` (sub-meshes + a `textures[]` array + spawn + wall AABBs). |
| `framework/src/bsp-walk.ts` | Shared deterministic walker (`walkStep`) + floor lookup (`floorAt`), used by both the game and the walk test. |
| `framework/games/bsp3d.js` | Walkable loader: one `Material` per texture, a camera-following ground/sky, a skinned soldier, and the shared walker. Swap maps by changing a single import line. |

### Coordinates, textures, lighting

- **Coordinates.** GoldSrc is Z-up and measured in inches; the engine is Y-up in metres.
  The baker converts each vertex as `engine = (hammerX, hammerZ, -hammerY) × 0.0254`. UVs
  are computed from the **unconverted** Hammer vertex using the texinfo S/T planar
  projection, so texturing is unaffected by the axis swap.
- **Textures.** One `PSM_8888` texture per used miptex, downsampled to ≤64². PSP textures
  live in main RAM, so keeping them small keeps the whole module under budget and stops
  geometry from being decimated. BSP UVs deliberately exceed `[0, 1]`; the GE (and WebGL)
  REPEAT-wrap, so each texture tiles correctly with **no atlas**.
- **Lighting.** A face's lightmap block (or a directional fallback) is averaged and baked
  into the per-vertex COLOR; the GE modulates the texture over it. This costs zero extra
  VRAM and gives the vertex-color rasterizer meaningful relief.

### Loading a baked map

A baked module exports its sub-meshes, decoded textures, spawn and collision data. The
game binds one `Material` per texture and adds each sub-mesh as a bounded (so cullable),
static `Node3D`:

```js
import {
  Scene3D, Node3D, Material, Texture, Vec3, meshFromBaked,
  walkStep, floorAt,
} from '../src/index';
// Direct import — NEVER via index.ts, which would embed the blob in every game
// bundle and exhaust PSP memory at boot. Swap maps by editing only this line.
import { BSP_BOX as BSP } from '../src/assets-bsp-box';

const world = new Scene3D();
world.fog = { color: BSP.skyColor, near: 40, far: 80 };

// One Material per baked texture; sub-meshes are pre-sorted by texId so each
// texture binds once for its whole run.
const mats = BSP.textures.map(
  (t) => new Material({ texture: new Texture(t.pixels, t.width, t.height, t.psm) }),
);

for (const m of BSP.meshes()) {
  const node = new Node3D({
    mesh: meshFromBaked(m),
    material: mats[m.texId],
    isStatic: true,
  });
  node.bounds = { min: m.aabb.min, max: m.aabb.max };
  world.add(node);
}
```

Collision and the spawn come from the same module. `walkStep` advances the player against
the wall AABBs, and `floorAt` tracks the floor height beneath them:

```js
const st = { x: BSP.spawn[0], z: BSP.spawn[1], heading: BSP.spawn[2], y: 0 };
st.y = floorAt(BSP.floorSpans, st.x, st.z, BSP.spawnY, BSP.spawnY);

// Each frame: ix/iz are the d-pad axes, run is a button, camYaw the camera heading.
const moving = walkStep(st, BSP.solidAABBs, BSP.span - 0.5, ix, iz, run, camYaw, dt);
```

### Licensing

- **Committed.** A hand-authored **CC0** fixture `framework/test/fixtures/box.bsp` (a real
  BSP v30 — one textured room with a spawn) and its baked module `assets-bsp-box.ts`. This
  is the deterministic end-to-end fixture, original work and safe to redistribute.
- **Not committed.** Classic Valve maps are Valve-copyright. They are *fetched at build
  time* (like the PSP SDK) and their baked modules are `.gitignore`d
  (`assets/vendor/bsp/*.bsp`, `assets-bsp-*.ts`). Do not commit them.

### WAD textures (classic CS maps)

Classic CS maps such as `de_dust2` keep most textures in external **WAD3** files, not in
the `.bsp`. `bsp.ts` parses WAD3, and `bake-bsp.ts` auto-loads any vendored
`assets/vendor/bsp/*.wad` and fills the map's WAD-referenced textures by name.
`halflife.wad` + `cs_dust.wad` fully texture `de_dust2` / `de_dust`. Maps that need
cstrike-only WADs (not freely available) still import: the missing textures fall back to a
flat color, and geometry + walkability are unaffected.

### Importing real maps locally

```sh
bun framework/bake/fetch-bsp.ts cs        # the classic CS batch (8 maps + WADs, gitignored)
bun framework/bake/test-bsp-maps.ts       # parse + bake + assert every vendored map
bun framework/bake/bake-bsp.ts de_dust2   # -> framework/src/assets-bsp-de-dust2.ts (gitignored)
# point framework/games/bsp3d.js at BSP_DE_DUST2, then:
PSPJS_GAME=bsp3d.js bun runtime/build.ts
```

`test-bsp-maps.ts` is a local systematic harness (the maps are copyrighted, so it is not a
committed CI test): it bakes every vendored `.bsp` and asserts a valid v30, real geometry,
a usable spawn and a bake under the PSP budget — verified across `c1a0`, `de_dust2`,
`de_dust`, `cs_assault`, `de_aztec`, `cs_office`, `de_inferno`, `de_nuke` and `de_train`.

### Verification

The committed end-to-end test (`bun run test`) covers `box.bsp` in four deterministic,
no-network stages:

1. **Parse** — valid lump directory, faces reconstruct into non-degenerate convex rings,
   finite UVs, a decoded texture, one in-bounds spawn.
2. **Bake** — decodable meshes, valid indices/stride, a meaningful (non-black, non-uniform)
   per-vertex COLOR, sane AABBs/spawn, in budget, and the committed module byte-equals a
   fresh bake (a determinism / drift guard).
3. **Render** — `bsp3d` runs through the software rasterizer for 90 frames against
   byte-exact pixel and draw-list goldens (`bsp3d.rgbz` / `.png` / `.dc3d`).
4. **Walkability** — the shared walker moves the player, keeps it in bounds, and a wall
   stops it (no pass-through); a trajectory golden catches physics drift.

A manual PPSSPP smoke step verifies a real fetched map boots, textures and walks at
~60 FPS.

### v1 limitations

- Worldspawn (`models[0]`) only — brush entities (doors, lifts) are skipped.
- Lighting is one averaged color per face, not per-luxel lightmaps as a second texture.
- Collision is wall-rect AABBs plus a floor height, not full brush / clipnode collision.
- A large, complex map decimates small faces to fit the PSP budget.

## See also

- [3D](/docs/3d/) — `Scene3D`, `Material`, `Texture`, `meshFromBaked`, native scene offload.
- [Assets & .dcpak](/docs/assets/) — how baked modules are stored and loaded.
- [Framework SDK](/docs/framework/) — the `CharController` and input contract behind walking.
- [Platforms & builds](/docs/platforms/) — building a chosen game for PSP / Web / 3DS.

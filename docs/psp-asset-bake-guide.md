# DreamCart PSP Advanced-3D — Unified Asset + Bake Implementation Guide

Ground truth: `docs/3d-design.md` (§1/§2 budgets+hardware, §4 asset pipeline, §10
PSP-only mesh handling). Branch: `feat/psp-advanced-3d`. All scripts run on **Bun**.
This guide is the single source for writing `framework/bake/bake-gltf.ts` and the
M1–M6 scene games. Three assets are already vendored under `assets/vendor/`.

> NOTE on the format constants below: they are the ones that ALREADY EXIST in
> `framework/src/g3d.ts` — `FMT_POS=0x0001`, `FMT_COLOR=0x0002`, `FMT_NORMAL=0x0004`,
> `FMT_UV=0x0008`, `FMT_WEIGHTS=0x0010`; `vertexStride(format, weightCount)` and
> `colorToABGR(c,a)` are exported. The bake MUST emit bytes in g3d's stated GE order
> `[weights][uv][color][normal][position]` (each field 4-byte aligned), regardless of
> which bits are set. The per-asset analyses earlier used ad-hoc names (FMT_UV=0x8 vs
> some notes saying 0x0008-as-UV) — **use the g3d.ts values verbatim**: UV = `0x0008`,
> COLOR = `0x0002`, NORMAL = `0x0004`.

---

## 1. Acquisition status — vendored vs. needs-download

All three assets were successfully downloaded and the needed files are vendored.
**Nothing requires a manual re-download to start the bake.** Re-fetch commands are
included only as provenance / for CI reproducibility.

### Vendored (ready to bake)

| Asset | Path | Key files | sha256 (primary) |
|---|---|---|---|
| **fox** | `assets/vendor/fox/` | `Fox.glb`, `Texture.png`, `ATTRIBUTION.txt`, `SOURCE-README.md` | `Fox.glb` = `d97044e701822bac5a62696459b27d7b375aada5de8574ed4362edbba94771f7` |
| **kenney-car** | `assets/vendor/kenney-car/` | `sedan.glb`, `wheel-default.glb`, `colormap.png`, `Textures/colormap.png`, `License.txt` | `sedan.glb` = `b532ea7d2c59f7f6b22b138cf1955218a2c1898f1cea932af4d3fd563c3959b7` |
| **kenney-nature** | `assets/vendor/kenney-nature/` | `tree_simple.glb`, `rock_smallA.glb`, `plant_bushSmall.glb`, `grass_leafs.glb`, `License.txt`, `analyze.mjs` | `tree_simple.glb` = `93891ea740447634930de19c31a7c1c9f4add94122e6db03aca9f75aea32f9d6` |

Critical vendoring detail: **kenney-car GLBs reference an EXTERNAL texture**
(`images[0].uri = \"Textures/colormap.png\"`). The sibling `Textures/colormap.png`
MUST stay in place or `NodeIO.read()` throws ENOENT. The bake may instead read
`colormap.png` directly and ignore the GLB image. Do not delete `Textures/`.

### Re-fetch commands (provenance only — NOT required)

```bash
# Fox (Khronos glTF-Sample-Assets) — Fox.glb + Texture.png
curl -sSL -o Fox.glb \\
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb'
# sha256 d97044e701822bac5a62696459b27d7b375aada5de8574ed4362edbba94771f7

# Kenney Car Kit v3.1 (server is flaky — use resume + retries)
curl -sSL --retry 5 --retry-all-errors -C - -o kenney_car-kit.zip \\
  'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip'
# zip sha256 fac7dacac5c7874348cf19729af3ef205f3d366493edaf0a827d93f4fdf3d0c4
# vendor only: Models/GLB format/{sedan.glb,wheel-default.glb,Textures/colormap.png} + License.txt

# Kenney Nature Kit v2.1
curl -sSL -A 'Mozilla/5.0' -o nature-kit.zip \\
  'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip'
# zip sha256 fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d
# vendor only: Models/GLTF format/{tree_simple,rock_smallA,plant_bushSmall,grass_leafs}.glb + License.txt
```

---

## 2. devDependencies + bake script wiring

The two deps are **already present** in `package.json` `devDependencies` — no change
needed:

```json
\"@gltf-transform/core\": \"^4.4.0\",
\"upng-js\": \"^2.1.0\"
```

Run `bun install` once if `node_modules` is stale. Then extend the `bake` script to
chain the new gltf bake after the existing font/sprite bakes:

```json
\"bake\": \"bun framework/bake/bake-font.ts && bun framework/bake/bake-sprites.ts && bun framework/bake/bake-gltf.ts\"
```

`bake-gltf.ts` is ONE script that emits all three modules (it iterates an asset table).
It writes `framework/src/assets-fox.ts`, `framework/src/assets-kenney-car.ts`,
`framework/src/assets-kenney-nature.ts`. The umbrella `build` script
(`bun run bake && typecheck && bundle && web`) then picks them up automatically.

Add three re-export lines to `framework/src/index.ts` (mirroring lines 22–23):

```ts
export { FOX } from './assets-fox';
export { KENNEY_CAR } from './assets-kenney-car';
export { NATURE_FORMAT, NATURE_STRIDE, NATURE_PROPS } from './assets-kenney-nature';
```

`upng-js` has no types; add `// @ts-ignore` at its import or a 1-line
`declare module 'upng-js'` shim in `framework/bake/`. `@gltf-transform/core` ships types.

---

## 3. Shared `bake-gltf.ts` design

`bake-gltf.ts` is an **offline Bun step**. Real trig / quaternion slerp / box
downsample are allowed here; the RUNTIME must only array-lookup + lerp (no `Math.*`
in scene playback — use `framework/src/math.ts` deterministic ops). Determinism: all
greedy passes process triangles in source order; re-running the bake is reproducible.

### 3.1 Asset table (driver)

```ts
const ASSETS = [
  { name: 'kenney-nature', kind: 'static-flatcolor', files: [...4 glbs...] },
  { name: 'kenney-car',    kind: 'static-textured',  bodyGlb, wheelGlb, tex },
  { name: 'fox',           kind: 'skinned',          glb, tex, scale: 0.03, fps: 24,
                            boneLimit: 8 /* default; 4 = fallback */ },
];
```

### 3.2 Common steps (all assets)

1. **Parse** with `@gltf-transform/core` `NodeIO().read(path)`. Get
   `doc.getRoot().listMeshes()`, then per primitive
   `prim.getAttribute('POSITION'|'NORMAL'|'TEXCOORD_0'|'JOINTS_0'|'WEIGHTS_0')` and
   `prim.getIndices()`. `.getArray()` returns the typed array; `.getElement(i, out)`
   reads one element. Materials via `prim.getMaterial()`,
   `mat.getBaseColorFactor()` (RGBA floats), `mat.getBaseColorTexture()`.
2. **Bake node TRS into geometry.** Walk to the mesh's node; compose its world
   matrix; transform POSITION by it and NORMAL by the inverse-transpose. (Nature
   nodes have translation `[0,-0.05,0]`; car body node `[0,0.15,-0.025]` — but for the
   car, bake body verts at ORIGIN and keep wheel offsets as data, see §3.5.)
3. **Index handling.** Narrow indices to `Uint16Array` (verify max < 65535 — true for
   all three assets). Fox is non-indexed (`getIndices()===null`): synthesize indices
   `[0,1,2,3,...]` per the 576 sequential tri-triples, OR keep non-indexed.
   **Emit the INDEXED form.** Per `docs/3d-design.md` §10, the PSP host re-expands
   indexed meshes to a 16-byte-aligned non-indexed Vertex buffer at upload; Web/3DS
   draw indexed. The bake stays indexed.
4. **Interleave in GE order.** Build each vertex's bytes as
   `[weights f32×k][uv f32×2][color u32 ABGR][normal f32×3][position f32×3]`,
   emitting ONLY present fields, each 4-byte aligned, summed by `vertexStride()`.
   Fill COLOR with `colorToABGR(rgb, 255)` (flat-color assets) or `NO_TINT`
   (0xFFFFFFFF, textured assets — texture shows unmodulated).
5. **Texture decode + downsample + PSM-pack** (textured assets only):
   `UPNG.decode(bytes)` → `UPNG.toRGBA8(img)` → RGBA8888 buffer at `img.width×img.height`.
   **Box-downsample** (deterministic 2×2 / NxN average) to the target power-of-two
   ≤256². Force `a=0xFF` if source is RGB (ctype 2 — Fox). Emit **PSM8888** (RGBA8,
   4 B/px, rows 16-byte aligned at 256: 256·4=1024). Record a VRAM fallback note
   (PSM5650 16-bit, or PSM_T8 CLUT) in the module comment.
6. **Clip resample** (skinned only): see §3.4.

### 3.3 Vertex formats resolved (per asset)

| Asset | Fields present | `format` bits | weightCount | **stride** |
|---|---|---|---|---|
| **kenney-nature** | COLOR+NORMAL+POS | `FMT_COLOR\\|FMT_NORMAL\\|FMT_POS` = `0x0007` | 0 | **28 B** |
| **kenney-car** | UV+COLOR+NORMAL+POS | `0x0008\\|0x0002\\|0x0004\\|0x0001` = `0x000F` | 0 | **36 B** |
| **fox** | WEIGHTS+UV+COLOR+POS (no normal) | `0x0010\\|0x0008\\|0x0002\\|0x0001` = `0x001B` | 4 | **36 B** |

Byte layouts (GE order, present-only):

- **nature (28 B):** color u32 @0 · normal f32×3 @4 · pos f32×3 @16.
- **car (36 B):** uv f32×2 @0 · color u32 @8 · normal f32×3 @12 · pos f32×3 @24.
- **fox (36 B):** weights f32×4 @0 · uv f32×2 @16 · color u32 @24 · pos f32×3 @28.
  (No NORMAL — Fox is unlit/texture-only. If lighting is later wanted, adding NORMAL
  pushes stride to 48 B and is an M6 change.)

COLOR is constant per draw for car (`NO_TINT`; per-instance car color via the host
tint/`sceGuColor`) and per-vertex-baked for nature (folds `baseColorFactor`).

### 3.4 Skinned-only step — bone-batch partition (Fox)

PSP GE has **no bone-index palette**: a single skinned draw binds ≤8 bone matrices and
weight slot *i* pairs with matrix slot *i*. Any rig with >8 joints (Fox: 24) must be
**partitioned BY TRIANGLE** at bake time into batches whose union of weight>0 joints ≤
the bone limit. Algorithm (deterministic greedy best-fit):

1. For each triangle, compute its joint set = union of weight>0 `JOINTS_0` over its 3
   verts (Fox max unique joints/tri = 4, so a ≤4 limit is always feasible).
2. Process tris in source order; place each into the first existing batch whose joint
   set ∪ tri-joints ≤ limit and that adds the fewest new joints; else open a new batch.
3. Per batch: build a `jointTable` (local slot → global skin-joint index, sorted),
   remap that batch's `JOINTS_0` to local slots `0..k-1`, and **reorder WEIGHTS_0 to
   the SAME local slot order, zero-padding unused slots**. (Mismatched weight/slot
   order silently skins to the wrong matrix — this is the #1 bug risk.)
4. Emit per batch: ONE interleaved non-indexed-equivalent VB (its tris' verts; indexed
   emit is fine since Fox tris are already non-shared so no inflation — total stays
   1728 verts) + ONE `jointTable` (`Uint8Array`) + `boneCount = k`.

**Fox resolved result:**
- **Default (boneLimit = 8): 7 batches** (avg 7.71 joints/batch) → 7 skinned draws/frame.
  jointTables: `[2,3,6,10,11,13,16,20]`(160 tris) · `[2,3,4,10,14,15,16,17]`(91) ·
  `[2,4,5,7,8,10,20,21]`(87) · `[2,3,4,7,10,11,20,21]`(20) · `[2,4,5,6,13,14,15]`(56) ·
  `[2,16,17,18,19,20,21,22]`(80) · `[8,9,11,12,21,22,23]`(82). Tris sum = 576.
- **Fallback (boneLimit = 4): 19 batches** (avg 3.79) — keep available for perf/compat
  A/B; cuts matrices/draw but raises draw count to 19.
- Recommend shipping **8 / 7-batch**. Both are within the single-submit / one-FFI
  budget; perf-check the 7 `sceGumLoadMatrix`+`drawArray` pairs at M4/M5.

PSP vertex flags for a Fox batch:
`GU_WEIGHT_32BITF | GU_TEXTURE_32BITF | GU_COLOR_8888 | GU_VERTEX_32BITF | GU_WEIGHTS(k) | GU_TRANSFORM_3D`.

### 3.5 Animation resample (Fox)

- 24 joints, hierarchy parents `Int8Array([-1,0,1,2,3,4,5,4,7,8,4,10,11,2,13,14,2,16,17,18,2,20,21,22])`,
  inverseBindMatrices present (24×16 col-major f32). Joint[0] `_rootJoint` is an
  armature empty; the only translation channel is on `b_Root_00` — runtime must still
  compose the FULL 24-joint hierarchy; `jointTable` indices index this 24-joint array.
- **Target 24 fps**, resample each clip to evenly-spaced frames `dt=1/24`, inclusive of
  `t=0..dur`. Per frame, sample each joint's local TRS (LINEAR / nlerp quats at bake),
  store per-joint local matrix or TRS. Frame counts (resolved):
  **Survey = 83**, **Walk = 18** (no-op: native is already 24 fps / 18 keys),
  **Run = 29**. Clips are mutually exclusive (play one at a time).
- Runtime = lerp between two baked frames via `math.ts` (no trig).

### 3.6 Texture conversions resolved

| Asset | Source | Target | PSM | Notes |
|---|---|---|---|---|
| fox | 1024×1024 RGB8 (ctype2, no alpha) | 256×256 | PSM8888 | force a=0xFF; keep 512² fallback if VRAM allows |
| kenney-car | 512×512 RGBA8 | 256×256 | PSM8888 | mandatory downsample (512² PSM8888 = 1 MB > ~660 KB free VRAM); coarse flat-swatch UVs lose no detail |
| kenney-nature | **none** | — | — | NO texture; flat color baked into per-vertex ABGR |

All targets: power-of-two, ≤256², 16-byte-aligned row pitch (1024 B). Note VRAM-saving
options in module comments: PSM5650 (128 KB) or PSM_T8 + 256-entry CLUT (~64 KB);
downsample-to-128² plan if 256² is tight alongside framebuffers+depth.

---

## 4. Shared emitted data-module shape (TS)

Mirror the existing `assets-sprites.ts` pattern: AUTO-GENERATED header, plain `export
const`, typed arrays. Store large byte blobs as **base64** decoded at init to keep
`.ts` files compact (a tiny `b64(u8): string` / `unb64(s): Uint8Array` helper in the
bake + a runtime `unb64` in the module). The `Mesh` constructor is
`new Mesh(vertices: ArrayBuffer, indices: Uint16Array, format: number)`.

### Shared interfaces

```ts
// Common mesh blob (one per rigid mesh / per skinned batch).
export interface BakedMesh {
  format: number;        // FMT_* bitfield (g3d.ts)
  stride: number;        // bytes per vertex (== vertexStride(format, weightCount))
  vertexCount: number;
  vertices: Uint8Array;  // interleaved, GE order, length = stride*vertexCount
  indices: Uint16Array;  // triangle list
  triCount: number;
  aabb: { min: [number, number, number]; max: [number, number, number] };
}

export interface BakedTexture {
  width: number;         // power-of-two <=256
  height: number;
  psm: 'PSM8888';        // PoC; 16-bit/CLUT noted as VRAM-saving alt
  pixels: Uint8Array;    // RGBA8888, length = width*height*4
}
```

### `assets-kenney-nature.ts`

```ts
export const NATURE_FORMAT = 0x0007;   // COLOR|NORMAL|POS
export const NATURE_STRIDE = 28;
export interface NatureProp extends BakedMesh {}
export const NATURE_PROPS: Record<'tree'|'rock'|'bush'|'grass', NatureProp>;
// tree 120v/62t, rock 30v/16t, bush 48v/16t, grass 36t/84v. No texture.
// AABBs from POSITION min/max (e.g. tree min[-0.177,0,-0.205] max[0.177,1.519,0.205]).
```

### `assets-kenney-car.ts`

```ts
export const KENNEY_CAR: {
  format: number;        // 0x000F (UV|COLOR|NORMAL|POS)
  stride: 36;
  body: BakedMesh;       // 1072v, 2112 idx, 704 tris, baked at origin
  wheel: BakedMesh;      // wheel-default.glb: 480v, 996 idx, 332 tris
  wheelOffsets: [number,number,number][]; // FR,FL,BL,BR =
    // [[-0.3,0.3,0.66],[0.3,0.3,0.66],[0.3,0.3,-0.66],[-0.3,0.3,-0.66]]
  texture: BakedTexture; // 256x256 PSM8888
};
```

### `assets-fox.ts`

```ts
export const FOX: {
  scale: 0.03;
  texture: BakedTexture;          // 256x256 PSM8888 (alpha forced 0xFF)
  jointCount: 24;
  jointParents: Int8Array;        // length 24 (table in §3.5)
  inverseBindMatrices: Float32Array; // 24*16 col-major
  bindLocalTRS: { t: Float32Array; r: Float32Array; s: Float32Array }; // 24*3,24*4,24*3
  boneLimit: 8;                   // (4-batch fallback emittable behind a flag)
  batches: Array<{
    jointTable: Uint8Array;       // local slot -> global joint index
    boneCount: number;            // k (<= boneLimit)
    mesh: BakedMesh;              // format 0x001B, stride 36, weights reordered to local slots
  }>;
  clips: Record<'Survey'|'Walk'|'Run', {
    fps: 24;
    frameCount: number;           // Survey 83, Walk 18, Run 29
    frames: Float32Array;         // frameCount * 24 * (16 local-matrix OR 10 TRS) floats
  }>;
};
```

A small runtime helper (in `mesh.ts` or the module) lazily wraps each `BakedMesh` into a
`Mesh(vertices.buffer, indices, format)` and caches the upload handle (one `uploadMesh`
per mesh / per Fox batch).

---

## 5. CREDITS file content

Create `assets/vendor/CREDITS.md` (and surface the Fox string in-app — it is the only
attribution-REQUIRED asset; Kenney is CC0/optional but courtesy-credited):

```markdown
# Third-party asset credits

## Fox (required — CC-BY-4.0)
\"Fox\" model by PixelMannen (CC0), rigged & animated by tomkranis (CC BY 4.0),
converted to glTF by @AsoboStudio and @scurest (CC BY 4.0).
https://github.com/KhronosGroup/glTF-Sample-Assets

Legal (verbatim, upstream Models/Fox/README.md):
- © 2014, Public. CC0 1.0 Universal — PixelMannen for Model
- © 2014, tomkranis. CC BY 4.0 International — tomkranis for Rigging & Animation
- © 2017, @AsoboStudio and @scurest. CC BY 4.0 International — @AsoboStudio and
  @scurest for Conversion to glTF

## Kenney Car Kit v3.1 (CC0 — credit optional)
Car Kit by Kenney (kenney.nl), CC0 1.0 Universal.

## Kenney Nature Kit v2.1 (CC0 — credit optional)
Nature Kit by Kenney (www.kenney.nl), licensed CC0 1.0.
```

Keep the per-asset `License.txt` / `ATTRIBUTION.txt` files in `assets/vendor/*` as
provenance. The Fox CC-BY string must appear in the running PoC (e.g. an M4/M5 credits
overlay or scene footer).

---

## 6. Blockers + recommended bake order

**Blockers: none.** All assets vendored, both deps already in `package.json`, design
ground truth is `docs/3d-design.md`. Two watch-items (not blockers):
- kenney-car GLBs need the sibling `Textures/colormap.png` for `NodeIO.read` (vendored).
- `upng-js` has no TS types — add a 1-line shim/`@ts-ignore` in the bake.

**Recommended implementation + bake order** (simplest static → skinned centerpiece):

1. **kenney-nature** (M6 props, but build FIRST — simplest path): static, indexed, NO
   texture, NO skin, NO anim. Exercises parse → node-TRS bake → flat-color-into-ABGR →
   28 B interleave → Uint16 indices → base64 module. Validates the common pipeline with
   the least surface area.
2. **kenney-car** (M1/M2/M3 — first textured): adds the texture path (UPNG decode →
   512→256 box downsample → PSM8888 pack) + the 36 B UV/COLOR/NORMAL/POS layout +
   indexed body/wheel + `wheelOffsets` instancing data. Still no skin/anim.
3. **fox** (M4/M5 centerpiece — last, most complex): adds non-indexed source handling,
   the **bone-batch partition** (8/7-batch default), WEIGHTS reorder-to-local-slot,
   skin hierarchy + inverseBindMatrices, and the 24 fps clip resampler
   (Survey 83 / Walk 18 / Run 29). Reuses the texture path from step 2.

Each step writes one `assets-*.ts` + one `index.ts` re-export line; verify with
`bun run typecheck` after each.
```"
  }
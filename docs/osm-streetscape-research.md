# Streetscape → PSP: non-commercial 3D / geo data sources (research)

> Task-1 deliverable for the "bake any real-world place into a walkable PSP scene"
> feature. Produced by a multi-agent research workflow (web search + live Overpass
> probes), then synthesized. The companion implementation is `framework/bake/bake-osm.ts`
> + `framework/games/city3d.js` (demo: Place de l'Étoile / Arc de Triomphe, Paris).

# Non-Commercial 3D / Geo / Streetscape Data Sources for a Walkable OSM City (DreamCart PSP)

## Goal & evaluation axes

We want to bake a real-world streetscape of *any* location into a small (≤1 MB), walkable PSP 3D scene. The data must be: (a) **openly licensed and legal to redistribute baked offline** (no streaming-only ToS), (b) **fit a non-commercial UGC project**, (c) carry enough info (footprints + heights + roads) to extrude recognizable geometry, and (d) be fetchable per small bbox at bake time. The recurring theme below: *photorealistic mesh sources are streaming-only and cannot be shipped offline; open vector footprints + open terrain + CC0 textures are the only legal offline path.*

---

## Category 1 — Raw OSM via Overpass (footprints, heights, roads, water, landuse)

The foundational source. Overpass is a read-only HTTP API over OSM; you POST an Overpass-QL query to `/api/interpreter` and get JSON `{elements:[...]}`.

- **Endpoints / mirrors:** `https://overpass-api.de/api/interpreter` (main FOSSGIS), `https://maps.mail.ru/osm/tools/overpass/api/interpreter` (VK/mail.ru mirror), `https://overpass.private.coffee/api/interpreter` (successor to the retired `overpass.kumi.systems`). Rotate across mirrors. The live probes confirmed overpass-api.de rate-limits/HTML-errors quickly under load and **maps.mail.ru is the reliable fallback** that served every probe query.
- **Etiquette:** stay under ~10k queries/day and ~1 GB/day; send an identifying `User-Agent`; back off on HTTP 429.
- **bbox order is `(south, west, north, east)`** — the opposite of GeoJSON.
- **What you query in one call:** `way["building"]` + `relation["building"]` (footprints + multipolygons), `way["highway"]` (roads/paths), `way/relation["landuse"]`, `natural=water`/`waterway`. End with `out body; >; out skel qt;` (recurse to member nodes) or use `out geom;` for inline lat/lon.
- **3D tags (Simple 3D Buildings / S3DB):** `height` (metres, preferred), `building:levels` (×~3 m fallback), `min_height` (float a `building:part`), `building:part` (when present, the plain outline is NOT rendered in 3D — parts must tile the footprint), `roof:shape` (flat/gabled/hipped/pyramidal/…). **Plan for sparse data:** most buildings carry no height; `building:part`/detailed roofs are rare. Mandatory fallback: ~3 m/level, default ~20 m where untagged, flat roof when `roof:shape` absent — exactly what OSM2World/OSMBuildings/Kendzi3D do.

**License — ODbL 1.0 (the crux).** OSM data is ODbL. The key distinction: a **baked 3D mesh shipped in a game is a "Produced Work", not a Derivative Database** (a player can't extract OSM tags from triangle soup). Consequences: (1) **share-alike does NOT bind the mesh or the game code** — ship them under our own non-commercial UGC terms; (2) **§4.6:** if we publicly distribute the Produced Work we must also make the *underlying OSM extract* available under ODbL (a link to the extract/planet suffices); (3) **attribution required**: display `© OpenStreetMap contributors` + ODbL notice + link to openstreetmap.org/copyright in a Credits/About screen. ODbL has no non-commercial restriction *and* no commercial ban, so a non-commercial UGC project is fully permitted. A city streetscape exceeds the trivial-use exemption, so attribution is mandatory.

---

## Category 2 — OSM→3D mesh tools (so we don't reimplement extrusion)

| Tool | Output | License | Headless/CLI | Geometry quality | Fit |
|---|---|---|---|---|---|
| **OSM2World** | OBJ, glTF, glb, POV, PNG | **MIT** | Yes — `convert -i in.osm -o out.glb` | High: S3DB, height/levels, roof:shape, materials | Best file-exporter; JVM dep at bake only |
| **Blosm / Blender-OSM** | OBJ/glTF/FBX via Blender | Free base (GPL-compat); Pro paid | Partial — Blender `--background` | High; Pro adds textures/UVs | Heavy (full Blender) |
| **OSM Buildings (GL)** | None (WebGL) | Frontend free; backend proprietary; data ODbL | No export (glTF is open issue #237) | Medium 2.5D | Viewer only |
| **Tangram-ES** | None (GLES) | MIT/BSD | No | Medium | Renderer only |
| **F4Map** | None (proprietary) | Proprietary | No | High (closed) | No |
| **Streets GL** | None (WebGL2) | MIT | No | High, modern | Reference only |
| **three.js GLTFExporter** | glTF/OBJ | MIT | Yes (Node/Bun) | N/A (no OSM extrusion) | Only if we extrude ourselves |

**Decision for THIS project:** none of these emit the engine's `BakedMesh` format, and OSM2World adds a JVM dependency plus an OBJ→g3d conversion step. Because the engine has a precise, fixed vertex layout (GE order `[uv][color][normal][pos]`, base64-in-TS modules) and our scenes are tiny (~150 buildings), **we write the extrusion ourselves in `bake-osm.ts`** (pure Bun/TS, may use real trig since it's offline), porting roof/extrusion logic conceptually from Streets GL / OSM Buildings (both MIT/viewer-only). This avoids a toolchain dependency and emits directly to the `BakedMesh` shape `meshFromBaked` expects. OSM2World stays as a fallback reference for roof math.

---

## Category 3 — Global footprint + height datasets (supplements to raw OSM)

| Dataset | Coverage | Height? | Format | License | Fetch bbox |
|---|---|---|---|---|---|
| **Overture Buildings** | Global (conflated OSM+Google+MS+Esri+gov) | Yes — `height`,`num_floors` (varies) | GeoParquet (S3) | ODbL v1.0 (CDLA where no OSM) | `overturemaps download --bbox=… --type=building -f geoparquet` |
| **MS Global ML Footprints** | Global ~1.4B | ~174M w/ height (m) | GeoJSON in `.csv.gz`, quadkey-partitioned | CDLA-Permissive-2.0 (some regional ODbL) | Filter `dataset-links.csv` by L9 quadkey |
| **Google Open Buildings v3** | Africa/LatAm/S+SE Asia (1.8B) | No (2D; height in 2.5D set) | gzip CSV (S3+EE) | CC-BY-4.0 OR ODbL | Earth Engine / source.coop S3 |
| **EUBUCCO v0.1** | EU-27+NO/CH/UK (322M) | ~43% | CSV/GeoPackage | Mixed (ODbL + open-gov) | Per-country files, filter locally |
| **3DBAG** | Netherlands (~10M) | **True LoD1.2/1.3/2.2 3D** | CityJSON/OBJ/3D Tiles | CC BY 4.0 | Tile grid / `tile_download.py` |

**Note:** all are open licenses with attribution/share-alike, not non-commercial-only — they impose obligations but permit our use. **Overture** is the best single supplement: clean GeoParquet, has `height`/`num_floors`, trivial bbox CLI. **For THIS project, raw OSM is sufficient** (the chosen Paris bbox has ~66% native height coverage), but Overture is the designated **optional height-gap filler** when a location's OSM height coverage is thin (e.g. the Shibuya probe at ~50%). 3DBAG is the only true LoD2 roof source but is NL-only, so out of scope for an "any location" feature.

---

## Category 4 — Photoreal 3D tiles (REJECTED for offline)

| Source | Offline bake / redistribute? | Why |
|---|---|---|
| **Google Photorealistic 3D Tiles** | ❌ **forbidden** | Map Tiles API ToS: "must not pre-fetch, index, store, or cache Content"; honor short Cache-Control; offline/geodata-extraction banned. Commercial Maps Platform SKU. |
| **Apple Look Around** | ❌ no data API | Display-only via MapKit; no mesh/image API; Apple-platform-only. |
| **Bing/MS photoreal 3D imagery** | ❌ forbidden | Streaming, no redistributable dataset (but MS *footprints* are open — see Cat 3). |
| **Mapbox 3D / Standard** | ❌ no redistribution | Per-device cache only; "may not redistribute Map Assets from a cache, by proxy, or as static images." |
| **MapTiler 3D (on-prem)** | ⚠️ allowed but **paid** | Self-host datasets exist but are a commercial subscription; underlying data is OSM/open anyway. |
| **Cesium OSM Buildings** | ✅ (data is ODbL) | Global OSM-extruded 3D Tiles via Cesium ion; ODbL passes through. But it's ion-served, not a bulk download, and is just extruded footprints — no advantage over baking OSM ourselves. |

**Verdict:** all genuine photoreal mesh is legally streaming-only — we cannot ship it in a downloadable PSP build. This is the single most-misused class of source ("I downloaded the glTF so I can keep it" — you cannot). Rejected.

---

## Category 5 — Elevation / terrain (optional polish)

At a ~300 m bbox most cities are visually flat (relief usually <1–2 m, below the building noise floor). Treat as optional, worth it only for hilly cities.

| Source | Coverage | License | Offline? |
|---|---|---|---|
| **SRTM (NASA)** | −60°..+60° lat | Public domain | ✅ |
| **Copernicus GLO-30** | Near-global | Free w/ attribution | ✅ |
| **USGS 3DEP/NED** | US | Public domain | ✅ |
| **Mapzen/Nextzen Terrain Tiles (Terrarium)** | Global | Open (mixed upstream, attribution) | ✅ keyless via AWS S3 |

Simplest path: **a single REST call to opentopodata/open-elevation for a 3×3 sample grid** to derive one ground-plane tilt + mean elevation at bake time — not a tile pipeline. Terrarium decode (`elevation_m = (R*256 + G + B/256) − 32768`) is the no-network alternative. **For our Paris/Étoile demo: skip entirely (grid-flat).**

---

## Category 6 — Textures / low-poly kits (the shipped art)

Everything shipped must be **CC0** to keep a clean attribution-free art story (OSM attribution still required for the *data*).

| Asset | License | PSP fit |
|---|---|---|
| **ambientCG** (ex-CC0Textures) | **CC0** (no attribution) | Primary tiled facade/asphalt/brick/roof source; grab 1K tier, downscale to 128–256, albedo only, swizzle. |
| **Poly Haven Textures** | CC0 | Quality backup but 8K overkill. |
| **Kenney City Kit (Roads/Suburban/Commercial)** | **CC0** | Drop-in geometry, same pipeline as existing Kenney nature props; tiny atlas, snap-to-grid. |
| **Quaternius Downtown MegaKit / Modular Street** | CC0 | More building variety; optional. |
| **Mapillary / KartaView street imagery** | **CC-BY-SA 4.0** | Reference ONLY — do NOT bake pixels (ShareAlike+attribution contaminates the CC0 kit). Use for color/proportion/window-rhythm cues. |
| **textures.com free tier** | ❌ NOT CC0 | Avoid for shipping. |

PSP texture envelope: GE rejects >512×512; **256×256 is the sweet spot**, swizzled 16-bit (5650/5551/4444) or 4/8-bit CLUT, tiled via UV>1.

---

## What we'll actually use (recommendation)

1. **Geometry data:** **Raw OSM via Overpass** (maps.mail.ru as the reliable endpoint, overpass-api.de as primary with mail.ru fallback) for footprints + `height`/`building:levels` + road centerlines + water/landuse. Vendor the JSON into `assets/vendor/osm/<place>.*`. Attribute `© OpenStreetMap contributors` (ODbL) in an in-game Credits screen and keep the source extract available under ODbL.
2. **Extrusion:** **write our own** `bake-osm.ts` in Bun/TS (no OSM2World/JVM dependency), emitting directly to the engine's `BakedMesh` base64-in-TS module format. Default ~3 m/level, ~20 m where untagged, flat roofs, optional gabled.
3. **Height gap-fill (optional):** **Overture Buildings** GeoParquet via `overturemaps download --bbox` only when a location's OSM height coverage is thin.
4. **Terrain:** skip for flat demo cities; if needed, a 3×3 opentopodata sample → single ground tilt (offline, baked).
5. **Textures/kits:** **CC0 only** — ambientCG (downscaled to ≤256) for facades/roads, optional Kenney City Kit for instanced road/prop geometry. Street imagery (Mapillary) as visual reference only, never shipped pixels.
6. **Rejected:** all photoreal 3D tiles (Google/Apple/Bing/Mapbox) — streaming-only ToS forbids offline redistribution.

Net legal posture: the **shipped asset bundle is CC0 + procedurally-extruded ODbL-Produced-Work**; the only obligation is an in-game OSM attribution + ODbL notice + a link to the source extract. Fully compatible with a non-commercial UGC PSP project.

---

## Chosen demo location

**Place Charles de Gaulle / Arc de Triomphe (Place de l'Étoile), Paris, France.**

This is the clear winner of the three probed locations (pspFitScore 9, vs Times Square 8.5 and Shibuya 8). The justification is grounded directly in the probe data: (1) **Building count is perfectly in budget without adjustment** — the recommended bbox returns 155 buildings (134 ways + 21 relations), squarely inside the 50–400 PSP budget, so no shrinking or widening is needed (Times Square's tight bbox falls *under* the 50-floor and needs widening to 108; Shibuya is fine at 107). (2) **Height-tag coverage is high and uniform** — ~66% (102/155) carry `height` or `building:levels`, and because this is a French DGI cadastre import the untagged ~34% are uniform Haussmann blocks (~20 m, 4–7 levels) that blend seamlessly under a single ~20 m default — far better visual cohesion than Shibuya's ~50% coverage with a varied-but-half-missing skyline. (3) **Recognizability is unmatched** — the 12 radiating avenues of the Étoile plus the Arc de Triomphe read *instantly* from a chase cam even with crude box geometry, whereas Times Square risks looking like a generic Manhattan block without faked billboards/neon and Shibuya's signature towers (109, Scramble Square) lack tags and render as generic blocks. (4) The Arc itself is `wikidata=Q20974169`-tagged so we can hand-place a hero box (~50 m wide, ~50 m tall) at plaza center. Triangle estimate (~3–4.5k for 155 prisms + Arc hero) sits comfortably under the 8k drawn-tri 30-FPS budget.

**Bbox:** 48.8720,2.2920,48.8756,2.2980 (south,west,north,east) — the probe-recommended Étoile bbox returning 155 buildings + 471 highway ways; use as-is, no resizing.

---

## Implementation design (as built)

## Implementation Plan

Two deliverables: an offline baker `framework/bake/bake-osm.ts` → `framework/src/assets-osm-etoile.ts`, and a runtime game `framework/games/city3d.js`. All paths absolute under `/Users/evan/.superset/worktrees/dreamcart/troubled-spectrograph/`.

### Part A — `framework/bake/bake-osm.ts` (offline, Bun/TS; real trig allowed)

**A1. Fetch + vendor the OSM extract.**
- Query Overpass for bbox `48.8720,2.2920,48.8756,2.2980` with `[out:json][timeout:60]`, selecting `way/relation["building"]`, `way["highway"]`, `way/relation["natural"="water"]`, `way["waterway"]`, then `out body; >; out skel qt;`.
- Use `maps.mail.ru/osm/tools/overpass/api/interpreter` as the reliable endpoint (overpass-api.de rate-limited in every probe), with a descriptive `User-Agent`. Save raw JSON to `assets/vendor/osm/etoile.json` so the bake is reproducible offline and the ODbL source extract is retained (satisfies §4.6). The baker reads the vendored file, not the network, on normal runs.

**A2. Project lon/lat → local meters, centered.**
- Compute bbox center `(lat0, lon0)`. Equirectangular projection (accurate enough at ~300 m): `x = (lon − lon0) * cos(lat0) * 111320`, `z = −(lat − lat0) * 110540` (negate so north = −Z to match the engine's +Z-forward convention used by walk3d). Center is `(0,0)`; the scene spans roughly ±200 m. Resolve `way.nodes` → node lat/lon from the recursed `>` output.

**A3. Buildings → extruded prisms.**
- For each building way (and relation outer ring), build a CCW `[x,z]` footprint. Height: `height` tag if present; else `building:levels × 3`; else default `20`. Round-trip multipolygon relations by taking outer rings only for v1 (inner courtyards rendered solid — acceptable; flagged as risk); skip `building:part` to avoid double-counting (absent in this dataset anyway).
- Extrude with the `extrudeBuilding` pattern from the API cheatsheet: per-edge wall quads with outward normals + a triangle-fan flat roof (replace fan with ear-clipping for concave footprints). Wall color = sampled Haussmann stone palette (e.g. `0xC9BBA0` varied per building by a deterministic hash of the way id, NO `Math.random`), roof = `0x6B5D4F`. Format `FMT_COLOR|FMT_NORMAL|FMT_POS` = 7, stride 28.
- **Hero Arc de Triomphe:** detect `wikidata=Q20974169`; replace its crude footprint with a hand-placed box ~50 m × ~22 m × 50 m tall at plaza center, light stone color, so it reads instantly.

**A4. Roads + ground + water → flat ribbons on Y=0.**
- Aggressively filter highways: keep only the 12 avenue centerlines + the roundabout ring; **drop** `footway`/`service`/`steps`/`crossing` (the 471 count is inflated by these). For each kept polyline, emit a flat quad ribbon of width ~12 m (avenue) / ~30 m (ring) by offsetting each segment ±half-width along its perpendicular; color dark asphalt `0x3A3A3E`, +Y normal, slight Y bias (e.g. `y=0.02`) to avoid z-fight with ground.
- One big ground plane quad covering the bbox, color `0x4A4D44` (Parisian grey-green), built with `TexMeshBuilder` (or `Mesh.plane`-style POS|COLOR). Optional: a thin water quad if any `natural=water` present (none expected at Étoile).

**A5. Emit the `BakedMesh` module(s).**
- Merge ALL buildings into ONE `BakedMesh` ("buildings"), roads+ground into a second ("ground"), to keep draw-call count tiny (≤ ~3 draws). **Split if any single mesh exceeds 65535 vertices** (u16 index ceiling) into `buildings_0`, `buildings_1`, …
- Write interleaved bytes in GE order `[color][normal][pos]` via a `DataView` (color u32 ABGR little-endian via `colorToABGR`, then 3×f32 normal, then 3×f32 pos). Track aabb min/max from footprints.
- Emit `framework/src/assets-osm-etoile.ts` exporting `OSM_ETOILE: Record<string, BakedMesh>` with each mesh's binary fields as `unb64('<base64>')` / `new Uint16Array(unb64('<base64>').buffer)`, mirroring `assets-kenney-nature.ts`. **Verify the emitted module is ≤ ~1.0 MB** (target) — if over, decimate roads / drop low buildings.
- Wire into `package.json` `bake` script: append `&& bun framework/bake/bake-osm.ts`.

### Part B — `framework/games/city3d.js` (walkable runtime)

**B1. Header + direct asset import.**
- `// @title City Walk (Étoile)`, `// @order`, `// @controls`. Import the baked asset DIRECTLY: `import { OSM_ETOILE } from '../src/assets-osm-etoile';` — **never via `../src/index`** (re-export would embed it in every bundle and OOM the PSP at boot).

**B2. Scene setup (model on walk3d.js + outdoor3d.js).**
- `new Scene3D()`; add each `OSM_ETOILE` mesh via `meshFromBaked(...)` as `isStatic: true` `Node3D`s with `bounds` set (local AABB) so the native retained-scene path culls them and node count stops mattering. Set `tint = NO_TINT`.
- `Lighting(0x383c44)` + one `DirectionalLight(new Vec3(-0.5,-1,-0.35), 0xfff2d8)` for sunlit stone. Optional `fog = { color: rgb(0x9a,0xa5,0xb0), near: 80, far: 200 }` for atmospheric depth and to bound the cull far plane.
- `camera.setPerspective(58, SCREEN_W/SCREEN_H, 0.1, 250)`.

**B3. Skinned character + chase cam (reuse walk3d.js wholesale).**
- `SkinnedMesh.fromBaked(FOX)` (import `FOX` directly from `../src/assets-fox`), play `Walk`/`Run` clips. State `{x,z,heading,running}`, Y fixed at 0. Per-frame: turn on Left/Right (`heading += ±1.8*dt`), move on Cross/Square, stride-sync `player.advance(dt*speed/baseSpeed)`, forward = `(dsin(heading), dcos(heading))`. Chase cam: rotate fox AABB center by heading, place eye behind at `foxR*1.6`, height `foxCy + foxR*0.4`, `camera.lookAt(eye, target, +Y)`. Spawn at the foot of the Champs-Élysées looking toward the Arc.

**B4. AABB building collision (replace walk3d's bare ±38 clamp).**
- At setup, precompute each building's world-space AABB once from `position + scale*bounds` (buildings are axis-aligned/static; don't rely on lazily-populated `cwMin/cwMax`). Store `{min,max}` boxes.
- Per frame, after computing proposed `(nx,nz)`: resolve X against all boxes (circle-vs-AABB in XZ, fox radius `r≈foxR*0.5`, push out to nearer face), then resolve Z with the resolved X — separate-axis resolution gives wall-sliding and no tunneling. Keep an outer bbox clamp as the world boundary. Pure `+,-,*,/` and comparisons → deterministic, golden-safe.

**B5. HUD + attribution.**
- Minimal HUD (FPS, gait). **Mandatory:** a Credits/About line `© OpenStreetMap contributors — ODbL` reachable on screen (corner or a toggled panel), satisfying the attribution guideline.

### Part C — Build, goldens, playground

- Bundle: `bun framework/build.ts` produces `runtime/src/game/city3d.js`. Web playground auto-discovers it (`web/build-games.ts` scans `runtime/src/game/`). PSP: `PSPJS_GAME=city3d.js bun runtime/build.ts --release`, or `bun run play psp city3d`.
- **Goldens (required):** add a `SPECS` entry `{ name:"city3d", frames:180, input:(f)=>… }` to `framework/test/golden.ts`, then `UPDATE=1 bun framework/test/golden.ts` to write and commit `framework/test/goldens/city3d.rgbz`, `city3d.dc3d` (3D draw-list, emitted because the scene submits 3D), and the cosmetic `city3d.png`.
- **Validate on PPSSPP** via the `psp-emulator-debug` skill: confirm it boots (decode <30 s, module ≤1 MB), runs ≥30 FPS, and the Étoile reads correctly from the chase cam.

---

## PSP budgets the bake stays under

Hard PSP budgets the bake MUST stay under (from psp-build-memory ref):

- Triangles drawn / scene: ≤ 8,000 (hard ceiling ~15,000). Étoile estimate ~3–4.5k (155 prisms @ ~20–30 tri) + Arc hero + road ribbons — comfortably under.
- Vertices: ≤ 10,000 / scene (hard ~15,000). Per-mesh hard limit 65,535 (u16 index ceiling) — split into keyed sub-meshes if exceeded.
- Draw calls / frame: ≤ 10 (hard ~20). Merge all buildings→1 mesh, roads+ground→1 mesh ⇒ ~2–3 draws.
- Dynamic JS-walked nodes / frame: ≤ ~30 (56 nodes ≈ 10 FPS in pure JS). Make ALL city geometry isStatic so the native retained-scene path removes the node-count cap; only the Fox is dynamic.
- Texture size: ≤ 256×256 PSM_8888 (262,144 bytes) per texture; ≤ ~512 KB total textures / scene. (Étoile v1 is flat per-vertex color → no textures; FOX carries its own 128×128.)
- Baked module (embedded base64 .ts source): target ≤ ~1.0 MB; hard "known-boots" ceiling 1.28 MB (the soldier high-water mark, 15–30 s decode). ⇒ decoded asset payload ≤ ~750 KB (1.0 MB / 1.33 base64 inflation).
- Building count: 50–400 in budget; Étoile = 155, no resize needed.
- Boot decode: keep under the soldier's 15–30 s; smaller module ⇒ faster boot. Module decoded top-level via unb64 into the ~18–20 MB arena (freeMem − 4 MB) alongside QuickJS boot allocations.
- Render target 480×272; aim ≥30 FPS (60 achievable since scene is all-static + merged + native path).

---

## Risks & mitigations

1. OSM endpoint flakiness: overpass-api.de rate-limited/HTML-errored in every probe. Mitigation: use maps.mail.ru/osm/tools/overpass mirror as primary, vendor the JSON to assets/vendor/osm/etoile.json so bake is offline+reproducible and the ODbL source extract is retained (also satisfies §4.6).
2. Multipolygon relation buildings (16 at Étoile) render as solid blocks over courtyards if inner rings ignored. Mitigation v1: outer-ring-only extrusion (acceptable visually); v2: ear-clip with holes. Flagged so it's a known limitation, not a surprise.
3. Baked module exceeds the ~1.0 MB safe target (over → 15–30 s+ boot / OOM risk). Mitigation: merge meshes, decimate roads to 12 avenues + ring only (drop footway/service/steps from the 471 ways), flat per-vertex color (no textures), and assert module size at bake; decimate low/background buildings if still over.
4. Untagged buildings (~34%) and the crude/small real Arc footprint hurt recognizability. Mitigation: ~20 m Haussmann default blends untagged blocks; hand-place an Arc hero box (~50×50 m, wikidata Q20974169) at plaza center for instant readability.
5. Golden determinism: any Math.sin/cos in the RUNTIME path (city3d collision/cam) breaks byte-exact .dc3d goldens (contract.ts guards math/g3d/scene3d/mesh/light). Mitigation: collision uses only +,-,*,/ and comparisons; reuse walk3d's existing dsin/dcos table helpers for heading; baker may use real trig freely (offline). Commit city3d.rgbz + city3d.dc3d.
6. Per-mesh >65,535 vertices overflows u16 indices silently. Mitigation: baker throws and splits into buildings_0/buildings_1 keyed meshes; runtime adds each as its own static node.
7. Concave footprints break the triangle-fan roof (self-intersecting tris). Mitigation: ear-clipping triangulation for non-convex polygons; fan only when convexity verified.
8. Asset re-export trap: importing the baked module via framework/src/index.ts embeds it into EVERY bundle and OOMs the PSP at boot. Mitigation: city3d.js imports OSM_ETOILE and FOX via DIRECT deep paths only, matching walk3d/adventure3d.

---

## API cheat-sheet (DreamCart 3D pipeline)

// === g3d.ts: format constants / packing ===
FMT_POS=0x1 (3×f32)  FMT_COLOR=0x2 (u32 ABGR)  FMT_NORMAL=0x4 (3×f32)  FMT_UV=0x8 (2×f32)  FMT_WEIGHTS=0x10
PSM_5650=0 PSM_5551=1 PSM_4444=2 PSM_8888=3 ; NO_TINT=0xffffffff
vertexStride(format,weightCount=0): sums present fields. POS|COLOR|NORMAL=28; POS|COLOR|UV|NORMAL=36; POS|COLOR=16.
colorToABGR(c=0xRRGGBB, a=255) -> u32 = ((a<<24)|(b<<16)|(g<<8)|r)>>>0  // builders call this internally; you pass 0xRRGGBB
Vertex bytes ALWAYS interleaved GE order: [weights][uv][color][normal][pos], each 4-byte aligned, regardless of bits.

// === mesh.ts: builders ===
new TexMeshBuilder({uv?:boolean=true, normal?:boolean=true})   // toggles fix format for the whole builder
  .vertex(x,y,z,color, u=0,v=0, nx=0,ny=0,nz=0): index         // color=0xRRGGBB; u/v used iff UV; n* iff normal
  .tri(a,b,c) ; .quad(a,b,c,d) // quad => (a,b,c)+(a,c,d)
  .build(): Mesh                // format/stride from toggles
new MeshBuilder().vertex(x,y,z,color).tri/.quad → build() // POS|COLOR only, stride 16
Mesh.plane(w,d,color) // flat Y=0, POS|COLOR, no UV
Mesh.texturedCube(size,tint=0xffffff)

interface BakedMesh { format,stride,vertexCount,weightCount,triCount:number; vertices:Uint8Array;
  indices:Uint16Array; aabb:{min:[n,n,n],max:[n,n,n]} }   // ALL 8 fields required; weightCount=0 for OSM
meshFromBaked(b): Mesh  // = new Mesh(b.vertices.buffer, b.indices, b.format, b.weightCount); NO copy.
  // => b.vertices MUST be tight zero-offset Uint8Array (unb64() and new Uint8Array(mesh.vertices) satisfy; .subarray() does NOT)
new Mesh(vertices:ArrayBuffer, indices:Uint16Array, format, weightCount=0)  // .handle() lazy-uploads+caches

// === material.ts ===
new Texture(pixels:Uint8Array,w,h,psm=PSM_8888)
Texture.solid(w,h,color,a=255)           // flat color, tile via UV>1
Texture.checker(w,h,c0,c1,cells=8)
new Material({texture?:Texture, baseColor?:Color=0xffffff})
// Tiling = UV coords >1.0 on geometry (texture size fixed at upload; host sampler wraps)

// === scene3d.ts ===
new Scene3D()  // .root(Node3D), .camera(Camera seeded setPerspective(60,W/H,0.1,100)), .lighting?, .fog?, .culledCount
  .add(nodeOrOpts): Node3D  // Node3D or Node3DOpts; adds to root
  .invalidateStatic()       // after mutating static nodes
  .fog = { color:0xRRGGBB, near, far }   // present => cull far plane = fog.far
Node3DOpts: { mesh?, material?, skinned?, position?=Vec3(0,0,0), rotation?=Quat.identity(),
  scale?=Vec3(1,1,1), tint?=NO_TINT, isStatic?=false }
node.bounds:AABB {min:[x,y,z],max:[x,y,z]}  // LOCAL space; NOT a ctor opt — assign after construction; needed for cull
  // isStatic+bounds => world matrix + world AABB cached (cw/cwMin/cwMax) after first render
node fields: position,rotation,scale,visible=true,children[],.add(child),.setTint(c),.localMatrix()=Mat4.compose(p,r,s)

// === Camera / light.ts ===
camera.setPerspective(fovDeg,aspect,near,far); camera.lookAt(eye:Vec3,center:Vec3,up:Vec3); camera.recompute()
new Lighting(ambient=0x202020).add(new DirectionalLight(dir:Vec3, color=0xffffff))  // dir normalized once; ≤4 lights (GE cap)

// === b64.ts ===
unb64(s):Uint8Array   // hand-rolled (no atob), returns FRESH tight Uint8Array. Wider: new Uint16Array(unb64(s).buffer)

// === Baker emit (mirror bake-gltf.ts) ===
const b64 = (u8:Uint8Array) => Buffer.from(u8).toString('base64')
const abEmit = (arr) => b64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)) // for f32/u16 blobs
here = new URL('.', import.meta.url).pathname; outDir = here+'../src/'; await Bun.write(outDir+'assets-osm-etoile.ts', out)
// emit per mesh: format,stride,vertexCount,weightCount:0,triCount, aabb:{min:[…],max:[…]} (5-dp),
//   vertices: unb64('<b64>'),  indices: new Uint16Array(unb64('<b64>').buffer)
// THROW if vertexCount > 65535 (u16 ceiling) — split into multiple keyed meshes.

// === Write one vertex (GE order, little-endian) ===
let o = v*stride;
dv.setUint32(o, colorToABGR(rgb,255)>>>0, true); o+=4;             // FMT_COLOR
dv.setFloat32(o,nx,true); dv.setFloat32(o+4,ny,true); dv.setFloat32(o+8,nz,true); o+=12; // FMT_NORMAL
dv.setFloat32(o,px,true); dv.setFloat32(o+4,py,true); dv.setFloat32(o+8,pz,true);        // FMT_POS

// === extrude footprint -> Mesh (CCW [x,z], outward wall normals + flat roof fan) ===
// per edge: nx=ez,nz=-ex (normalize); quad(b0,b1,t1,t0). roof: fan tri(r0,ri,ri+1). Culling DISABLED so winding non-load-bearing.

// === Build / run / goldens ===
// import asset DIRECTLY in framework/games/city3d.js: import { OSM_ETOILE } from '../src/assets-osm-etoile'  (NEVER via index.ts)
// package.json bake: append '&& bun framework/bake/bake-osm.ts'
// bundle: bun framework/build.ts -> runtime/src/game/city3d.js (web playground auto-discovers)
// PSP: PSPJS_GAME=city3d.js bun runtime/build.ts --release   |   bun run play psp city3d
// goldens: add SPECS{name:"city3d",frames:180,input}; UPDATE=1 bun framework/test/golden.ts; commit city3d.rgbz/.dc3d/.png

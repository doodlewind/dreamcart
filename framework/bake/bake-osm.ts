// Bakes a real-world OpenStreetMap streetscape into a compact, PSP-ready DreamCart
// scene module (framework/src/assets-osm-<place>.ts). This is the data path behind
// the "turn any place on Earth into a walkable scene" feature.
//
// Input : a vendored Overpass JSON dump (assets/vendor/osm/<place>.json) — buildings
//         (footprints + height/building:levels tags), roads, parks, water.
// Output: an N×N grid of merged, lit, flat-colored BakedMesh chunks (POS|COLOR|NORMAL,
//         same 28-byte layout as the Kenney nature props — no textures, so zero VRAM
//         texture cost), plus per-building AABBs for collision, a street spawn point,
//         and the ODbL attribution string.
//
// This is an OFFLINE Bun step: real trig / earcut / hashing are fine here; the RUNTIME
// only array-looks-up the decoded bytes. Geometry blobs are emitted base64 (decoded by
// framework/src/b64.ts at load) so the .ts stays compact. Re-running is deterministic.
//
// Map data © OpenStreetMap contributors, licensed under the ODbL 1.0.
//   https://www.openstreetmap.org/copyright
//
// Run:  bun framework/bake/bake-osm.ts            (bakes the ACTIVE location)
//       bun framework/bake/bake-osm.ts etoile     (override which location)
import { TexMeshBuilder } from '../src/mesh';
import { writeFileSync, readFileSync } from 'fs';

// ───────────────────────── location catalogue ─────────────────────────
// `center` is the local-origin (0,0) of the scene; pick it at the most iconic
// point. `defaultHeight` is used for untagged buildings. `maxHeight` caps wild
// skyscrapers so one tower doesn't dwarf the walkable street. `chunks` is the grid
// resolution for frustum culling. `footways` keeps sidewalk/footpath ribbons.
interface LocConf {
  file: string;
  name: string;
  title: string; // ASCII HUD title (the 8×8 PSP font can't draw accents/CJK)
  hero?: string; // hand-modeled landmark the game adds (e.g. 'arc'); none if unset
  center: { lat: number; lon: number };
  defaultHeight: number;
  maxHeight: number;
  spanMeters: number; // half-extent used for the ground plane + fog
  chunks: number;
  footways: boolean;
  service: boolean; // include service roads/alleys
  skipNames?: string[]; // building names to drop (replaced by a hand-placed hero)
  ground: number; // RRGGBB
  sky: number;
}

const LOCATIONS: Record<string, LocConf> = {
  etoile: {
    file: 'etoile.json',
    name: "Place de l'Étoile · Arc de Triomphe, Paris",
    title: 'PARIS - ARC DE TRIOMPHE',
    hero: 'arc',
    center: { lat: 48.8738, lon: 2.295 },
    defaultHeight: 19, // Haussmann blocks ~6 storeys
    maxHeight: 60,
    spanMeters: 230,
    chunks: 6, // smaller cells (~77 m) so per-chunk distance culling can't pop a
    // chunk to black while its near edge is still on-screen (was 4 → 115 m cells).
    footways: false, // the 12 avenues + ring read the Étoile; footways bloat the module
    service: false,
    skipNames: ['Arc de Triomphe'], // replaced by a hand-modeled hero arch in city3d.js
    ground: 0x6f7378, // pale Parisian stone
    sky: 0x9fb4c8,
  },
  'times-square': {
    file: 'times-square.json',
    name: 'Times Square, New York',
    title: 'NEW YORK - TIMES SQUARE',
    center: { lat: 40.758, lon: -73.9855 },
    defaultHeight: 30,
    maxHeight: 120,
    spanMeters: 200,
    chunks: 3,
    footways: false,
    service: true,
    ground: 0x4a4d52,
    sky: 0x6b7686,
  },
  shibuya: {
    file: 'shibuya.json',
    name: 'Shibuya Crossing, Tokyo',
    title: 'TOKYO - SHIBUYA',
    center: { lat: 35.6595, lon: 139.7005 },
    defaultHeight: 22,
    maxHeight: 90,
    spanMeters: 200,
    chunks: 3,
    footways: false,
    service: true,
    ground: 0x55585e,
    sky: 0x8a96a4,
  },
  shanghai: {
    file: 'shanghai.json',
    name: 'Lujiazui · Shanghai (supertall trio)',
    title: 'SHANGHAI - LUJIAZUI',
    center: { lat: 31.2345, lon: 121.5038 },
    defaultHeight: 42, // Lujiazui is mostly high-rise; few low blocks
    maxHeight: 240, // cap the 400-630 m supertalls so the street stays walkable
    spanMeters: 230,
    chunks: 6,
    footways: false,
    service: true,
    ground: 0x55585e, // grey granite plazas
    sky: 0x9aa6b2, // Shanghai haze
  },
};

// Active location: CLI arg wins, else the default below.
const ACTIVE = process.argv[2] && LOCATIONS[process.argv[2]] ? process.argv[2] : 'etoile';
const L = LOCATIONS[ACTIVE];

const here = new URL('.', import.meta.url).pathname;
const vendor = here + '../../assets/vendor/osm/';
const outDir = here + '../src/';

// ───────────────────────── projection: lat/lon → local meters ─────────────────────────
// Equirectangular about the scene center. +X = east, +Z = SOUTH (so north is -Z),
// Y = up. Accurate to <1% over a few hundred metres — perfect at PSP fidelity.
const R = 6378137; // WGS84 mean radius (m)
const lat0 = (L.center.lat * Math.PI) / 180;
const mPerDegLat = (Math.PI / 180) * R;
const mPerDegLon = (Math.PI / 180) * R * Math.cos(lat0);
function project(lat: number, lon: number): [number, number] {
  const x = (lon - L.center.lon) * mPerDegLon;
  const z = -(lat - L.center.lat) * mPerDegLat;
  return [x, z];
}

// ───────────────────────── helpers ─────────────────────────
type Pt = [number, number]; // [x, z] in metres

/** Signed area of an XZ polygon (CCW positive). */
function signedArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[(i + 1) % n];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

/** Ear-clipping triangulation of a simple XZ polygon → index triples into `p`. */
function earcut(p: Pt[]): number[] {
  const n = p.length;
  if (n < 3) return [];
  // Work on an index ring; ensure CCW so the inside test is consistent.
  const idx = p.map((_, i) => i);
  if (signedArea(p) < 0) idx.reverse();
  const tris: number[] = [];
  const area2 = (a: Pt, b: Pt, c: Pt) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (a: Pt, b: Pt, c: Pt, pt: Pt) => {
    const d1 = area2(a, b, pt);
    const d2 = area2(b, c, pt);
    const d3 = area2(c, a, pt);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = p[ia];
      const b = p[ib];
      const c = p[ic];
      if (area2(a, b, c) <= 0) continue; // reflex or degenerate
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(a, b, c, p[j])) {
          ear = false;
          break;
        }
      }
      if (ear) {
        tris.push(ia, ib, ic);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break; // non-simple polygon — bail with what we have
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

/** Building height in metres from OSM tags, with fallbacks + a cap. */
function buildingHeight(tags: Record<string, string>): number {
  let h = 0;
  if (tags.height) h = parseFloat(tags.height); // "25", "25 m", "25.5"
  else if (tags['building:levels']) h = parseFloat(tags['building:levels']) * 3.2 + 1.5;
  if (!(h > 0)) h = L.defaultHeight * (0.8 + ((hash(tags.name || '') % 40) / 100));
  return Math.min(h, L.maxHeight);
}

/** Small deterministic string hash for stable per-building variation. */
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** A warm/stone facade palette; pick deterministically per building. */
const FACADE = [
  0xcdbfa6, 0xc6b59a, 0xbfb097, 0xd2c4ab, 0xb8a98f, 0xc9bda4,
  0xb6b0a6, 0xc2bbae, 0xad9f86, 0xd8cbb0, 0xa89a82, 0xbcae93,
];
function facadeColor(id: string): number {
  return FACADE[hash(id) % FACADE.length];
}
/** Darken an RRGGBB color by `f` (0..1). */
function darken(c: number, f: number): number {
  const r = ((c >> 16) & 255) * (1 - f);
  const g = ((c >> 8) & 255) * (1 - f);
  const b = (c & 255) * (1 - f);
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

/** Road half-width (m) + color by highway class; null = skip this way. */
function roadStyle(tags: Record<string, string>): { hw: number; color: number; y: number } | null {
  const t = tags.highway;
  if (!t) return null;
  if (t === 'steps' || t === 'elevator' || t === 'construction') return null;
  if (!L.service && t === 'service') return null;
  if (!L.footways && (t === 'footway' || t === 'path' || t === 'cycleway' || t === 'pedestrian'))
    return null;
  const asphalt = 0x3a3d42;
  const paving = 0x6c6f76; // sidewalk / pedestrian
  switch (t) {
    case 'motorway': case 'trunk': case 'primary':
      return { hw: 8, color: asphalt, y: 0.04 };
    case 'secondary':
      return { hw: 6.5, color: asphalt, y: 0.04 };
    case 'tertiary': case 'residential': case 'unclassified': case 'living_street':
      return { hw: 5, color: asphalt, y: 0.04 };
    case 'service':
      return { hw: 3, color: 0x44474c, y: 0.03 };
    case 'pedestrian':
      return { hw: 5, color: paving, y: 0.05 };
    case 'footway': case 'path': case 'cycleway':
      return { hw: 1.8, color: paving, y: 0.05 };
    default:
      return { hw: 4, color: asphalt, y: 0.04 };
  }
}

// ───────────────────────── parse OSM ─────────────────────────
interface OsmEl {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

const raw = JSON.parse(readFileSync(vendor + L.file, 'utf8')) as { elements: OsmEl[] };

interface Building { ring: Pt[]; height: number; color: number; id: string }
interface Road { line: Pt[]; hw: number; color: number; y: number }
interface Area { ring: Pt[]; color: number; y: number }

const buildings: Building[] = [];
const roads: Road[] = [];
const areas: Area[] = [];

function ringFromGeom(geom: { lat: number; lon: number }[]): Pt[] {
  const pts = geom.map((g) => project(g.lat, g.lon));
  // Drop the duplicated closing vertex OSM ways carry.
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) pts.pop();
  }
  return pts;
}

for (const e of raw.elements) {
  const tags = e.tags || {};
  if (tags.name && L.skipNames && L.skipNames.includes(tags.name)) continue; // hero-replaced
  if (tags.building && e.geometry && e.geometry.length >= 4) {
    const ring = ringFromGeom(e.geometry);
    if (ring.length < 3) continue;
    buildings.push({
      ring,
      height: buildingHeight(tags),
      color: facadeColor(String(e.id) + (tags.name || '')),
      id: tags.name ? tags.name : 'b' + e.id,
    });
  } else if (tags.building && e.type === 'relation' && e.members) {
    // Multipolygon building: take the outer ring(s) only (ignore courtyards/holes).
    for (const m of e.members) {
      if (m.role === 'outer' && m.geometry && m.geometry.length >= 4) {
        const ring = ringFromGeom(m.geometry);
        if (ring.length < 3) continue;
        buildings.push({
          ring,
          height: buildingHeight(tags),
          color: facadeColor(String(e.id) + m.role + (tags.name || '')),
          id: tags.name ? tags.name : 'r' + e.id,
        });
      }
    }
  } else if (tags.highway && e.geometry && e.geometry.length >= 2) {
    const st = roadStyle(tags);
    if (!st) continue;
    roads.push({ line: e.geometry.map((g) => project(g.lat, g.lon)), hw: st.hw, color: st.color, y: st.y });
  } else if (e.geometry && e.geometry.length >= 4) {
    if (tags.leisure === 'park' || /grass|forest|meadow|recreation/.test(tags.landuse || '')) {
      const ring = ringFromGeom(e.geometry);
      if (ring.length >= 3) areas.push({ ring, color: 0x4f7a44, y: 0.06 });
    } else if (tags.natural === 'water') {
      const ring = ringFromGeom(e.geometry);
      if (ring.length >= 3) areas.push({ ring, color: 0x3b6b8c, y: 0.05 });
    }
  }
}

console.log(`[${ACTIVE}] parsed: ${buildings.length} buildings, ${roads.length} roads, ${areas.length} areas`);

// ───────────────────────── procedural wrapping textures ─────────────────────────
// Two small power-of-two textures the GE samples in REPEAT + Modulate (they
// MULTIPLY the per-vertex colour). Mostly bright so the baked façade/road colour
// shows through; darker features (window glass, asphalt grit) read as detail. They
// WRAP, so one quad with UV 0..N tiles them N times — windows/paving repeat with
// ZERO extra geometry (an atlas can't: the GE wraps the WHOLE texture, not a sub-rect).
const TEX_W = 64;
const TEX_H = 64;
function texHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}
/** A tileable façade cell: near-white wall (lets the building tint show) + one
 * framed window with bluish glass. UV 0..(bays,floors) tiles it into a window grid. */
function paintFacade(): Uint8Array {
  const px = new Uint8Array(TEX_W * TEX_H * 4);
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      const fx = x / TEX_W;
      const fy = y / TEX_H;
      let r = 250, g = 247, b = 240; // wall — near white so tint modulates through
      if (fx > 0.20 && fx < 0.80 && fy > 0.16 && fy < 0.82) {
        const frame = fx < 0.27 || fx > 0.73 || fy < 0.22 || fy > 0.76;
        if (frame) { r = 116; g = 112; b = 104; } // mullions / frame
        else {
          const sheen = Math.abs(fx - (1 - fy)) < 0.12 ? 48 : 0; // diagonal glint
          r = 80 + sheen; g = 98 + sheen; b = 126 + sheen; // glass
        }
      } else if (fy >= 0.82 && fy < 0.90) { r = 176; g = 170; b = 160; } // floor ledge
      const o = (y * TEX_W + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  return px;
}
/** Tileable gritty pavement; modulated dark by road colour, mid-grey by ground. */
function paintPavement(): Uint8Array {
  const px = new Uint8Array(TEX_W * TEX_H * 4);
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      let v = 190 + (texHash(x, y) * 50 - 25);
      if (texHash(x * 3 + 1, y * 3 + 7) > 0.93) v -= 55; // aggregate fleck
      if (x % 32 === 0 || y % 32 === 0) v -= 16; // faint slab seam
      v = v < 45 ? 45 : v > 235 ? 235 : v;
      const o = (y * TEX_W + x) * 4;
      px[o] = v; px[o + 1] = v; px[o + 2] = (v * 0.97) | 0; px[o + 3] = 255;
    }
  }
  return px;
}
const FACADE_PX = paintFacade();
const PAVE_PX = paintPavement();
const BAY_W = 4.2; // metres per window bay (horizontal façade tiling)
const FLOOR_H = 3.3; // metres per floor (vertical façade tiling)
const PAVE_TILE = 6.0; // metres per pavement tile

// ───────────────────────── geometry emit into chunk × group builders ─────────────────────────
// Each chunk splits into 3 sub-meshes by texture so every mesh has ONE material:
//   group 0 = walls   → facade texture   (texId 0)
//   group 1 = roads   → pavement texture (texId 1)
//   group 2 = roofs+parks → untextured flat colour (texId -1)
const half = L.spanMeters;
const cell = (half * 2) / L.chunks;
const NG = 3;
const G_WALL = 0;
const G_PAVE = 1;
const G_FLAT = 2;
const TEX_OF = [0, 1, -1]; // group → texId
const NC = L.chunks * L.chunks;
const builders: TexMeshBuilder[] = [];
for (let i = 0; i < NC * NG; i++) builders.push(new TexMeshBuilder({ uv: true, normal: true }));
const bounds = builders.map(() => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
}));

const slot = (ci: number, g: number) => ci * NG + g;
function chunkIndex(x: number, z: number): number {
  let cx = Math.floor((x + half) / cell);
  let cz = Math.floor((z + half) / cell);
  cx = Math.max(0, Math.min(L.chunks - 1, cx));
  cz = Math.max(0, Math.min(L.chunks - 1, cz));
  return cz * L.chunks + cx;
}
/** Add a vertex to chunk `ci`'s group-`g` sub-mesh, growing that sub-mesh's bounds. */
function V(ci: number, g: number, x: number, y: number, z: number, color: number, u: number, v: number, nx: number, ny: number, nz: number): number {
  const s = slot(ci, g);
  const b = bounds[s];
  if (x < b.min[0]) b.min[0] = x;
  if (y < b.min[1]) b.min[1] = y;
  if (z < b.min[2]) b.min[2] = z;
  if (x > b.max[0]) b.max[0] = x;
  if (y > b.max[1]) b.max[1] = y;
  if (z > b.max[2]) b.max[2] = z;
  return builders[s].vertex(x, y, z, color, u, v, nx, ny, nz);
}

const aabbList: number[] = []; // [minx, minz, maxx, maxz] per building (collision)

// --- buildings: extrude footprint into outward-lit, window-textured walls + roof ---
let clamped = 0;
for (const bld of buildings) {
  const ring = bld.ring;
  const n = ring.length;
  // Centroid for outward-normal sign + chunk assignment.
  let cx = 0;
  let cz = 0;
  let bbminx = Infinity, bbminz = Infinity, bbmaxx = -Infinity, bbmaxz = -Infinity;
  for (const p of ring) {
    cx += p[0]; cz += p[1];
    if (p[0] < bbminx) bbminx = p[0];
    if (p[1] < bbminz) bbminz = p[1];
    if (p[0] > bbmaxx) bbmaxx = p[0];
    if (p[1] > bbmaxz) bbmaxz = p[1];
  }
  cx /= n; cz /= n;
  // Skip buildings whose centroid is well outside the scene span (Overpass returns
  // a little beyond the bbox).
  if (Math.abs(cx) > half + 30 || Math.abs(cz) > half + 30) continue;
  // Decimate tiny footprints (kiosks/sheds/map clutter): they cost vertices but add
  // no skyline. Frees the module budget for parapets on the buildings that matter.
  if (Math.abs(signedArea(ring)) < 40) continue;
  const ci = chunkIndex(cx, cz);
  const h = bld.height;
  const floors = Math.max(1, Math.round(h / FLOOR_H)); // snap vertical UV to whole floors
  const roofCol = darken(bld.color, 0.22);

  // Walls: one quad per edge, normal = outward; UV tiles the window texture by
  // bays (length / BAY_W) × floors so it reads as rows of windows for free.
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    let nx = b[1] - a[1];
    let nz = -(b[0] - a[0]); // perpendicular to the edge
    const ln = Math.hypot(nx, nz) || 1;
    nx /= ln; nz /= ln;
    // Flip to point away from the centroid (outward).
    const mx = (a[0] + b[0]) / 2 - cx;
    const mz = (a[1] + b[1]) / 2 - cz;
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    const edgeLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const uu = Math.max(1, Math.round(edgeLen / BAY_W)); // whole bays
    const base = darken(bld.color, 0.16); // ground-floor a touch darker
    const i0 = V(ci, G_WALL, a[0], 0, a[1], base, 0, 0, nx, 0, nz);
    const i1 = V(ci, G_WALL, b[0], 0, b[1], base, uu, 0, nx, 0, nz);
    const i2 = V(ci, G_WALL, b[0], h, b[1], bld.color, uu, floors, nx, 0, nz);
    const i3 = V(ci, G_WALL, a[0], h, a[1], bld.color, 0, floors, nx, 0, nz);
    builders[slot(ci, G_WALL)].quad(i0, i1, i2, i3);
  }
  // Roof: triangulated cap facing up (untextured flat colour).
  const tris = earcut(ring);
  const top: number[] = ring.map((p) => V(ci, G_FLAT, p[0], h, p[1], roofCol, 0, 0, 0, 1, 0));
  for (let t = 0; t + 2 < tris.length; t += 3) {
    builders[slot(ci, G_FLAT)].tri(top[tris[t]], top[tris[t + 1]], top[tris[t + 2]]);
  }
  // Collision AABB (clamped to scene span).
  aabbList.push(
    Math.max(bbminx, -half), Math.max(bbminz, -half),
    Math.min(bbmaxx, half), Math.min(bbmaxz, half),
  );
  if (bbmaxx > half || bbminx < -half || bbmaxz > half || bbminz < -half) clamped++;
}

// --- roads: ribbon of pavement-textured quads, one per polyline segment ---
for (const r of roads) {
  for (let i = 0; i + 1 < r.line.length; i++) {
    const a = r.line[i];
    const b = r.line[i + 1];
    let dx = b[0] - a[0];
    let dz = b[1] - a[1];
    const ln = Math.hypot(dx, dz);
    if (ln < 0.01) continue;
    dx /= ln; dz /= ln;
    const px = -dz * r.hw; // left offset
    const pz = dx * r.hw;
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    if (Math.abs(mx) > half + 10 || Math.abs(mz) > half + 10) continue;
    const ci = chunkIndex(mx, mz);
    const c = r.color;
    const wu = (2 * r.hw) / PAVE_TILE; // tile across width
    const lv = ln / PAVE_TILE; // tile along length
    const i0 = V(ci, G_PAVE, a[0] - px, r.y, a[1] - pz, c, 0, 0, 0, 1, 0);
    const i1 = V(ci, G_PAVE, a[0] + px, r.y, a[1] + pz, c, wu, 0, 0, 1, 0);
    const i2 = V(ci, G_PAVE, b[0] + px, r.y, b[1] + pz, c, wu, lv, 0, 1, 0);
    const i3 = V(ci, G_PAVE, b[0] - px, r.y, b[1] - pz, c, 0, lv, 0, 1, 0);
    builders[slot(ci, G_PAVE)].quad(i0, i1, i2, i3);
  }
}

// --- parks / water: flat triangulated fills (untextured) ---
for (const ar of areas) {
  let cx = 0, cz = 0;
  for (const p of ar.ring) { cx += p[0]; cz += p[1]; }
  cx /= ar.ring.length; cz /= ar.ring.length;
  if (Math.abs(cx) > half + 20 || Math.abs(cz) > half + 20) continue;
  const ci = chunkIndex(cx, cz);
  const tris = earcut(ar.ring);
  const vs = ar.ring.map((p) => V(ci, G_FLAT, p[0], ar.y, p[1], ar.color, 0, 0, 0, 1, 0));
  for (let t = 0; t + 2 < tris.length; t += 3) {
    builders[slot(ci, G_FLAT)].tri(vs[tris[t]], vs[tris[t + 1]], vs[tris[t + 2]]);
  }
}

// ───────────────────────── spawn point: a free spot on a road near centre ─────────────────────────
function insideAnyBuilding(x: number, z: number, margin: number): boolean {
  for (let i = 0; i < aabbList.length; i += 4) {
    if (
      x > aabbList[i] - margin && x < aabbList[i + 2] + margin &&
      z > aabbList[i + 1] - margin && z < aabbList[i + 3] + margin
    ) return true;
  }
  return false;
}
let spawn: [number, number, number] = [0, 0, 0];
{
  // Prefer the road vertex closest to (0,0) that is clear of buildings.
  let best = Infinity;
  let bx = 0, bz = 0;
  for (const r of roads) {
    for (const p of r.line) {
      if (Math.abs(p[0]) > half - 8 || Math.abs(p[1]) > half - 8) continue;
      if (insideAnyBuilding(p[0], p[1], 1.5)) continue;
      const d = p[0] * p[0] + p[1] * p[1];
      if (d < best) { best = d; bx = p[0]; bz = p[1]; }
    }
  }
  // Face toward the scene centre (the Arc / crossing).
  const heading = Math.atan2(-bx, -bz); // forward = (sin h, cos h) → points to origin
  spawn = [bx, bz, heading];
}

// ───────────────────────── build sub-meshes + emit module ─────────────────────────
const b64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');

interface MeshOut {
  texId: number; vertexCount: number; triCount: number;
  vertices: string; indices: string; aabb: { min: number[]; max: number[] };
}
const meshesOut: MeshOut[] = [];
let totalV = 0;
let totalT = 0;
let fmt = 0x000f;
let stride = 32;
for (let ci = 0; ci < NC; ci++) {
  for (let g = 0; g < NG; g++) {
    const s = slot(ci, g);
    const mesh = builders[s].build();
    const vc = mesh.vertexCount;
    if (vc === 0) continue; // empty sub-mesh
    if (vc > 65535) throw new Error(`chunk ${ci} group ${g} has ${vc} verts (>65535 u16 limit) — raise chunk count`);
    fmt = mesh.format;
    stride = mesh.vertices.byteLength / vc;
    meshesOut.push({
      texId: TEX_OF[g],
      vertexCount: vc,
      triCount: mesh.indices.length / 3,
      vertices: b64(new Uint8Array(mesh.vertices)),
      indices: b64(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength)),
      aabb: bounds[s],
    });
    totalV += vc;
    totalT += mesh.indices.length / 3;
  }
}
// Add in texId order (0 façade, 1 pavement, -1 flat) so the host binds each texture
// once for a whole run of meshes instead of toggling per chunk.
meshesOut.sort((a, b) => a.texId - b.texId);

const aabbF32 = new Float32Array(aabbList);
const round = (n: number) => Math.round(n * 1000) / 1000;
const meshLiteral = meshesOut
  .map(
    (c) =>
      `  { texId: ${c.texId}, vertexCount: ${c.vertexCount}, triCount: ${c.triCount},\n` +
      `    aabb: { min: [${c.aabb.min.map(round).join(', ')}], max: [${c.aabb.max.map(round).join(', ')}] },\n` +
      `    vertices: '${c.vertices}',\n` +
      `    indices: '${c.indices}' },`,
  )
  .join('\n');

const outName = `assets-osm-${ACTIVE.replace(/[^a-z0-9]/g, '-')}`;
const constName = 'OSM_' + ACTIVE.toUpperCase().replace(/[^A-Z0-9]/g, '_');

const ts = `// AUTO-GENERATED by framework/bake/bake-osm.ts — DO NOT EDIT.
// Real-world streetscape baked from OpenStreetMap into a walkable PSP scene.
// Place: ${L.name}
// Source bbox center: ${L.center.lat}, ${L.center.lon}
//
// Map data © OpenStreetMap contributors, licensed under the ODbL 1.0
//   https://www.openstreetmap.org/copyright
//
// ${meshesOut.length} sub-meshes · ${totalV} verts · ${totalT} tris · ${buildings.length} buildings.
// Format ${fmt} (UV|COLOR|NORMAL|POS), stride ${stride}. Each sub-mesh's texId selects
// a wrapping texture: 0 = façade/windows (walls), 1 = pavement (roads), -1 = untextured
// flat colour (roofs/parks). Windows + paving tile via UV (GE REPEAT), no extra geometry.
import { unb64 } from './b64';
import type { BakedMesh } from './mesh';

export interface OsmMesh extends BakedMesh { texId: number; }

interface RawMesh {
  texId: number; vertexCount: number; triCount: number;
  aabb: { min: number[]; max: number[] };
  vertices: string; indices: string;
}

const FORMAT = ${fmt};
const STRIDE = ${stride};

const RAW_MESHES: RawMesh[] = [
${meshLiteral}
];

function decode(c: RawMesh): OsmMesh {
  const vertices = unb64(c.vertices);
  const ib = unb64(c.indices);
  const indices = new Uint16Array(ib.buffer, ib.byteOffset, ib.byteLength / 2);
  return {
    texId: c.texId, format: FORMAT, stride: STRIDE, vertexCount: c.vertexCount, weightCount: 0,
    vertices, indices, triCount: c.triCount,
    aabb: { min: [c.aabb.min[0], c.aabb.min[1], c.aabb.min[2]], max: [c.aabb.max[0], c.aabb.max[1], c.aabb.max[2]] },
  };
}

export const ${constName} = {
  name: ${JSON.stringify(L.name)},
  title: ${JSON.stringify(L.title)},
  hero: ${L.hero ? JSON.stringify(L.hero) : 'undefined'},
  attribution: '© OpenStreetMap contributors (ODbL)',
  center: { lat: ${L.center.lat}, lon: ${L.center.lon} },
  /** [x, z, heading] — a clear spot on a street near the centre, facing in. */
  spawn: [${round(spawn[0])}, ${round(spawn[1])}, ${round(spawn[2])}] as [number, number, number],
  span: ${L.spanMeters},
  groundColor: 0x${L.ground.toString(16).padStart(6, '0')},
  skyColor: 0x${L.sky.toString(16).padStart(6, '0')},
  buildingCount: ${buildings.length},
  /** Per-building XZ collision rectangles: [minX, minZ, maxX, maxZ] × N. */
  buildingAABBs: unb64('${b64(new Uint8Array(aabbF32.buffer))}'),
  /** Wrapping (REPEAT) textures, PSM_8888. texId 0 walls, texId 1 roads + ground. */
  facade: { width: ${TEX_W}, height: ${TEX_H}, psm: 3, pixels: unb64('${b64(FACADE_PX)}') },
  pavement: { width: ${TEX_W}, height: ${TEX_H}, psm: 3, pixels: unb64('${b64(PAVE_PX)}') },
  /** Lazily-decoded scene sub-meshes (static, culled; grouped by texId). */
  meshes(): OsmMesh[] { return RAW_MESHES.map(decode); },
};
`;

// Hard guard: stay under the proven ~1.28 MB single-module boot ceiling (the soldier
// high-water mark), with margin. Over this, decimate background buildings.
if (ts.length > 1.18 * 1024 * 1024) {
  throw new Error(`module ${(ts.length / 1024 / 1024).toFixed(2)} MB exceeds the PSP-boot budget — decimate geometry`);
}
writeFileSync(outDir + outName + '.ts', ts);
const kb = (ts.length / 1024).toFixed(1);
console.log(
  `[${ACTIVE}] wrote framework/src/${outName}.ts  (${kb} KB, ${meshesOut.length} sub-meshes, ${totalV} verts, ${totalT} tris)`,
);
console.log(`  spawn = [${round(spawn[0])}, ${round(spawn[1])}], building AABBs = ${aabbList.length / 4}, clamped to span = ${clamped}`);

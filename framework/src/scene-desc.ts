// Data-driven 3D scenes. A SceneDescriptor declares mesh PROTOTYPES (box / plane /
// baked) plus the ENTITIES and INSTANCE GROUPS that place them, and buildScene()
// turns it into a Scene3D. The whole point is byte-exact parity with the equivalent
// hand-written onEnter: buildScene adds nodes (and merges, if asked) in EXACTLY the
// declaration order, sharing ONE Mesh per prototype — so the engine's per-frame
// draw list (.dc3d) is identical whether a game hand-builds its scene or loads it
// from a descriptor. The bake side (framework/bake/bake-scene.ts) serializes a
// descriptor to the .dcpak store; loadScene() reads it back on any host.
//
// BYTE-EXACT SCOPE: buildScene() (in-memory) reproduces a hand-built scene's draw
// list byte-for-byte for ANY transform — it feeds the same f64 numbers through the
// same Mat4.compose. The bake -> loadScene() ROUND TRIP, however, is byte-exact
// only for TRANSLATION (and per-axis tint/flags): xforms are stored as f32, and a
// pure translation is copied verbatim into the model matrix's translation column,
// which the wire encoder truncates to f32 anyway (f32 truncation is idempotent, so
// the loaded path is bit-identical to f64 literals). A baked rotation/scale is
// re-composed from f32-rounded euler/scale at load, and the f32-truncated PRODUCT
// can differ from the inline f64 product for some values (see framework/test/
// scene-desc.test.ts case (c)). racing3d — the only shipped scene — is translation-only,
// so its golden is exact. Treat rotation/scale via loadScene as visually-equal, not
// byte-guaranteed, until the blob stores the composed matrix instead of euler.
//
// Order contract (must match the games' onEnter and stay stable for the golden):
//   1. entities[]      — one node each, in array order
//   2. instances[]     — each group in array order; within a group, each transform
//                        in order, ALL sharing the group's single prototype Mesh.
// A group MAY set merge:true to bake its instances into ONE static mesh via
// mergeMeshes (the scenery-clump fast path); by default each instance is its own
// node (matching racing3d's per-cone nodes, which keep the cone a single shared
// upload drawn at many model matrices).
import { Mesh, mergeMeshes } from './mesh';
import { Scene3D, Node3D } from './scene3d';
import { Vec3, Quat, Mat4 } from './math';
import { dcU8, dcF32 } from './dcpak';

// A box prototype: w/h/d + the 6 face colors (RRGGBB), exactly Mesh.box's args.
export type MeshProto =
  | { kind: 'box'; size: [number, number, number]; colors: number[] }
  | { kind: 'plane'; size: [number, number]; color: number }
  | { kind: 'baked'; key: string };

// One placed node referencing a prototype by key. position/rotation/scale default
// to origin / identity / 1, matching Node3D's own defaults.
export interface EntityDesc {
  proto: string;
  position?: [number, number, number];
  rotation?: [number, number, number]; // euler radians (XYZ), -> Quat.fromEuler
  scale?: [number, number, number];
  tint?: number; // RRGGBB; omitted -> untinted
  isStatic?: boolean;
  id?: string; // optional handle so a game can fetch the built node by name
}

// Many placements of ONE prototype. Each entry is a [x,y,z] position (the common
// case — scattered scenery / cones). For full transforms use entities instead.
export interface InstanceGroup {
  proto: string;
  positions: [number, number, number][];
  tint?: number;
  isStatic?: boolean;
  // Merge all instances into ONE static mesh (mergeMeshes) — a single GE draw for
  // a scenery clump. Off by default: each instance stays its own node so the
  // prototype is uploaded once and drawn at many model matrices.
  merge?: boolean;
  id?: string; // when merged, the id of the resulting single node
}

export interface AABBDesc { min: [number, number, number]; max: [number, number, number]; }

export interface SceneDescriptor {
  camera?: { fovDeg: number; aspect: number; near: number; far: number };
  fog?: { color: number; near: number; far: number };
  lighting?: { ambient: number; lights: { color: number; dir: [number, number, number] }[] };
  prototypes: Record<string, MeshProto>;
  entities?: EntityDesc[];
  instances?: InstanceGroup[];
  // World-space AABB colliders a game can clamp/slide against; passed through.
  colliders?: AABBDesc[];
}

export interface BuiltScene {
  scene: Scene3D;
  /** Nodes registered with an `id` (entities, merged groups). */
  nodes: Record<string, Node3D>;
  /** Colliders verbatim from the descriptor (empty when none). */
  colliders: AABBDesc[];
}

// Resolve a baked-mesh prototype. Kept tiny + lazy so 2D / procedural games never
// drag a glTF asset module into their bundle; only a descriptor that actually names
// a baked key pays for it. Resolvers are registered by the (rare) game that needs
// them; the common box/plane prototypes need nothing.
const bakedResolvers: Record<string, () => Mesh> = {};
export function registerBaked(key: string, make: () => Mesh): void {
  bakedResolvers[key] = make;
}

function makeMesh(p: MeshProto): Mesh {
  if (p.kind === 'box') return Mesh.box(p.size[0], p.size[1], p.size[2], p.colors);
  if (p.kind === 'plane') return Mesh.plane(p.size[0], p.size[1], p.color);
  const make = bakedResolvers[p.key];
  if (!make) throw new Error('scene-desc: no baked resolver for ' + p.key);
  return make();
}

const v3 = (a?: [number, number, number]): Vec3 => new Vec3(a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0);

/**
 * Build a Scene3D from a descriptor. Adds nodes in declaration order (entities,
 * then instance groups) so the emitted draw list matches the hand-written onEnter
 * byte-for-byte. Each prototype is realized as ONE Mesh and shared across all of
 * its instances (one host upload, many model matrices) unless a group sets merge.
 */
export function buildScene(d: SceneDescriptor): BuiltScene {
  const scene = new Scene3D();
  if (d.camera) {
    scene.camera.setPerspective(d.camera.fovDeg, d.camera.aspect, d.camera.near, d.camera.far);
  }
  if (d.fog) scene.fog = { color: d.fog.color, near: d.fog.near, far: d.fog.far };

  // Realize each prototype's Mesh once, on first reference, preserving the order in
  // which prototypes are first used by nodes (so upload order matches a hand-built
  // scene that constructs each mesh just before it adds it).
  const meshes: Record<string, Mesh> = {};
  const mesh = (key: string): Mesh => (meshes[key] ??= makeMesh(protoOrThrow(d, key)));

  const nodes: Record<string, Node3D> = {};

  for (const e of d.entities ?? []) {
    const n = scene.add({
      mesh: mesh(e.proto),
      position: v3(e.position),
      rotation: e.rotation ? Quat.fromEuler(e.rotation[0], e.rotation[1], e.rotation[2]) : undefined,
      scale: e.scale ? v3(e.scale) : undefined,
      tint: e.tint,
      isStatic: e.isStatic,
    });
    if (e.id) nodes[e.id] = n;
  }

  for (const g of d.instances ?? []) {
    const proto = mesh(g.proto);
    if (g.merge) {
      const parts = g.positions.map((p) => ({
        mesh: proto,
        model: Mat4.compose(v3(p), Quat.identity(), new Vec3(1, 1, 1)),
      }));
      const n = scene.add({ mesh: mergeMeshes(parts), tint: g.tint, isStatic: g.isStatic ?? true });
      if (g.id) nodes[g.id] = n;
    } else {
      for (const p of g.positions) {
        scene.add({ mesh: proto, position: v3(p), tint: g.tint, isStatic: g.isStatic });
      }
    }
  }

  return { scene, nodes, colliders: d.colliders ?? [] };
}

function protoOrThrow(d: SceneDescriptor, key: string): MeshProto {
  const p = d.prototypes[key];
  if (!p) throw new Error('scene-desc: unknown prototype ' + key);
  return p;
}

// ---- baked descriptor (loadScene) -----------------------------------------
// The bake side (bake-scene.ts) splits a descriptor into three blobs keyed
// "<key>:scene.meta" (DT_U8 UTF-8 JSON: camera/fog/prototypes + the structural
// shape of entities/instances WITHOUT their numeric transforms), "<key>:scene.xforms"
// (DT_F32: the packed positions, in the exact add order) and "<key>:scene.colliders"
// (DT_F32: min/max per collider). loadScene reads them back into a SceneDescriptor
// and runs the same buildScene, so the loaded scene is byte-identical to the inline
// one FOR A TRANSLATION-ONLY scene (the f32 xforms blob is exact for translation;
// see the BYTE-EXACT SCOPE note at the top of this file for rotation/scale). The
// caller passes the FULL literal key (e.g. 'racing3d') so build.ts's presentIn()
// keeps these blobs in the per-game pack.

// meta JSON shape: transforms are stripped out and replaced by counts, so the
// numbers live only in the f32 blob (smaller, and no float-to-string drift).
interface SceneMeta {
  camera?: SceneDescriptor['camera'];
  fog?: SceneDescriptor['fog'];
  lighting?: SceneDescriptor['lighting'];
  prototypes: Record<string, MeshProto>;
  // entities: each carries only its non-numeric fields + which xform slots it uses.
  entities: { proto: string; tint?: number; isStatic?: boolean; id?: string;
              hasPos: boolean; hasRot: boolean; hasScale: boolean }[];
  instances: { proto: string; count: number; tint?: number; isStatic?: boolean;
               merge?: boolean; id?: string }[];
  colliderCount: number;
}

/**
 * Reconstruct + build a scene baked under `key`. Reads "<key>:scene.meta" (JSON),
 * "<key>:scene.xforms" (f32 transforms in add order) and "<key>:scene.colliders"
 * (f32 min/max). Reference the full literal key so framework/build.ts subsets the
 * three blobs into this game's pack.
 */
export function loadScene(key: string): BuiltScene {
  const meta: SceneMeta = JSON.parse(u8ToStr(dcU8(key + ':scene.meta')));
  const xf = dcF32(key + ':scene.xforms');
  const col = dcF32(key + ':scene.colliders');

  let o = 0; // cursor into the f32 xforms blob, advanced in EXACT add order.
  const triple = (): [number, number, number] => {
    const t: [number, number, number] = [xf[o], xf[o + 1], xf[o + 2]];
    o += 3;
    return t;
  };

  const entities: EntityDesc[] = meta.entities.map((e) => ({
    proto: e.proto,
    tint: e.tint,
    isStatic: e.isStatic,
    id: e.id,
    position: e.hasPos ? triple() : undefined,
    rotation: e.hasRot ? triple() : undefined,
    scale: e.hasScale ? triple() : undefined,
  }));

  const instances: InstanceGroup[] = meta.instances.map((g) => {
    const positions: [number, number, number][] = [];
    for (let i = 0; i < g.count; i++) positions.push(triple());
    return { proto: g.proto, positions, tint: g.tint, isStatic: g.isStatic, merge: g.merge, id: g.id };
  });

  const colliders: AABBDesc[] = [];
  for (let i = 0; i < meta.colliderCount; i++) {
    const b = i * 6;
    colliders.push({ min: [col[b], col[b + 1], col[b + 2]], max: [col[b + 3], col[b + 4], col[b + 5]] });
  }

  return buildScene({
    camera: meta.camera,
    fog: meta.fog,
    lighting: meta.lighting,
    prototypes: meta.prototypes,
    entities,
    instances,
    colliders,
  });
}

// ASCII/UTF-8 decode without TextDecoder (QuickJS lacks it). Scene meta is small
// JSON; build the string from char codes. Decodes 1/2/3-byte UTF-8 sequences (the
// BMP) — enough for ASCII prototype keys/ids + numbers, plus any BMP text in a
// comment. LIMITATION: 4-byte sequences (astral / non-BMP codepoints, e.g. emoji)
// are NOT handled and would mis-decode; scene meta is ASCII today, so this never
// triggers. If a scene ever carries non-BMP text, extend this to emit a surrogate
// pair for the 4-byte case (or, better, keep meta ASCII).
function u8ToStr(u8: Uint8Array): string {
  let s = '';
  let i = 0;
  while (i < u8.length) {
    const c = u8[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (u8[i++] & 0x3f));
    else s += String.fromCharCode(((c & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f));
  }
  return s;
}

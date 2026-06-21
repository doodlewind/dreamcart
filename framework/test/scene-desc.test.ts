// Unit tests for the data-driven scene subsystem (framework/src/scene-desc.ts +
// framework/bake/bake-scene.ts).
//   bun framework/test/scene-desc.test.ts
//
// The racing3d/.dc3d golden (golden.ts) already proves the SHIPPED scene
// (translation-only) is byte-identical end to end after the loadScene migration.
// These tests cover what that single golden can't:
//   (a) the headline byte-exact contract, stated precisely: buildScene() and a
//       bake->loadScene() round trip both emit a draw list byte-identical to the
//       equivalent hand-written onEnter — FOR A TRANSLATION-ONLY scene (the only
//       case the f32 xforms blob can reproduce exactly; see the rotation/scale
//       note below and the doc in scene-desc.ts).
//   (b) the untested branches no in-tree game exercises yet: instance merge:true
//       (mergeMeshes), an id'd entity / merged group resolved via BuiltScene.nodes,
//       a non-empty colliders array round-tripping through the f32 blob, and a
//       baked-prototype registerBaked() resolver.
//
// WHY translation-only for (a): the xforms blob stores f32. A pure translation is
// copied verbatim into the model matrix's translation column, which the wire
// encoder (CommandEncoder.writeMat -> setFloat32) truncates to f32 anyway, and
// f32 truncation is idempotent (f32(f32(x)) === f32(x)) — so the loaded path is
// bit-identical to f64 literals fed through Mat4.compose. A rotation/scale would
// re-compose from f32-rounded euler/scale at load and the f32-truncated PRODUCT
// can differ from the inline f64 product. (c) below pins that boundary so the
// guarantee can't silently widen.
import { Raster3D } from "./raster3d";
import { Mesh } from "../src/mesh";
import { Scene3D } from "../src/scene3d";
import { Vec3, Quat, Mat4 } from "../src/math";
import { CommandEncoder } from "../src/g3d";
import { rgb } from "../src/color";
import {
  buildScene,
  registerBaked,
  type SceneDescriptor,
} from "../src/scene-desc";
import { pack, rawBytes, DT_U8, DT_F32, type Blob } from "../bake/dcpak";

let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) console.log("PASS ", msg);
  else {
    console.log("FAIL ", msg);
    fail++;
  }
}

const SCREEN_W = 480;
const SCREEN_H = 272;

// Render a scene through the software raster host and return its recorded
// uploadMesh + submit byte stream (the same bytes the .dc3d golden pins).
function record(make: () => Scene3D): Uint8Array {
  const buf = new Uint8Array(SCREEN_W * SCREEN_H * 4);
  const raster = new Raster3D(buf, SCREEN_W, SCREEN_H);
  (globalThis as any).g3d = raster;
  try {
    const scene = make();
    const enc = new CommandEncoder();
    scene.render(enc); // render() submits to globalThis.g3d itself
    return raster.recorded();
  } finally {
    (globalThis as any).g3d = undefined;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const solid = (c: number): number[] => [c, c, c, c, c, c];

// ---- (a) byte-exact: hand-built === buildScene (translation-only) -----------
// A miniature racing3d: plane + box entity, then a 2-instance cone group (each
// instance its own node, sharing ONE cone mesh). The hand-built version MUST add
// nodes in EXACTLY the order buildScene does: entities in array order, then each
// instance group's positions in order.
const GROUND = rgb(46, 78, 46);
const ROAD = rgb(54, 54, 60);
const CONE = rgb(230, 120, 40);
const CONES: [number, number, number][] = [
  [-5, 0.7, -8],
  [5, 0.7, -8],
  [-5, 0.7, -22],
  [5, 0.7, -22],
];

const descTranslation: SceneDescriptor = {
  camera: { fovDeg: 62, aspect: 480 / 272, near: 0.1, far: 300 },
  prototypes: {
    ground: { kind: "plane", size: [600, 600], color: GROUND },
    road: { kind: "box", size: [10, 0.05, 600], colors: solid(ROAD) },
    cone: { kind: "box", size: [0.7, 1.4, 0.7], colors: solid(CONE) },
  },
  entities: [
    { proto: "ground", position: [0, 0, 0] },
    { proto: "road", position: [0, 0.02, -260] },
  ],
  instances: [{ proto: "cone", positions: CONES }],
};

function handBuilt(): Scene3D {
  const scene = new Scene3D();
  scene.camera.setPerspective(62, 480 / 272, 0.1, 300);
  // Realize each prototype mesh ONCE, in first-use order, exactly like buildScene.
  const ground = Mesh.plane(600, 600, GROUND);
  const road = Mesh.box(10, 0.05, 600, solid(ROAD));
  const cone = Mesh.box(0.7, 1.4, 0.7, solid(CONE));
  scene.add({ mesh: ground, position: new Vec3(0, 0, 0) });
  scene.add({ mesh: road, position: new Vec3(0, 0.02, -260) });
  for (const p of CONES) scene.add({ mesh: cone, position: new Vec3(p[0], p[1], p[2]) });
  return scene;
}

{
  const a = record(handBuilt);
  const b = record(() => buildScene(descTranslation).scene);
  ok(bytesEqual(a, b), "buildScene() draw list is byte-identical to the hand-written onEnter (translation-only)");
}

// ---- (a') byte-exact across the bake -> loadScene round trip -----------------
// Serialize the descriptor exactly as bake-scene.ts does, pack it into a store,
// expose it as globalThis.__dcpak (what the host provides), and loadScene() it.
// The loaded draw list must match the hand-built one byte-for-byte too.
//
// NOTE: scene-desc.ts caches the dcpak module's parsed store on first access, so
// the pack must be installed BEFORE the first dc*() call. This test process makes
// its first dc*() call here, so installing it now is sufficient.
interface SceneMeta {
  camera?: SceneDescriptor["camera"];
  fog?: SceneDescriptor["fog"];
  prototypes: SceneDescriptor["prototypes"];
  entities: { proto: string; tint?: number; isStatic?: boolean; id?: string; hasPos: boolean; hasRot: boolean; hasScale: boolean }[];
  instances: { proto: string; count: number; tint?: number; isStatic?: boolean; merge?: boolean; id?: string }[];
  colliderCount: number;
}

// Mirror bake-scene.ts serialize() so the test pins the wire shape loadScene reads.
function serialize(key: string, d: SceneDescriptor): Blob[] {
  const xforms: number[] = [];
  const push3 = (t?: [number, number, number]): void => {
    if (t) xforms.push(t[0], t[1], t[2]);
  };
  const entities = (d.entities ?? []).map((e) => {
    push3(e.position);
    push3(e.rotation);
    push3(e.scale);
    return { proto: e.proto, tint: e.tint, isStatic: e.isStatic, id: e.id, hasPos: !!e.position, hasRot: !!e.rotation, hasScale: !!e.scale };
  });
  const instances = (d.instances ?? []).map((g) => {
    for (const p of g.positions) push3(p);
    return { proto: g.proto, count: g.positions.length, tint: g.tint, isStatic: g.isStatic, merge: g.merge, id: g.id };
  });
  const colliders = d.colliders ?? [];
  const cf: number[] = [];
  for (const c of colliders) cf.push(c.min[0], c.min[1], c.min[2], c.max[0], c.max[1], c.max[2]);
  const meta: SceneMeta = { camera: d.camera, fog: d.fog, prototypes: d.prototypes, entities, instances, colliderCount: colliders.length };
  return [
    { key: key + ":scene.meta", dtype: DT_U8, data: new TextEncoder().encode(JSON.stringify(meta)) },
    { key: key + ":scene.xforms", dtype: DT_F32, data: rawBytes(new Float32Array(xforms)).slice() },
    { key: key + ":scene.colliders", dtype: DT_F32, data: rawBytes(new Float32Array(cf)).slice() },
  ];
}

// Install a store containing every scene this test loads, BEFORE the first dc*().
const COLLIDER_DESC: SceneDescriptor = {
  ...descTranslation,
  entities: [
    { proto: "road", position: [0, 0.02, -260], id: "road" },
    { proto: "ground", position: [0, 0, 0] },
  ],
  instances: [{ proto: "cone", positions: CONES, merge: true, id: "clump" }],
  colliders: [
    { min: [-5, 0, -8], max: [5, 1.4, -8] },
    { min: [-5, 0, -22], max: [5, 1.4, -22] },
  ],
};
const storeBlobs: Blob[] = [
  ...serialize("scenetest", descTranslation),
  ...serialize("scenetestC", COLLIDER_DESC),
];
(globalThis as any).__dcpak = pack(storeBlobs).buffer;

// loadScene is imported lazily so the store is installed before any dc*() call.
const { loadScene } = await import("../src/scene-desc");

{
  const a = record(handBuilt);
  const b = record(() => loadScene("scenetest").scene);
  ok(bytesEqual(a, b), "bake -> loadScene() draw list is byte-identical to the hand-written onEnter (translation-only)");
}

// ---- (b) merge:true, id'd nodes, colliders round trip -----------------------
{
  const built = loadScene("scenetestC");
  // id'd entity and id'd merged group are both resolvable from BuiltScene.nodes.
  ok(!!built.nodes["road"], "loadScene: id'd entity resolvable via BuiltScene.nodes");
  ok(!!built.nodes["clump"], "loadScene: id'd merged group resolvable via BuiltScene.nodes");
  // colliders round-trip through the f32 blob, in order, with exact bounds.
  ok(built.colliders.length === 2, "loadScene: both colliders survive the f32 round trip");
  // Bounds round-trip through the f32 blob, so compare against the f32 value the
  // blob can represent (1.4 is not exactly representable in f32; -5/-22 are).
  ok(
    built.colliders[0].min[0] === -5 &&
      built.colliders[0].max[1] === Math.fround(1.4) &&
      built.colliders[1].min[2] === -22,
    "loadScene: collider min/max bounds round-trip exactly (f32)",
  );

  // merge:true collapses the instance group into ONE node (mergeMeshes), versus
  // one node per instance when off. The merged scene has fewer drawable nodes.
  const mergedDraws = countDrawNodes(loadScene("scenetestC").scene);
  const splitDraws = countDrawNodes(loadScene("scenetest").scene);
  // scenetestC: 2 entities + 1 merged clump = 3 draws. scenetest: 2 entities + 4 cones = 6.
  ok(mergedDraws === 3, `merge:true collapses 4 cone instances into 1 node (3 draws total, got ${mergedDraws})`);
  ok(splitDraws === 6, `merge:false keeps each instance its own node (6 draws total, got ${splitDraws})`);
}

// Count drawable (mesh-bearing) nodes under the scene root, recursively.
function countDrawNodes(scene: Scene3D): number {
  let n = 0;
  const walk = (node: any): void => {
    if (node.mesh) n++;
    for (const c of node.children) walk(c);
  };
  for (const c of scene.root.children) walk(c);
  return n;
}

// ---- (b') registerBaked resolver --------------------------------------------
{
  let calls = 0;
  registerBaked("test:cube", () => {
    calls++;
    return Mesh.box(1, 1, 1, solid(rgb(200, 30, 30)));
  });
  const d: SceneDescriptor = {
    prototypes: { c: { kind: "baked", key: "test:cube" } },
    instances: [{ proto: "c", positions: [[0, 0, 0], [2, 0, 0], [4, 0, 0]] }],
  };
  const built = buildScene(d);
  ok(calls === 1, "registerBaked resolver is invoked ONCE per prototype (shared across 3 instances)");
  ok(countDrawNodes(built.scene) === 3, "baked prototype placed at 3 instance positions");
  let threw = false;
  try {
    buildScene({ prototypes: { x: { kind: "baked", key: "test:missing" } }, instances: [{ proto: "x", positions: [[0, 0, 0]] }] });
  } catch {
    threw = true;
  }
  ok(threw, "buildScene throws for an unregistered baked prototype");
}

// ---- (c) the rotation/scale boundary: NOT byte-safe via f32 round trip -------
// This is the explicit fence on the (a) guarantee. The divergence is VALUE-
// dependent (many angles happen to be f32-stable), so the honest claim is "not
// GUARANTEED byte-exact" — there EXISTS a rotation that diverges. 37 deg about Y
// is such a value. Asserting that divergence locks the boundary: if a future
// change ever made rotation f32-round-trip byte-exact for this case, this test
// goes red and the guarantee can be widened deliberately (and scene-desc.ts's doc
// updated) rather than silently. Translation, by contrast, is ALWAYS exact (a/a').
{
  // 37-degree Y rotation: re-composing from f32-rounded euler vs f64 euler.
  const eulerY = (37 * Math.PI) / 180;
  const f64 = Mat4.compose(new Vec3(1, 2, 3), Quat.fromEuler(0, eulerY, 0), new Vec3(1, 1, 1));
  const f32y = Math.fround(eulerY); // what the xforms blob stores + loadScene reads
  const fromF32 = Mat4.compose(new Vec3(1, 2, 3), Quat.fromEuler(0, f32y, 0), new Vec3(1, 1, 1));
  // Truncate BOTH composed matrices to f32 the way CommandEncoder.writeMat does.
  let anyDiff = false;
  for (let i = 0; i < 16; i++) if (Math.fround(f64[i]) !== Math.fround(fromF32[i])) anyDiff = true;
  ok(anyDiff, "a rotation (37deg) re-composed from f32 euler diverges from f64 after f32 truncation: rotation/scale round trip is NOT byte-guaranteed, so the contract is correctly scoped to translation");
}

console.log(`\n${fail === 0 ? "OK" : fail + " FAILED"}`);
process.exit(fail ? 1 : 0);

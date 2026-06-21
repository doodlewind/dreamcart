// Bake data-driven scenes (framework/scenes/*.scene.ts) into the binary master
// store framework/src/assets.dcstore, so a game can loadScene(key) instead of
// hand-building its onEnter. Each descriptor becomes three keyed blobs:
//   "<key>:scene.meta"      DT_U8   UTF-8 JSON: camera/fog/prototypes +
//                                   the STRUCTURAL shape of entities/instances
//                                   (proto/tint/flags/counts) — no numeric xforms.
//   "<key>:scene.xforms"    DT_F32  every transform triple, in EXACT add order
//                                   (entity pos/rot/scale as present, then each
//                                   instance group's positions). Keeping the floats
//                                   in a binary blob (not the JSON) avoids
//                                   float->string drift and keeps the meta small.
//   "<key>:scene.colliders" DT_F32  min/max per collider (6 f32 each; may be empty).
//
// Run AFTER bake-gltf.ts (it APPENDS to / refreshes the store rather than
// overwriting it, so the glTF blobs survive). Wired into `bun run bake`.
//   bun framework/bake/bake-scene.ts
import { readdirSync, existsSync } from 'node:fs';
import { pack, unpack, rawBytes, DT_U8, DT_F32, type Blob } from './dcpak';
import type { SceneDescriptor, MeshProto, AABBDesc } from '../src/scene-desc';

const here = new URL('.', import.meta.url).pathname;
const scenesDir = here + '../scenes/';
const storePath = here + '../src/assets.dcstore';

// Mirror loadScene's SceneMeta shape exactly (the reader parses this back).
interface SceneMeta {
  camera?: SceneDescriptor['camera'];
  fog?: SceneDescriptor['fog'];
  prototypes: Record<string, MeshProto>;
  entities: { proto?: string; box?: { size: [number, number, number]; colors: number[] };
              bounds?: AABBDesc;
              tint?: number; isStatic?: boolean; id?: string;
              hasPos: boolean; hasRot: boolean; hasScale: boolean; hasMatrix?: boolean }[];
  instances: { proto: string; count: number; tint?: number; isStatic?: boolean;
               merge?: boolean; id?: string }[];
  colliderCount: number;
}

function serialize(key: string, d: SceneDescriptor): Blob[] {
  const xforms: number[] = [];
  const push3 = (t?: [number, number, number]): void => {
    if (t) xforms.push(t[0], t[1], t[2]);
  };

  const entities = (d.entities ?? []).map((e) => {
    // Write order MUST mirror loadScene's read order: pos, rot, scale, then matrix.
    push3(e.position);
    push3(e.rotation);
    push3(e.scale);
    if (e.matrix) for (const v of e.matrix) xforms.push(v);
    return {
      proto: e.proto, box: e.box, bounds: e.bounds, tint: e.tint, isStatic: e.isStatic, id: e.id,
      hasPos: !!e.position, hasRot: !!e.rotation, hasScale: !!e.scale, hasMatrix: !!e.matrix,
    };
  });

  const instances = (d.instances ?? []).map((g) => {
    for (const p of g.positions) push3(p);
    return { proto: g.proto, count: g.positions.length, tint: g.tint, isStatic: g.isStatic, merge: g.merge, id: g.id };
  });

  const colliders = d.colliders ?? [];
  const cf: number[] = [];
  for (const c of colliders) cf.push(c.min[0], c.min[1], c.min[2], c.max[0], c.max[1], c.max[2]);

  const meta: SceneMeta = {
    camera: d.camera, fog: d.fog,
    prototypes: d.prototypes, entities, instances, colliderCount: colliders.length,
  };

  return [
    { key: key + ':scene.meta', dtype: DT_U8, data: new TextEncoder().encode(JSON.stringify(meta)) },
    { key: key + ':scene.xforms', dtype: DT_F32, data: rawBytes(new Float32Array(xforms)).slice() },
    { key: key + ':scene.colliders', dtype: DT_F32, data: rawBytes(new Float32Array(cf)).slice() },
  ];
}

const files = existsSync(scenesDir)
  ? readdirSync(scenesDir).filter((f) => f.endsWith('.scene.ts')).sort()
  : [];

if (files.length === 0) {
  console.log('bake-scene: no scenes (framework/scenes/*.scene.ts)');
  process.exit(0);
}

// Load the existing store and drop any scene blobs we're about to regenerate, so
// re-running is idempotent and the glTF blobs are preserved untouched.
const existing: Blob[] = existsSync(storePath)
  ? unpack(new Uint8Array(await Bun.file(storePath).arrayBuffer()))
  : [];

const sceneBlobs: Blob[] = [];
for (const f of files) {
  const key = f.slice(0, -('.scene.ts'.length)); // "racing3d.scene.ts" -> "racing3d"
  const mod = await import(scenesDir + f);
  // Accept either a named `<key>Scene` export or a default export.
  const desc: SceneDescriptor =
    mod[key + 'Scene'] ?? mod.scene ?? mod.default;
  if (!desc || !desc.prototypes) throw new Error(`bake-scene: ${f} has no SceneDescriptor export (expected ${key}Scene / default)`);
  const blobs = serialize(key, desc);
  sceneBlobs.push(...blobs);
  const xf = blobs[1].data.length / 4;
  console.log(`  ${key}: ${blobs[0].data.length} B meta, ${xf} f32 xforms, ${desc.colliders?.length ?? 0} colliders`);
}

const sceneKeys = new Set(sceneBlobs.map((b) => b.key));
const merged = [...existing.filter((b) => !sceneKeys.has(b.key)), ...sceneBlobs];
const out = pack(merged); // pack() sorts by key, so glTF + scene blobs interleave fine
await Bun.write(storePath, out);
console.log(`bake-scene: wrote src/assets.dcstore (${merged.length} blobs, ${(out.length / 1024).toFixed(1)} KB)`);

// Bakes the vendored glTF assets (assets/vendor/*) into compact TS data modules
// in framework/src/ (assets-kenney-nature.ts, assets-kenney-car.ts; the skinned
// Fox is baked in M4). Mirrors bake-font.ts/bake-sprites.ts: read vendored source
// -> emit `export const` typed arrays. Run: bun framework/bake/bake-gltf.ts
//
// This is an OFFLINE step — real trig / matrix math is fine here; the RUNTIME only
// array-looks-up + lerps. Geometry/texture blobs are emitted base64 (decoded by
// framework/src/b64.ts at load) so the .ts files stay small. Bytes are interleaved
// in the GE's FIXED component order [weights][uv][color][normal][pos] (see g3d.ts).
import { NodeIO } from '@gltf-transform/core';
// upng-js ships no types; Bun runs it fine at runtime.
// @ts-ignore
import UPNG from 'upng-js';
import {
  FMT_POS, FMT_COLOR, FMT_NORMAL, FMT_UV, FMT_WEIGHTS, vertexStride, colorToABGR, NO_TINT,
} from '../src/g3d';

const here = new URL('.', import.meta.url).pathname;
const vendor = here + '../../assets/vendor/';
const outDir = here + '../src/';
const io = new NodeIO();

const b64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');

// --- transform helpers (column-major mat4, m[col*4+row]) ---
function xformPos(m: number[], x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
function xformNrm(m: number[], x: number, y: number, z: number): [number, number, number] {
  // Rotation + (uniform) scale: upper 3×3 then renormalize. Good enough for these
  // rigid/uniformly-scaled nodes (no shear); avoids a full inverse-transpose.
  const nx = m[0] * x + m[4] * y + m[8] * z;
  const ny = m[1] * x + m[5] * y + m[9] * z;
  const nz = m[2] * x + m[6] * y + m[10] * z;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

interface PrimSrc {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prim: any;
  world: number[];
}

interface Baked {
  format: number;
  stride: number;
  vertexCount: number;
  weightCount?: number;
  vertices: Uint8Array;
  indices: Uint16Array;
  triCount: number;
  aabb: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Merge `prims` (each carrying its node world matrix) into ONE interleaved,
 * indexed mesh in GE order. `colorFor(prim)` supplies the per-primitive ABGR
 * color folded into FMT_COLOR. Positions/normals are baked into world space.
 */
function assemble(
  prims: PrimSrc[],
  format: number,
  colorFor: (prim: unknown) => number,
): Baked {
  const stride = vertexStride(format);
  const hasUV = (format & FMT_UV) !== 0;
  const hasCol = (format & FMT_COLOR) !== 0;
  const hasNrm = (format & FMT_NORMAL) !== 0;

  let totalV = 0;
  let totalI = 0;
  for (const { prim } of prims) {
    const n = prim.getAttribute('POSITION').getCount();
    totalV += n;
    const idx = prim.getIndices();
    totalI += idx ? idx.getCount() : n;
  }

  const vbuf = new Uint8Array(totalV * stride);
  const dv = new DataView(vbuf.buffer);
  const indices = new Uint16Array(totalI);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  let vbase = 0;
  let ibase = 0;
  for (const { prim, world } of prims) {
    const posA = prim.getAttribute('POSITION');
    const nrmA = prim.getAttribute('NORMAL');
    const uvA = prim.getAttribute('TEXCOORD_0');
    const n = posA.getCount();
    const col = colorFor(prim);
    const pe: number[] = [0, 0, 0];
    const ne: number[] = [0, 0, 0];
    const ue: number[] = [0, 0];
    for (let i = 0; i < n; i++) {
      posA.getElement(i, pe);
      const [px, py, pz] = xformPos(world, pe[0], pe[1], pe[2]);
      let o = (vbase + i) * stride;
      if (hasUV) {
        if (uvA) {
          uvA.getElement(i, ue);
          dv.setFloat32(o, ue[0], true);
          dv.setFloat32(o + 4, ue[1], true);
        }
        o += 8;
      }
      if (hasCol) {
        dv.setUint32(o, col >>> 0, true);
        o += 4;
      }
      if (hasNrm) {
        if (nrmA) {
          nrmA.getElement(i, ne);
          const [nx, ny, nz] = xformNrm(world, ne[0], ne[1], ne[2]);
          dv.setFloat32(o, nx, true);
          dv.setFloat32(o + 4, ny, true);
          dv.setFloat32(o + 8, nz, true);
        }
        o += 12;
      }
      dv.setFloat32(o, px, true);
      dv.setFloat32(o + 4, py, true);
      dv.setFloat32(o + 8, pz, true);
      if (px < min[0]) min[0] = px;
      if (py < min[1]) min[1] = py;
      if (pz < min[2]) min[2] = pz;
      if (px > max[0]) max[0] = px;
      if (py > max[1]) max[1] = py;
      if (pz > max[2]) max[2] = pz;
    }
    const idxA = prim.getIndices();
    if (idxA) {
      const ia = idxA.getArray();
      for (let k = 0; k < ia.length; k++) indices[ibase + k] = vbase + ia[k];
      ibase += ia.length;
    } else {
      for (let k = 0; k < n; k++) indices[ibase + k] = vbase + k;
      ibase += n;
    }
    vbase += n;
  }
  if (totalV > 65535) throw new Error(`assemble: ${totalV} verts > u16 index range`);
  return { format, stride, vertexCount: totalV, vertices: vbuf, indices, triCount: totalI / 3, aabb: { min, max } };
}

/** baseColorFactor (RGBA floats) -> ABGR u32 (alpha 255). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function materialColor(prim: any): number {
  const mat = prim.getMaterial();
  const f = mat ? mat.getBaseColorFactor() : [1, 1, 1, 1];
  const r = Math.round(f[0] * 255);
  const g = Math.round(f[1] * 255);
  const b = Math.round(f[2] * 255);
  return colorToABGR(((r << 16) | (g << 8) | b) >>> 0, 255);
}

/** Box-downsample an RGBA8888 image to target×target (deterministic average). */
function downsampleRGBA(rgba: Uint8Array, sw: number, sh: number, target: number): Uint8Array {
  const out = new Uint8Array(target * target * 4);
  const fx = sw / target;
  const fy = sh / target;
  for (let y = 0; y < target; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < target; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * sw + xx) * 4;
          r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; a += rgba[o + 3];
          cnt++;
        }
      }
      const o = (y * target + x) * 4;
      out[o] = (r / cnt) | 0;
      out[o + 1] = (g / cnt) | 0;
      out[o + 2] = (b / cnt) | 0;
      out[o + 3] = (a / cnt) | 0;
    }
  }
  return out;
}

interface BakedTex { width: number; height: number; pixels: Uint8Array }

/** Decode a PNG, downsample to ≤256², force opaque (RGB sources), return RGBA8888. */
function bakeTexture(pngBytes: ArrayBuffer, target = 256): BakedTex {
  const img = UPNG.decode(pngBytes);
  const frames = UPNG.toRGBA8(img);
  let rgba = new Uint8Array(frames[0]);
  let w = img.width;
  let h = img.height;
  if (w !== target || h !== target) {
    rgba = downsampleRGBA(rgba, w, h, target);
    w = target;
    h = target;
  }
  // Force opaque: these palettes have no meaningful alpha.
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width: w, height: h, pixels: rgba };
}

// --- emit helpers (TS source fragments) ---
function emitMesh(m: Baked): string {
  const idxBytes = new Uint8Array(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength);
  const aabb = `{ min: [${m.aabb.min.map((v) => +v.toFixed(5))}], max: [${m.aabb.max.map((v) => +v.toFixed(5))}] }`;
  return (
    `{\n` +
    `    format: ${m.format}, stride: ${m.stride}, vertexCount: ${m.vertexCount}, weightCount: ${m.weightCount ?? 0}, triCount: ${m.triCount},\n` +
    `    aabb: ${aabb},\n` +
    `    vertices: unb64('${b64(m.vertices)}'),\n` +
    `    indices: new Uint16Array(unb64('${b64(idxBytes)}').buffer),\n` +
    `  }`
  );
}
function emitTex(t: BakedTex): string {
  return (
    `{\n` +
    `    width: ${t.width}, height: ${t.height}, psm: PSM_8888,\n` +
    `    pixels: unb64('${b64(t.pixels)}'),\n` +
    `  }`
  );
}

// ===========================================================================
// kenney-nature: 4 flat-colored, untextured props (COLOR|NORMAL|POS, 28 B).
// ===========================================================================
async function bakeNature(): Promise<void> {
  const format = FMT_COLOR | FMT_NORMAL | FMT_POS; // 0x0007
  const files: Record<string, string> = {
    tree: 'kenney-nature/tree_simple.glb',
    rock: 'kenney-nature/rock_smallA.glb',
    bush: 'kenney-nature/plant_bushSmall.glb',
    grass: 'kenney-nature/grass_leafs.glb',
  };
  const props: Record<string, Baked> = {};
  for (const [key, path] of Object.entries(files)) {
    const doc = await io.read(vendor + path);
    const root = doc.getRoot();
    const prims: PrimSrc[] = [];
    for (const n of root.listNodes()) {
      const mesh = n.getMesh();
      if (!mesh) continue;
      const world = n.getWorldMatrix();
      for (const p of mesh.listPrimitives()) prims.push({ prim: p, world });
    }
    props[key] = assemble(prims, format, materialColor);
    const m = props[key];
    console.log(`  nature/${key}: ${m.vertexCount}v ${m.triCount}t`);
  }

  let out = '// AUTO-GENERATED by bake/bake-gltf.ts from Kenney Nature Kit (CC0).\n';
  out += '// Flat-colored low-poly props (color baked per-vertex; no texture).\n';
  out += "import { unb64 } from './b64';\nimport type { BakedMesh } from './mesh';\n\n";
  out += `export const NATURE_FORMAT = ${format};\n`;
  out += `export const NATURE_STRIDE = ${vertexStride(format)};\n\n`;
  out += 'export const NATURE_PROPS: Record<string, BakedMesh> = {\n';
  for (const [key, m] of Object.entries(props)) out += `  ${key}: ${emitMesh(m)},\n`;
  out += '};\n';
  await Bun.write(outDir + 'assets-kenney-nature.ts', out);
  console.log('  -> src/assets-kenney-nature.ts');
}

// ===========================================================================
// kenney-car: textured body + one wheel + 4 wheel offsets (UV|COLOR|NORMAL|POS).
// ===========================================================================
async function bakeCar(): Promise<void> {
  const format = FMT_UV | FMT_COLOR | FMT_NORMAL | FMT_POS; // 0x000F
  const sedan = await io.read(vendor + 'kenney-car/sedan.glb');
  const sroot = sedan.getRoot();

  // Body node (baked WITH its world matrix so it sits at the right height).
  let bodyPrims: PrimSrc[] = [];
  const wheelOffsets: [number, number, number][] = [];
  for (const n of sroot.listNodes()) {
    const mesh = n.getMesh();
    if (!mesh) continue;
    const name = n.getName();
    if (name === 'body') {
      const world = n.getWorldMatrix();
      bodyPrims = mesh.listPrimitives().map((p) => ({ prim: p, world }));
    } else if (name.startsWith('wheel')) {
      const t = n.getWorldTranslation();
      wheelOffsets.push([+t[0].toFixed(5), +t[1].toFixed(5), +t[2].toFixed(5)]);
    }
  }
  const body = assemble(bodyPrims, format, () => NO_TINT);

  // Wheel from wheel-default.glb, baked at ORIGIN (local) so it spins about its hub.
  const wheelDoc = await io.read(vendor + 'kenney-car/wheel-default.glb');
  const wroot = wheelDoc.getRoot();
  const wheelPrims: PrimSrc[] = [];
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const n of wroot.listNodes()) {
    const mesh = n.getMesh();
    if (!mesh) continue;
    for (const p of mesh.listPrimitives()) wheelPrims.push({ prim: p, world: I });
  }
  const wheel = assemble(wheelPrims, format, () => NO_TINT);

  const tex = bakeTexture(await Bun.file(vendor + 'kenney-car/colormap.png').arrayBuffer(), 256);
  console.log(`  car: body ${body.vertexCount}v ${body.triCount}t, wheel ${wheel.vertexCount}v ${wheel.triCount}t, tex ${tex.width}x${tex.height}, offsets ${wheelOffsets.length}`);

  let out = '// AUTO-GENERATED by bake/bake-gltf.ts from Kenney Car Kit (CC0).\n';
  out += '// Textured low-poly sedan: body + one wheel mesh + the 4 wheel offsets.\n';
  out += "import { unb64 } from './b64';\nimport { PSM_8888 } from './g3d';\n";
  out += "import type { BakedMesh } from './mesh';\n\n";
  out += 'export interface BakedTexture { width: number; height: number; psm: number; pixels: Uint8Array }\n\n';
  out += 'export const KENNEY_CAR: {\n';
  out += '  format: number; stride: number;\n  body: BakedMesh; wheel: BakedMesh;\n';
  out += '  wheelOffsets: [number, number, number][];\n  texture: BakedTexture;\n} = {\n';
  out += `  format: ${format}, stride: ${vertexStride(format)},\n`;
  out += `  body: ${emitMesh(body)},\n`;
  out += `  wheel: ${emitMesh(wheel)},\n`;
  out += `  wheelOffsets: ${JSON.stringify(wheelOffsets)},\n`;
  out += `  texture: ${emitTex(tex)},\n`;
  out += '};\n';
  await Bun.write(outDir + 'assets-kenney-car.ts', out);
  console.log('  -> src/assets-kenney-car.ts');
}

// ===========================================================================
// skinned, animated characters (WEIGHTS|UV|COLOR|POS, no normal).
// The PSP GE has no bone-index palette, so each mesh is partitioned BY TRIANGLE
// into batches touching ≤ boneLimit joints, with weights remapped to local slots.
// Each clip is resampled to a fixed fps as per-joint local TRS.
// ===========================================================================

// f32/i8 typed array -> base64 of its raw bytes.
function abEmit(arr: Float32Array | Int8Array | Uint8Array): string {
  return b64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

// quaternion slerp (offline; xyzw) for clip resampling.
function qslerp(a: number[], b: number[], t: number): number[] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = b.slice();
  if (dot < 0) { for (let i = 0; i < 4; i++) bb[i] = -bb[i]; dot = -dot; }
  if (dot > 0.9995) {
    const o = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t];
    const l = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
    return [o[0] / l, o[1] / l, o[2] / l, o[3] / l];
  }
  const th0 = Math.acos(dot);
  const th = th0 * t;
  const s0 = Math.sin(th0 - th) / Math.sin(th0);
  const s1 = Math.sin(th) / Math.sin(th0);
  return [s0 * a[0] + s1 * bb[0], s0 * a[1] + s1 * bb[1], s0 * a[2] + s1 * bb[2], s0 * a[3] + s1 * bb[3]];
}

// Sample a glTF LINEAR channel (times[], flat values[]) at time t into `out`.
function sampleChannel(times: Float32Array, values: Float32Array, n: number, t: number, isRot: boolean, out: number[]): void {
  const last = times.length - 1;
  if (t <= times[0]) { for (let k = 0; k < n; k++) out[k] = values[k]; return; }
  if (t >= times[last]) { for (let k = 0; k < n; k++) out[k] = values[last * n + k]; return; }
  let i = 0;
  while (i < last && times[i + 1] < t) i++;
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  const a: number[] = [], b: number[] = [];
  for (let k = 0; k < n; k++) { a[k] = values[i * n + k]; b[k] = values[(i + 1) * n + k]; }
  if (isRot) { const q = qslerp(a, b, u); for (let k = 0; k < 4; k++) out[k] = q[k]; }
  else for (let k = 0; k < n; k++) out[k] = a[k] + (b[k] - a[k]) * u;
}

interface SkinnedBakeConfig {
  key: string;
  constName: string;
  typePrefix: string;
  sourceLabel: string;
  glbPath: string;
  texturePath: string;
  textureSize: number;
  scale: number;
  fps: number;
  boneLimit: 4 | 8;
  defaultClipName?: string;
  headerLines: string[];
}

function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

async function bakeSkinned(config: SkinnedBakeConfig): Promise<void> {
  const format = FMT_WEIGHTS | FMT_UV | FMT_COLOR | FMT_POS; // 0x001B
  const stride = vertexStride(format, config.boneLimit);
  const doc = await io.read(vendor + config.glbPath);
  const root = doc.getRoot();
  const skins = root.listSkins();
  if (!skins.length) throw new Error(`${config.key}: no skin found`);
  const joints: unknown[] = [];
  const jidx = new Map<unknown, number>();
  for (const skin of skins) {
    for (const j of skin.listJoints()) {
      if (!jidx.has(j)) {
        jidx.set(j, joints.length);
        joints.push(j);
      }
    }
  }
  const jointCount = joints.length;

  interface SkinnedPrimSrc {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prim: any;
    jointMap: number[];
    label: string;
  }
  const skinnedPrims: SkinnedPrimSrc[] = [];
  for (const n of root.listNodes()) {
    const nodeSkin = n.getSkin();
    const mesh = n.getMesh();
    if (!nodeSkin || !mesh) continue;
    const jointMap = nodeSkin.listJoints().map((j) => {
      const mapped = jidx.get(j);
      if (mapped === undefined) throw new Error(`${config.key}: skin ${nodeSkin.getName()} references unknown joint`);
      return mapped;
    });
    for (const [pi, prim] of mesh.listPrimitives().entries()) {
      skinnedPrims.push({ prim, jointMap, label: `${n.getName() || mesh.getName() || 'mesh'}#${pi}` });
    }
  }
  if (!skinnedPrims.length) {
    const mesh = root.listMeshes()[0];
    if (!mesh) throw new Error(`${config.key}: no skinned mesh nodes found`);
    const jointMap = joints.map((_, i) => i);
    for (const [pi, prim] of mesh.listPrimitives().entries()) {
      skinnedPrims.push({ prim, jointMap, label: `${mesh.getName() || 'mesh'}#${pi}` });
    }
  }
  if (jointCount > 64) throw new Error(`${config.key}: ${jointCount} joints > PSP native limit 64`);

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const inverseBindByJoint = new Map<unknown, number[]>();
  const e16: number[] = [];
  for (const skin of skins) {
    const ibmAcc = skin.getInverseBindMatrices();
    if (!ibmAcc) continue;
    for (const [i, j] of skin.listJoints().entries()) {
      if (!inverseBindByJoint.has(j)) {
        ibmAcc.getElement(i, e16);
        inverseBindByJoint.set(j, e16.slice());
      }
    }
  }

  // hierarchy parents + bind local TRS + inverse-bind matrices.
  const parents = new Int8Array(jointCount);
  const bindT = new Float32Array(jointCount * 3);
  const bindR = new Float32Array(jointCount * 4);
  const bindS = new Float32Array(jointCount * 3);
  joints.forEach((j: any, i) => {
    const p = j.getParentNode();
    parents[i] = p && jidx.has(p) ? (jidx.get(p) as number) : -1;
    const t = j.getTranslation(), r = j.getRotation(), s = j.getScale();
    bindT.set(t, i * 3); bindR.set(r, i * 4); bindS.set(s, i * 3);
  });
  const inverseBind = new Float32Array(jointCount * 16);
  for (let i = 0; i < jointCount; i++) inverseBind.set(inverseBindByJoint.get(joints[i]) ?? identity, i * 16);

  // mesh attributes. Indexed assets are deduped inside each bone batch so an
  // indexed human model does not inflate to three unique vertices per triangle.
  interface Batch { joints: Set<number>; tris: number[] }
  const outBatches: { jointTable: number[]; boneCount: number; mesh: Baked }[] = [];
  let totalTriCount = 0;
  const je: number[] = [0, 0, 0, 0], we: number[] = [0, 0, 0, 0];
  const pe: number[] = [0, 0, 0], ue: number[] = [0, 0];

  for (const src of skinnedPrims) {
    const prim = src.prim;
    const POS = prim.getAttribute('POSITION');
    const UV = prim.getAttribute('TEXCOORD_0');
    const JNT = prim.getAttribute('JOINTS_0');
    const WTS = prim.getAttribute('WEIGHTS_0');
    if (!POS || !JNT || !WTS) throw new Error(`${config.key}/${src.label}: POSITION/JOINTS_0/WEIGHTS_0 required`);
    const idxA = prim.getIndices();
    const srcIndices = idxA ? idxA.getArray() : undefined;
    const triCount = srcIndices ? srcIndices.length / 3 : POS.getCount() / 3;
    totalTriCount += triCount;
    const srcAt = (tri: number, corner: number): number =>
      srcIndices ? srcIndices[tri * 3 + corner] : tri * 3 + corner;

    const mappedJoint = (localJoint: number): number => {
      const mapped = src.jointMap[localJoint];
      if (mapped === undefined) throw new Error(`${config.key}/${src.label}: JOINTS_0 references joint ${localJoint} outside skin`);
      return mapped;
    };
    const vertJoints = (v: number): number[] => {
      JNT.getElement(v, je); WTS.getElement(v, we);
      const out: number[] = [];
      for (let k = 0; k < 4; k++) {
        if (we[k] > 0) {
          const j = mappedJoint(je[k]);
          if (!out.includes(j)) out.push(j);
        }
      }
      return out;
    };

    // --- greedy bone-batch partition (by triangle) ---
    const batches: Batch[] = [];
    for (let t = 0; t < triCount; t++) {
      const set = new Set<number>();
      for (let c = 0; c < 3; c++) for (const j of vertJoints(srcAt(t, c))) set.add(j);
      if (set.size > config.boneLimit) throw new Error(`${config.key}/${src.label} tri ${t} needs ${set.size} joints > limit ${config.boneLimit}`);
      let best = -1, bestNew = Infinity;
      for (let b = 0; b < batches.length; b++) {
        const u = new Set(batches[b].joints);
        for (const j of set) u.add(j);
        if (u.size <= config.boneLimit) {
          const nw = u.size - batches[b].joints.size;
          if (nw < bestNew) { bestNew = nw; best = b; }
        }
      }
      if (best < 0) batches.push({ joints: new Set(set), tris: [t] });
      else { for (const j of set) batches[best].joints.add(j); batches[best].tris.push(t); }
    }

    // --- build each batch's interleaved VB (weights scattered to local slots) ---
    for (const batch of batches) {
      const table = [...batch.joints].sort((a, b) => a - b);
      while (table.length < config.boneLimit) table.push(0); // padding slots get weight 0
      const local = new Map<number, number>();
      table.forEach((g, i) => { if (!local.has(g)) local.set(g, i); });

      const localBySource = new Map<number, number>();
      const sourceVerts: number[] = [];
      const localIndices: number[] = [];
      for (const t of batch.tris) {
        for (let c = 0; c < 3; c++) {
          const srcVert = srcAt(t, c);
          let li = localBySource.get(srcVert);
          if (li === undefined) {
            li = sourceVerts.length;
            localBySource.set(srcVert, li);
            sourceVerts.push(srcVert);
          }
          localIndices.push(li);
        }
      }
      if (sourceVerts.length > 65535) throw new Error(`${config.key}/${src.label}: batch has ${sourceVerts.length} verts > u16`);

      const nv = sourceVerts.length;
      const vbuf = new Uint8Array(nv * stride);
      const dv = new DataView(vbuf.buffer);
      const indices = new Uint16Array(localIndices);
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let vi = 0; vi < sourceVerts.length; vi++) {
        const v = sourceVerts[vi];
        POS.getElement(v, pe);
        if (UV) UV.getElement(v, ue);
        else { ue[0] = 0; ue[1] = 0; }
        JNT.getElement(v, je); WTS.getElement(v, we);
        // scatter the 4 source (joint,weight) into local bone slots.
        const lw = new Array<number>(config.boneLimit).fill(0);
        for (let k = 0; k < 4; k++) {
          if (we[k] > 0) {
            const slot = local.get(mappedJoint(je[k]));
            if (slot !== undefined) lw[slot] += we[k];
          }
        }
        let o = vi * stride;
        for (let k = 0; k < config.boneLimit; k++) dv.setFloat32(o + k * 4, lw[k], true);
        o += config.boneLimit * 4;
        dv.setFloat32(o, ue[0], true); dv.setFloat32(o + 4, ue[1], true);
        o += 8;
        dv.setUint32(o, NO_TINT >>> 0, true);
        o += 4;
        dv.setFloat32(o, pe[0], true); dv.setFloat32(o + 4, pe[1], true); dv.setFloat32(o + 8, pe[2], true);
        for (let a = 0; a < 3; a++) { if (pe[a] < min[a]) min[a] = pe[a]; if (pe[a] > max[a]) max[a] = pe[a]; }
      }
      outBatches.push({
        jointTable: table.slice(0, config.boneLimit),
        boneCount: config.boneLimit,
        mesh: { format, stride, vertexCount: nv, weightCount: config.boneLimit, vertices: vbuf, indices, triCount: indices.length / 3, aabb: { min, max } },
      });
    }
  }
  console.log(`  ${config.key}: ${outBatches.length} bone-batches across ${skinnedPrims.length} prims (limit ${config.boneLimit}), tris ${totalTriCount}`);

  // --- resample clips to fixed fps as per-joint local TRS ---
  interface Clip { name: string; fps: number; frameCount: number; t: Float32Array; r: Float32Array; s: Float32Array }
  const clips: Clip[] = [];
  for (const [animIndex, anim] of root.listAnimations().entries()) {
    // gather channels: per joint, per path, (times, values).
    const chans = anim.listChannels();
    let dur = 0;
    interface Ch { joint: number; path: string; times: Float32Array; values: Float32Array; n: number }
    const cs: Ch[] = [];
    for (const ch of chans) {
      const joint = jidx.get(ch.getTargetNode());
      if (joint === undefined) continue;
      const samp = ch.getSampler();
      const times = samp.getInput().getArray() as Float32Array;
      const values = samp.getOutput().getArray() as Float32Array;
      const path = ch.getTargetPath();
      const n = path === 'rotation' ? 4 : 3;
      cs.push({ joint, path, times, values, n });
      dur = Math.max(dur, times[times.length - 1]);
    }
    const frameCount = Math.max(2, Math.round(dur * config.fps) + 1);
    const T = new Float32Array(frameCount * jointCount * 3);
    const R = new Float32Array(frameCount * jointCount * 4);
    const S = new Float32Array(frameCount * jointCount * 3);
    // initialize every frame to the bind pose, then overlay animated channels.
    for (let f = 0; f < frameCount; f++) {
      for (let j = 0; j < jointCount; j++) {
        T.set(bindT.subarray(j * 3, j * 3 + 3), (f * jointCount + j) * 3);
        R.set(bindR.subarray(j * 4, j * 4 + 4), (f * jointCount + j) * 4);
        S.set(bindS.subarray(j * 3, j * 3 + 3), (f * jointCount + j) * 3);
      }
    }
    const out: number[] = [0, 0, 0, 0];
    for (let f = 0; f < frameCount; f++) {
      const time = frameCount > 1 ? (dur * f) / (frameCount - 1) : 0;
      for (const ch of cs) {
        sampleChannel(ch.times, ch.values, ch.n, time, ch.path === 'rotation', out);
        const base = (f * jointCount + ch.joint);
        if (ch.path === 'translation') T.set([out[0], out[1], out[2]], base * 3);
        else if (ch.path === 'rotation') R.set([out[0], out[1], out[2], out[3]], base * 4);
        else if (ch.path === 'scale') S.set([out[0], out[1], out[2]], base * 3);
      }
    }
    const animName = anim.getName() || (animIndex === 0 && config.defaultClipName ? config.defaultClipName : `Clip${animIndex + 1}`);
    clips.push({ name: animName, fps: config.fps, frameCount, t: T, r: R, s: S });
    console.log(`    clip ${animName}: ${frameCount} frames @${config.fps}fps`);
  }

  const tex = bakeTexture(await Bun.file(vendor + config.texturePath).arrayBuffer(), config.textureSize);

  // --- emit skinned asset module ---
  let out = `// AUTO-GENERATED by bake/bake-gltf.ts from ${config.sourceLabel}.\n`;
  for (const line of config.headerLines) out += `// ${line}\n`;
  out += "import { unb64 } from './b64';\nimport { PSM_8888 } from './g3d';\nimport type { BakedMesh } from './mesh';\n";
  out += "import type { BakedTexture } from './assets-kenney-car';\n\n";
  out += `export interface ${config.typePrefix}Batch { jointTable: number[]; boneCount: number; mesh: BakedMesh }\n`;
  out += `export interface ${config.typePrefix}Clip { fps: number; frameCount: number; t: Float32Array; r: Float32Array; s: Float32Array }\n\n`;
  out += `export const ${config.constName}: {\n`;
  out += '  scale: number; jointCount: number; jointParents: Int8Array;\n';
  out += '  inverseBindMatrices: Float32Array;\n';
  out += '  bind: { t: Float32Array; r: Float32Array; s: Float32Array };\n';
  out += `  boneLimit: number; batches: ${config.typePrefix}Batch[]; texture: BakedTexture;\n`;
  out += `  clips: Record<string, ${config.typePrefix}Clip>;\n} = {\n`;
  out += `  scale: ${config.scale}, jointCount: ${jointCount}, boneLimit: ${config.boneLimit},\n`;
  out += `  jointParents: new Int8Array(unb64('${abEmit(parents)}').buffer),\n`;
  out += `  inverseBindMatrices: new Float32Array(unb64('${abEmit(inverseBind)}').buffer),\n`;
  out += `  bind: {\n    t: new Float32Array(unb64('${abEmit(bindT)}').buffer),\n`;
  out += `    r: new Float32Array(unb64('${abEmit(bindR)}').buffer),\n`;
  out += `    s: new Float32Array(unb64('${abEmit(bindS)}').buffer),\n  },\n`;
  out += '  batches: [\n';
  for (const b of outBatches) {
    out += `    { jointTable: ${JSON.stringify(b.jointTable)}, boneCount: ${b.boneCount}, mesh: ${emitMesh(b.mesh)} },\n`;
  }
  out += '  ],\n';
  out += '  clips: {\n';
  for (const c of clips) {
    out += `    ${propKey(c.name)}: { fps: ${c.fps}, frameCount: ${c.frameCount},\n`;
    out += `      t: new Float32Array(unb64('${abEmit(c.t)}').buffer),\n`;
    out += `      r: new Float32Array(unb64('${abEmit(c.r)}').buffer),\n`;
    out += `      s: new Float32Array(unb64('${abEmit(c.s)}').buffer) },\n`;
  }
  out += '  },\n';
  out += `  texture: ${emitTex(tex)},\n`;
  out += '};\n';
  const outFile = `assets-${config.key}.ts`;
  await Bun.write(outDir + outFile, out);
  console.log(`  -> src/${outFile}`);
}

async function bakeFox(): Promise<void> {
  await bakeSkinned({
    key: 'fox',
    constName: 'FOX',
    typePrefix: 'Fox',
    sourceLabel: 'Khronos Fox (CC-BY-4.0)',
    glbPath: 'fox/Fox.glb',
    texturePath: 'fox/Texture.png',
    textureSize: 128,
    scale: 0.03,
    fps: 24,
    boneLimit: 4,
    headerLines: [
      '"Fox" by PixelMannen (CC0), rigged/animated by tomkranis (CC BY 4.0),',
      'glTF by @AsoboStudio + @scurest (CC BY 4.0). Attribution REQUIRED — see',
      'assets/vendor/CREDITS.md. Skinned: bone-batch partitioned for the PSP GE.',
    ],
  });
}

async function bakeCesiumMan(): Promise<void> {
  await bakeSkinned({
    key: 'cesium-man',
    constName: 'CESIUM_MAN',
    typePrefix: 'CesiumMan',
    sourceLabel: 'Khronos Cesium Man (CC-BY-4.0 with trademark limitations)',
    glbPath: 'cesium-man/CesiumMan.glb',
    texturePath: 'cesium-man/CesiumMan.png',
    textureSize: 256,
    scale: 4.3,
    fps: 24,
    boneLimit: 8,
    defaultClipName: 'Walk',
    headerLines: [
      'Cesium Man © 2017, Cesium, CC BY 4.0 International with trademark limitations.',
      'Embedded JPEG texture was extracted and converted to PNG for this deterministic bake.',
      'Attribution REQUIRED — see assets/vendor/CREDITS.md.',
    ],
  });
}

async function bakeThreeSoldier(): Promise<void> {
  await bakeSkinned({
    key: 'three-soldier',
    constName: 'THREE_SOLDIER',
    typePrefix: 'ThreeSoldier',
    sourceLabel: 'three.js Soldier.glb (MIT)',
    glbPath: 'three-soldier/Soldier.glb',
    texturePath: 'three-soldier/Soldier.png',
    textureSize: 256,
    scale: 0.012,
    fps: 24,
    boneLimit: 8,
    defaultClipName: 'Walk',
    headerLines: [
      'Soldier.glb from the three.js examples model set, MIT licensed.',
      'The embedded JPEG diffuse texture was extracted and converted to PNG for',
      'DreamCart deterministic baking. See assets/vendor/CREDITS.md.',
    ],
  });
}

console.log('bake-gltf: baking vendored glTF assets...');
await bakeNature();
await bakeCar();
await bakeFox();
await bakeCesiumMan();
await bakeThreeSoldier();
console.log('bake-gltf: done.');

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
  FMT_POS, FMT_COLOR, FMT_NORMAL, FMT_UV, vertexStride, colorToABGR, NO_TINT,
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
    `    format: ${m.format}, stride: ${m.stride}, vertexCount: ${m.vertexCount}, triCount: ${m.triCount},\n` +
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

console.log('bake-gltf: baking vendored glTF assets...');
await bakeNature();
await bakeCar();
console.log('bake-gltf: done.');

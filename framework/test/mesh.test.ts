import { FMT_COLOR, FMT_POS, vertexStride } from '../src/g3d';
import { Mesh } from '../src/mesh';

function assert(ok: boolean, msg: string): void {
  if (!ok) throw new Error(msg);
}

function f32(dv: DataView, off: number): number {
  return dv.getFloat32(off, true);
}

const room = Mesh.interiorBox(20, 6, 20, Mesh.solid(0xffffff), 0.5);
const stride = vertexStride(room.format);

assert(room.format === (FMT_POS | FMT_COLOR), 'interiorBox should use POS|COLOR');
assert(stride === 16, 'interiorBox should keep the v1 stride');
assert(room.vertexCount === 5494, `unexpected interiorBox vertex count: ${room.vertexCount}`);
assert(room.indices.length === 30720, `unexpected interiorBox index count: ${room.indices.length}`);

const dv = new DataView(room.vertices);
let maxSpan = 0;
for (let i = 0; i + 2 < room.indices.length; i += 3) {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let k = 0; k < 3; k++) {
    const o = room.indices[i + k] * stride + 4;
    xs.push(f32(dv, o));
    ys.push(f32(dv, o + 4));
    zs.push(f32(dv, o + 8));
  }
  maxSpan = Math.max(
    maxSpan,
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    Math.max(...zs) - Math.min(...zs),
  );
}
assert(maxSpan <= 0.50001, `interiorBox triangles are too large: ${maxSpan}`);

const floor = Mesh.gridPlane(4, 4, 0x808080, 0.5);
assert(floor.format === (FMT_POS | FMT_COLOR), 'gridPlane should use POS|COLOR');
assert(floor.vertexCount === 81, `unexpected gridPlane vertex count: ${floor.vertexCount}`);
assert(floor.indices.length === 384, `unexpected gridPlane index count: ${floor.indices.length}`);

console.log('PASS  mesh.test');

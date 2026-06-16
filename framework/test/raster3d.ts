// Software reference rasterizer — the deterministic 3D oracle for golden tests.
// It implements the exact `g3d` contract (uploadMesh/freeMesh/submit), parses the
// SAME little-endian command buffer the native hosts consume, and renders into the
// SAME W×H×4 RGBA framebuffer the 2D gfx mock writes to (so the 3D pass lands
// underneath and the gfx.fillRect HUD draws on top). Each native host is expected
// to *approximate* this image. It also records the raw uploadMesh+submit byte
// stream for the byte-exact `.dc3d` draw-list golden.
//
// Conventions (must match framework/src/math.ts + the hosts):
//   column-major matrices · reversed-Z (clear depth 0, keep fragment if z >= zbuf)
//   NDC is Y-up (the shared projection is NOT pre-flipped); this rasterizer applies
//   the Y-flip in its viewport (toScreen), exactly as each native host's viewport
//   does. No back-face culling (depth resolves occlusion), matching all hosts.
import {
  DC3D_MAGIC, OP_SET_CAMERA, OP_DRAW, OP_IMM_TRIS,
  FMT_COLOR, FMT_POS, vertexStride,
} from '../src/g3d';
import { Mat4 } from '../src/math';

interface DecodedMesh {
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  cr: Uint8Array;
  cg: Uint8Array;
  cb: Uint8Array;
  indices: Uint16Array; // empty -> sequential
}

/** A vertex in homogeneous clip space (pre-divide) carrying its color. */
interface ClipVert {
  x: number;
  y: number;
  z: number;
  w: number;
  r: number;
  g: number;
  b: number;
}

const NEAR_EPS = 1e-5;

function lerpClip(a: ClipVert, b: ClipVert, t: number): ClipVert {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    w: a.w + (b.w - a.w) * t,
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/** Sutherland-Hodgman clip of a polygon against the near plane (w >= EPS). */
function clipNear(poly: ClipVert[]): ClipVert[] {
  const out: ClipVert[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const aIn = a.w >= NEAR_EPS;
    const bIn = b.w >= NEAR_EPS;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (NEAR_EPS - a.w) / (b.w - a.w);
      out.push(lerpClip(a, b, t));
    }
  }
  return out;
}

// Background the 3D pass clears the color buffer to (the hosts match this).
const BG_R = 0x10;
const BG_G = 0x14;
const BG_B = 0x1e;

export class Raster3D {
  private buf: Uint8Array;
  private W: number;
  private H: number;
  private depth: Float32Array;
  private meshes: DecodedMesh[] = [];
  private viewProj: number[] = Mat4.identity();
  private chunks: Uint8Array[] = [];
  used = false;

  constructor(buf: Uint8Array, w: number, h: number) {
    this.buf = buf;
    this.W = w;
    this.H = h;
    this.depth = new Float32Array(w * h);
  }

  /** Concatenated uploadMesh + submit bytes, for the .dc3d golden. */
  recorded(): Uint8Array {
    let n = 0;
    for (const c of this.chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  uploadMesh(vertices: ArrayBuffer, indices: ArrayBuffer | null, format: number): number {
    // record (tag 0x55 'U', then format, vlen, ilen, payloads)
    const vbytes = new Uint8Array(vertices.slice(0));
    const ibytes = indices ? new Uint8Array(indices.slice(0)) : new Uint8Array(0);
    const head = new Uint8Array(13);
    const hv = new DataView(head.buffer);
    head[0] = 0x55;
    hv.setUint32(1, format, true);
    hv.setUint32(5, vbytes.length, true);
    hv.setUint32(9, ibytes.length, true);
    this.chunks.push(head, vbytes, ibytes);

    if (!(format & FMT_POS) || !(format & FMT_COLOR)) {
      throw new Error('raster3d: only POS|COLOR meshes supported');
    }
    const stride = vertexStride(format);
    const n = vbytes.length / stride;
    const dv = new DataView(vertices);
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    const pz = new Float32Array(n);
    const cr = new Uint8Array(n);
    const cg = new Uint8Array(n);
    const cb = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      const abgr = dv.getUint32(o, true);
      cr[i] = abgr & 255;
      cg[i] = (abgr >> 8) & 255;
      cb[i] = (abgr >> 16) & 255;
      px[i] = dv.getFloat32(o + 4, true);
      py[i] = dv.getFloat32(o + 8, true);
      pz[i] = dv.getFloat32(o + 12, true);
    }
    const idx = indices ? new Uint16Array(indices.slice(0)) : new Uint16Array(0);
    this.meshes.push({ px, py, pz, cr, cg, cb, indices: idx });
    return this.meshes.length - 1;
  }

  freeMesh(_handle: number): void {
    /* reference rasterizer keeps everything; no-op */
  }

  submit(buffer: ArrayBuffer, byteLength: number): void {
    this.chunks.push(new Uint8Array(buffer.slice(0, byteLength)));
    this.used = true;
    const dv = new DataView(buffer, 0, byteLength);
    if (dv.getUint32(0, true) !== DC3D_MAGIC) throw new Error('raster3d: bad magic');
    const recordCount = dv.getUint16(6, true);

    // 3D pass clears color + depth.
    const buf = this.buf;
    for (let i = 0; i < this.W * this.H; i++) {
      buf[i * 4] = BG_R;
      buf[i * 4 + 1] = BG_G;
      buf[i * 4 + 2] = BG_B;
      buf[i * 4 + 3] = 255;
      this.depth[i] = 0;
    }

    let o = 8;
    for (let r = 0; r < recordCount; r++) {
      const op = dv.getUint16(o, true);
      const words = dv.getUint16(o + 2, true);
      const base = o + 4;
      o = base + words * 4;
      if (op === OP_SET_CAMERA) {
        const m = new Array<number>(16);
        for (let i = 0; i < 16; i++) m[i] = dv.getFloat32(base + i * 4, true);
        this.viewProj = m;
      } else if (op === OP_DRAW) {
        const handle = dv.getUint32(base, true);
        const model = new Array<number>(16);
        for (let i = 0; i < 16; i++) model[i] = dv.getFloat32(base + 8 + i * 4, true);
        this.drawMesh(this.meshes[handle], Mat4.multiply(this.viewProj, model));
      } else if (op === OP_IMM_TRIS) {
        // The native hosts DO render OP_IMM_TRIS, but this reference rasterizer
        // doesn't yet — so rather than silently produce a golden that omits the
        // dynamic geometry (validating the wrong image), fail loudly. Wire an
        // immTris path here when the first game starts emitting it.
        throw new Error('raster3d: OP_IMM_TRIS not implemented — golden would be wrong');
      }
    }
  }

  private drawMesh(mesh: DecodedMesh, mvp: number[]): void {
    const n = mesh.px.length;
    // Clip-space coords (before perspective divide) + color, per vertex.
    const cx = new Float64Array(n);
    const cy = new Float64Array(n);
    const cz = new Float64Array(n);
    const cw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = mesh.px[i];
      const y = mesh.py[i];
      const z = mesh.pz[i];
      cx[i] = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
      cy[i] = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
      cz[i] = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
      cw[i] = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
    }
    const count = mesh.indices.length > 0 ? mesh.indices.length : n;
    for (let t = 0; t < count; t += 3) {
      const i0 = mesh.indices.length > 0 ? mesh.indices[t] : t;
      const i1 = mesh.indices.length > 0 ? mesh.indices[t + 1] : t + 1;
      const i2 = mesh.indices.length > 0 ? mesh.indices[t + 2] : t + 2;
      const poly: ClipVert[] = [
        { x: cx[i0], y: cy[i0], z: cz[i0], w: cw[i0], r: mesh.cr[i0], g: mesh.cg[i0], b: mesh.cb[i0] },
        { x: cx[i1], y: cy[i1], z: cz[i1], w: cw[i1], r: mesh.cr[i1], g: mesh.cg[i1], b: mesh.cb[i1] },
        { x: cx[i2], y: cy[i2], z: cz[i2], w: cw[i2], r: mesh.cr[i2], g: mesh.cg[i2], b: mesh.cb[i2] },
      ];
      // Near-plane clip (keep w >= EPS) so triangles straddling the camera —
      // big ground planes, room floors — survive instead of being dropped.
      const clipped = clipNear(poly);
      // Fan-triangulate the clipped polygon, divide, viewport, raster.
      for (let k = 2; k < clipped.length; k++) {
        const a = clipped[0];
        const b = clipped[k - 1];
        const c = clipped[k];
        this.tri(
          ...this.toScreen(a),
          ...this.toScreen(b),
          ...this.toScreen(c),
        );
      }
    }
  }

  private toScreen(v: ClipVert): [number, number, number, number, number, number] {
    const inv = v.w !== 0 ? 1 / v.w : 0;
    return [
      (v.x * inv * 0.5 + 0.5) * this.W,
      // NDC is Y-up; this framebuffer is Y-down, so flip Y here in the viewport
      // (the shared projection is NOT pre-flipped — see math.ts).
      (0.5 - v.y * inv * 0.5) * this.H,
      v.z * inv,
      v.r,
      v.g,
      v.b,
    ];
  }

  private tri(
    x0: number, y0: number, z0: number, r0: number, g0: number, b0: number,
    x1: number, y1: number, z1: number, r1: number, g1: number, b1: number,
    x2: number, y2: number, z2: number, r2: number, g2: number, b2: number,
  ): void {
    const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (area === 0) return;
    const invArea = 1 / area;
    let minX = Math.floor(Math.min(x0, x1, x2));
    let maxX = Math.ceil(Math.max(x0, x1, x2));
    let minY = Math.floor(Math.min(y0, y1, y2));
    let maxY = Math.ceil(Math.max(y0, y1, y2));
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > this.W) maxX = this.W;
    if (maxY > this.H) maxY = this.H;
    const buf = this.buf;
    const depth = this.depth;
    for (let y = minY; y < maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x < maxX; x++) {
        const px = x + 0.5;
        // barycentric weights (sign-normalized so winding doesn't matter)
        let w0 = ((x1 - px) * (y2 - py) - (y1 - py) * (x2 - px)) * invArea;
        let w1 = ((x2 - px) * (y0 - py) - (y2 - py) * (x0 - px)) * invArea;
        let w2 = ((x0 - px) * (y1 - py) - (y0 - py) * (x1 - px)) * invArea;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * z0 + w1 * z1 + w2 * z2;
        const di = y * this.W + x;
        if (z < depth[di]) continue; // reversed-Z: keep nearer (greater)
        depth[di] = z;
        const o = di * 4;
        buf[o] = (w0 * r0 + w1 * r1 + w2 * r2) | 0;
        buf[o + 1] = (w0 * g0 + w1 * g1 + w2 * g2) | 0;
        buf[o + 2] = (w0 * b0 + w1 * b1 + w2 * b2) | 0;
        buf[o + 3] = 255;
      }
    }
  }
}

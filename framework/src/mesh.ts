// Mesh geometry for the 3D layer. Geometry is generated procedurally (cube, box,
// plane) — no asset files are needed for the cube/racing/FPS examples. A Mesh
// holds interleaved vertex bytes (v1 layout: [color u32 ABGR][pos 3 f32], stride
// 16) + a Uint16 index buffer, and lazily uploads itself to the host on first use,
// caching the returned handle.
import {
  FMT_COLOR, FMT_NORMAL, FMT_POS, FMT_UV, colorToABGR, vertexStride,
} from './g3d';
import { hasG3d } from './host3d';
import type { Color } from './color';

const V1_FORMAT = FMT_POS | FMT_COLOR;
const V1_STRIDE = 16;

/** Accumulates vertices (pos + color) and triangle indices, then bakes bytes. */
export class MeshBuilder {
  private px: number[] = [];
  private py: number[] = [];
  private pz: number[] = [];
  private col: number[] = []; // ABGR u32
  private idx: number[] = [];

  /** Add a vertex, returns its index. */
  vertex(x: number, y: number, z: number, color: Color): number {
    this.px.push(x);
    this.py.push(y);
    this.pz.push(z);
    this.col.push(colorToABGR(color));
    return this.px.length - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Two triangles (a,b,c)+(a,c,d) for a quad given in winding order. */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  build(): Mesh {
    const n = this.px.length;
    const vbuf = new ArrayBuffer(n * V1_STRIDE);
    const dv = new DataView(vbuf);
    for (let i = 0; i < n; i++) {
      const o = i * V1_STRIDE;
      dv.setUint32(o, this.col[i] >>> 0, true);
      dv.setFloat32(o + 4, this.px[i], true);
      dv.setFloat32(o + 8, this.py[i], true);
      dv.setFloat32(o + 12, this.pz[i], true);
    }
    const ibuf = new Uint16Array(this.idx);
    return new Mesh(vbuf, ibuf, V1_FORMAT);
  }
}

/**
 * Builder for textured + lit geometry: each vertex carries position, color, and
 * optionally a UV (FMT_UV) and a normal (FMT_NORMAL). The format is inferred from
 * which attributes the first vertex supplies; bytes are packed in the GE's FIXED
 * component order [uv][color][normal][pos] (see g3d.ts). Procedural meshes (the
 * M1 textured/lit cube, the M6 heightmap terrain) use this; baked glTF assets
 * pack their own bytes in bake-gltf.ts.
 */
export class TexMeshBuilder {
  private x: number[] = [];
  private y: number[] = [];
  private z: number[] = [];
  private col: number[] = []; // ABGR u32
  private u: number[] = [];
  private v: number[] = [];
  private nx: number[] = [];
  private ny: number[] = [];
  private nz: number[] = [];
  private idx: number[] = [];
  private withUV: boolean;
  private withNormal: boolean;

  /** `uv` and `normal` toggles fix the format for every vertex in this builder. */
  constructor(opts: { uv?: boolean; normal?: boolean } = {}) {
    this.withUV = opts.uv ?? true;
    this.withNormal = opts.normal ?? true;
  }

  /**
   * Add a vertex. `u/v` are used iff the builder has UV; `nx/ny/nz` iff it has
   * normals. Returns the vertex index.
   */
  vertex(
    x: number, y: number, z: number, color: Color,
    u = 0, v = 0, nx = 0, ny = 0, nz = 0,
  ): number {
    this.x.push(x);
    this.y.push(y);
    this.z.push(z);
    this.col.push(colorToABGR(color));
    this.u.push(u);
    this.v.push(v);
    this.nx.push(nx);
    this.ny.push(ny);
    this.nz.push(nz);
    return this.x.length - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  build(): Mesh {
    let format = FMT_POS | FMT_COLOR;
    if (this.withUV) format |= FMT_UV;
    if (this.withNormal) format |= FMT_NORMAL;
    const stride = vertexStride(format);
    const n = this.x.length;
    const vbuf = new ArrayBuffer(n * stride);
    const dv = new DataView(vbuf);
    for (let i = 0; i < n; i++) {
      let o = i * stride;
      // GE order: [uv][color][normal][pos].
      if (this.withUV) {
        dv.setFloat32(o, this.u[i], true);
        dv.setFloat32(o + 4, this.v[i], true);
        o += 8;
      }
      dv.setUint32(o, this.col[i] >>> 0, true);
      o += 4;
      if (this.withNormal) {
        dv.setFloat32(o, this.nx[i], true);
        dv.setFloat32(o + 4, this.ny[i], true);
        dv.setFloat32(o + 8, this.nz[i], true);
        o += 12;
      }
      dv.setFloat32(o, this.x[i], true);
      dv.setFloat32(o + 4, this.y[i], true);
      dv.setFloat32(o + 8, this.z[i], true);
    }
    return new Mesh(vbuf, new Uint16Array(this.idx), format);
  }
}

export class Mesh {
  vertices: ArrayBuffer;
  indices: Uint16Array;
  format: number;
  private _handle = -1;

  constructor(vertices: ArrayBuffer, indices: Uint16Array, format: number) {
    this.vertices = vertices;
    this.indices = indices;
    this.format = format;
  }

  get vertexCount(): number {
    return this.vertices.byteLength / vertexStride(this.format);
  }

  /** Upload to the host on first call; returns -1 when there is no 3D host. */
  handle(): number {
    if (this._handle < 0 && hasG3d()) {
      this._handle = globalThis.g3d!.uploadMesh(
        this.vertices,
        this.indices.buffer as ArrayBuffer,
        this.format,
      );
    }
    return this._handle;
  }

  // ---- primitives ----

  /** Axis-aligned cube centered at origin. `faceColors` = [+X,-X,+Y,-Y,+Z,-Z]. */
  static cube(size: number, faceColors: Color[]): Mesh {
    return Mesh.box(size, size, size, faceColors);
  }

  /** Axis-aligned box centered at origin; 6 distinct face colors (CCW outward). */
  static box(w: number, h: number, d: number, faceColors: Color[]): Mesh {
    const hx = w / 2;
    const hy = h / 2;
    const hz = d / 2;
    const b = new MeshBuilder();
    // Each face is 4 fresh vertices so it carries a flat color. Winding is CCW
    // when viewed from outside the box (right-handed world).
    const face = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
      dx: number, dy: number, dz: number,
      color: Color,
    ) => {
      const i0 = b.vertex(ax, ay, az, color);
      const i1 = b.vertex(bx, by, bz, color);
      const i2 = b.vertex(cx, cy, cz, color);
      const i3 = b.vertex(dx, dy, dz, color);
      b.quad(i0, i1, i2, i3);
    };
    // +X
    face(hx, -hy, hz, hx, -hy, -hz, hx, hy, -hz, hx, hy, hz, faceColors[0]);
    // -X
    face(-hx, -hy, -hz, -hx, -hy, hz, -hx, hy, hz, -hx, hy, -hz, faceColors[1]);
    // +Y
    face(-hx, hy, hz, hx, hy, hz, hx, hy, -hz, -hx, hy, -hz, faceColors[2]);
    // -Y
    face(-hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz, faceColors[3]);
    // +Z
    face(-hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz, faceColors[4]);
    // -Z
    face(hx, -hy, -hz, -hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz, faceColors[5]);
    return b.build();
  }

  /**
   * Axis-aligned textured + lit cube centered at origin. Every face gets full
   * 0..1 UVs (so a whole texture maps onto each face) and an outward normal, so
   * it exercises FMT_UV + FMT_NORMAL (the M1 texture/light path). `tint` is the
   * per-vertex base color the texture modulates (default white = texture as-is).
   */
  static texturedCube(size: number, tint: Color = 0xffffff): Mesh {
    const h = size / 2;
    const b = new TexMeshBuilder({ uv: true, normal: true });
    const face = (
      nx: number, ny: number, nz: number,
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
      dx: number, dy: number, dz: number,
    ) => {
      // a=(0,0) b=(1,0) c=(1,1) d=(0,1), CCW from outside.
      const i0 = b.vertex(ax, ay, az, tint, 0, 0, nx, ny, nz);
      const i1 = b.vertex(bx, by, bz, tint, 1, 0, nx, ny, nz);
      const i2 = b.vertex(cx, cy, cz, tint, 1, 1, nx, ny, nz);
      const i3 = b.vertex(dx, dy, dz, tint, 0, 1, nx, ny, nz);
      b.quad(i0, i1, i2, i3);
    };
    face(1, 0, 0, h, -h, h, h, -h, -h, h, h, -h, h, h, h); // +X
    face(-1, 0, 0, -h, -h, -h, -h, -h, h, -h, h, h, -h, h, -h); // -X
    face(0, 1, 0, -h, h, h, h, h, h, h, h, -h, -h, h, -h); // +Y
    face(0, -1, 0, -h, -h, -h, h, -h, -h, h, -h, h, -h, -h, h); // -Y
    face(0, 0, 1, -h, -h, h, h, -h, h, h, h, h, -h, h, h); // +Z
    face(0, 0, -1, h, -h, -h, -h, -h, -h, -h, h, -h, h, h, -h); // -Z
    return b.build();
  }

  /** Flat horizontal plane on Y=0 spanning [-w/2,w/2] x [-d/2,d/2], single color. */
  static plane(w: number, d: number, color: Color): Mesh {
    const hx = w / 2;
    const hz = d / 2;
    const b = new MeshBuilder();
    const i0 = b.vertex(-hx, 0, hz, color);
    const i1 = b.vertex(hx, 0, hz, color);
    const i2 = b.vertex(hx, 0, -hz, color);
    const i3 = b.vertex(-hx, 0, -hz, color);
    b.quad(i0, i1, i2, i3);
    return b.build();
  }
}

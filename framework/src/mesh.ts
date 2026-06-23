// Mesh geometry for the 3D layer. Geometry is generated procedurally (cube, box,
// plane) — no asset files are needed for the cube/racing/FPS examples. A Mesh
// holds interleaved vertex bytes (v1 layout: [color u32 ABGR][pos 3 f32], stride
// 16) + a Uint16 index buffer, and lazily uploads itself to the host on first use,
// caching the returned handle.
import {
  FMT_COLOR, FMT_NORMAL, FMT_POS, FMT_UV, FMT_WEIGHTS, colorToABGR, vertexStride,
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

/**
 * A mesh baked offline from glTF (framework/bake/bake-gltf.ts): interleaved
 * GE-order vertex bytes + a triangle index list, plus its format/stride/AABB.
 * The generated assets-*.ts modules export these; `meshFromBaked` wraps one into
 * an uploadable Mesh (call once and cache — uploads on first draw).
 */
export interface BakedMesh {
  format: number;
  stride: number;
  vertexCount: number;
  weightCount: number; // f32 bone weights/vertex when FMT_WEIGHTS (else 0)
  vertices: Uint8Array; // interleaved, GE order, length = stride*vertexCount
  indices: Uint16Array; // triangle list
  triCount: number;
  aabb: { min: [number, number, number]; max: [number, number, number] };
}

/** Wrap a BakedMesh into an uploadable Mesh (no copy — reuses the decoded bytes). */
export function meshFromBaked(b: BakedMesh): Mesh {
  return new Mesh(b.vertices.buffer as ArrayBuffer, b.indices, b.format, b.weightCount);
}

/**
 * Bake many meshes (each at a world transform) into ONE static POS|COLOR mesh, so
 * a clump of instanced scenery (e.g. roadside props) draws as a SINGLE GE call
 * instead of one per instance — the per-draw GE cost dominates large scenes, and
 * real PSP T&L eats the merged vertex count for free. UV/normal are dropped
 * (merged geometry is for unlit, untextured scenery). Done once at scene build.
 */
export function mergeMeshes(parts: { mesh: Mesh; model: number[] }[]): Mesh {
  const b = new MeshBuilder();
  for (const { mesh, model } of parts) {
    const fmt = mesh.format;
    const stride = vertexStride(fmt, mesh.weightCount);
    const wB = fmt & FMT_WEIGHTS ? mesh.weightCount * 4 : 0;
    const uvB = fmt & FMT_UV ? 8 : 0;
    const colOff = wB + uvB;
    const colB = fmt & FMT_COLOR ? 4 : 0;
    const normB = fmt & FMT_NORMAL ? 12 : 0;
    const posOff = wB + uvB + colB + normB;
    const dv = new DataView(mesh.vertices);
    const n = mesh.vertices.byteLength / stride;
    const map: number[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      const abgr = colB ? dv.getUint32(o + colOff, true) : 0xffffffff;
      const col = ((abgr & 255) << 16) | (abgr & 0xff00) | ((abgr >> 16) & 255); // ABGR->RRGGBB
      const lx = dv.getFloat32(o + posOff, true);
      const ly = dv.getFloat32(o + posOff + 4, true);
      const lz = dv.getFloat32(o + posOff + 8, true);
      const wx = model[0] * lx + model[4] * ly + model[8] * lz + model[12];
      const wy = model[1] * lx + model[5] * ly + model[9] * lz + model[13];
      const wz = model[2] * lx + model[6] * ly + model[10] * lz + model[14];
      map.push(b.vertex(wx, wy, wz, col));
    }
    const idx = mesh.indices;
    for (let k = 0; k + 2 < idx.length; k += 3) b.tri(map[idx[k]], map[idx[k + 1]], map[idx[k + 2]]);
  }
  return b.build();
}

export class Mesh {
  vertices: ArrayBuffer;
  indices: Uint16Array;
  format: number;
  /** f32 bone weights per vertex when FMT_WEIGHTS is set (0 otherwise). */
  weightCount: number;
  private _handle = -1;

  constructor(vertices: ArrayBuffer, indices: Uint16Array, format: number, weightCount = 0) {
    this.vertices = vertices;
    this.indices = indices;
    this.format = format;
    this.weightCount = weightCount;
  }

  get vertexCount(): number {
    return this.vertices.byteLength / vertexStride(this.format, this.weightCount);
  }

  /** Upload to the host on first call; returns -1 when there is no 3D host. */
  handle(): number {
    if (this._handle < 0 && hasG3d()) {
      this._handle = globalThis.g3d!.uploadMesh(
        this.vertices,
        this.indices.buffer as ArrayBuffer,
        this.format,
        this.weightCount,
      );
    }
    return this._handle;
  }

  // ---- primitives ----

  /** 6 identical face colors for a uniform-color box/cube (Mesh.box/cube arg). */
  static solid(c: Color): Color[] {
    return [c, c, c, c, c, c];
  }

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
   * Axis-aligned box for first-person interiors. PSP/PPSSPP can drop a large
   * triangle that straddles the camera/near plane; subdividing each face keeps
   * the visible room surfaces in front of the eye as independent small triangles.
   */
  static interiorBox(w: number, h: number, d: number, faceColors: Color[], cell = 0.5): Mesh {
    const hx = w / 2;
    const hy = h / 2;
    const hz = d / 2;
    const b = new MeshBuilder();
    const size = cell > 0 ? cell : 0.5;
    const dist = (a: number[], c: number[]) => Math.sqrt(
      (a[0] - c[0]) * (a[0] - c[0])
      + (a[1] - c[1]) * (a[1] - c[1])
      + (a[2] - c[2]) * (a[2] - c[2]),
    );
    const emitFace = (a: number[], c0: number[], d0: number[], color: Color) => {
      const su = Math.max(1, Math.ceil(dist(a, c0) / size));
      const sv = Math.max(1, Math.ceil(dist(a, d0) / size));
      const ux = c0[0] - a[0], uy = c0[1] - a[1], uz = c0[2] - a[2];
      const vx = d0[0] - a[0], vy = d0[1] - a[1], vz = d0[2] - a[2];
      const grid: number[] = [];
      function emitVertex(u: number, v: number): number {
        return b.vertex(
          a[0] + ux * u + vx * v,
          a[1] + uy * u + vy * v,
          a[2] + uz * u + vz * v,
          color,
        );
      }
      for (let y = 0; y <= sv; y++) {
        for (let x = 0; x <= su; x++) {
          grid.push(emitVertex(x / su, y / sv));
        }
      }
      for (let y = 0; y < sv; y++) {
        for (let x = 0; x < su; x++) {
          b.quad(
            grid[y * (su + 1) + x],
            grid[y * (su + 1) + x + 1],
            grid[(y + 1) * (su + 1) + x + 1],
            grid[(y + 1) * (su + 1) + x],
          );
        }
      }
    };
    // Same face order and winding as Mesh.box: +X,-X,+Y,-Y,+Z,-Z.
    emitFace([hx, -hy, hz], [hx, -hy, -hz], [hx, hy, hz], faceColors[0]);
    emitFace([-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, -hz], faceColors[1]);
    emitFace([-hx, hy, hz], [hx, hy, hz], [-hx, hy, -hz], faceColors[2]);
    emitFace([-hx, -hy, -hz], [hx, -hy, -hz], [-hx, -hy, hz], faceColors[3]);
    emitFace([-hx, -hy, hz], [hx, -hy, hz], [-hx, hy, hz], faceColors[4]);
    emitFace([hx, -hy, -hz], [-hx, -hy, -hz], [hx, hy, -hz], faceColors[5]);
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

  /** Subdivided horizontal plane on Y=0, preserving Mesh.plane's winding. */
  static gridPlane(w: number, d: number, color: Color, cell = 0.5): Mesh {
    const hx = w / 2;
    const hz = d / 2;
    const size = cell > 0 ? cell : 0.5;
    const su = Math.max(1, Math.ceil(w / size));
    const sv = Math.max(1, Math.ceil(d / size));
    const b = new MeshBuilder();
    const grid: number[] = [];
    for (let z = 0; z <= sv; z++) {
      const pz = hz - d * (z / sv);
      for (let x = 0; x <= su; x++) {
        const px = -hx + w * (x / su);
        grid.push(b.vertex(px, 0, pz, color));
      }
    }
    for (let z = 0; z < sv; z++) {
      for (let x = 0; x < su; x++) {
        b.quad(
          grid[z * (su + 1) + x],
          grid[z * (su + 1) + x + 1],
          grid[(z + 1) * (su + 1) + x + 1],
          grid[(z + 1) * (su + 1) + x],
        );
      }
    }
    return b.build();
  }
}

// Mesh geometry for the 3D layer. Geometry is generated procedurally (cube, box,
// plane) — no asset files are needed for the cube/racing/FPS examples. A Mesh
// holds interleaved vertex bytes (v1 layout: [color u32 ABGR][pos 3 f32], stride
// 16) + a Uint16 index buffer, and lazily uploads itself to the host on first use,
// caching the returned handle.
import { FMT_COLOR, FMT_POS, colorToABGR, vertexStride } from './g3d';
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

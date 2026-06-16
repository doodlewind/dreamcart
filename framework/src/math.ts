// Deterministic 3D math for the isomorphic 3D layer. Column-major matrices,
// right-handed world, reversed-Z projection. Everything is f64 (JS numbers);
// only +,-,*,/ and Math.round/abs/sqrt are used so results are BIT-IDENTICAL
// across QuickJS (PSP/3DS) and the browser engine (Web). In particular we avoid
// the engine trig builtins (sine/cosine/tangent/arctangent) — those differ in the
// last ULP between engines, which would break the cross-host byte goldens (see
// framework/test/contract.ts, which greps these files for forbidden builtins).

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const DEG2RAD = 0.017453292519943295;

/** Deterministic sine. Range-reduced to [-PI/2, PI/2], degree-9 Taylor. */
export function dsin(x: number): number {
  x -= TWO_PI * Math.round(x / TWO_PI); // -> [-PI, PI]
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x; // -> [-PI/2, PI/2]
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880)))))
  );
}

/** Deterministic cosine. */
export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

/** Deterministic sqrt — IEEE-754 sqrt is correctly-rounded, so it is exact. */
export function dsqrt(x: number): number {
  return Math.sqrt(x);
}

function datanUnit(z: number): number {
  // minimax-ish atan for |z| <= 1, polynomial in z (deterministic).
  const z2 = z * z;
  return (
    z *
    (0.999866 +
      z2 * (-0.3302995 + z2 * (0.1801410 + z2 * (-0.0851330 + z2 * 0.0208351))))
  );
}

/** Deterministic atan2 in (-PI, PI]. */
export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let a = ax >= ay ? datanUnit(ay / ax) : HALF_PI - datanUnit(ax / ay);
  if (x < 0) a = PI - a;
  if (y < 0) a = -a;
  return a;
}

/** A 3-component vector (f64). Immutable-style: ops return new vectors. */
export class Vec3 {
  x: number;
  y: number;
  z: number;
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  add(b: Vec3): Vec3 {
    return new Vec3(this.x + b.x, this.y + b.y, this.z + b.z);
  }
  sub(b: Vec3): Vec3 {
    return new Vec3(this.x - b.x, this.y - b.y, this.z - b.z);
  }
  scale(s: number): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s);
  }
  dot(b: Vec3): number {
    return this.x * b.x + this.y * b.y + this.z * b.z;
  }
  cross(b: Vec3): Vec3 {
    return new Vec3(
      this.y * b.z - this.z * b.y,
      this.z * b.x - this.x * b.z,
      this.x * b.y - this.y * b.x,
    );
  }
  length(): number {
    return dsqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }
  normalize(): Vec3 {
    const l = this.length();
    return l > 0 ? new Vec3(this.x / l, this.y / l, this.z / l) : new Vec3(0, 0, 0);
  }
}

/** A unit quaternion (f64), built with deterministic trig. */
export class Quat {
  x: number;
  y: number;
  z: number;
  w: number;
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
  static identity(): Quat {
    return new Quat(0, 0, 0, 1);
  }
  /** Intrinsic XYZ euler (radians) -> quaternion. */
  static fromEuler(x: number, y: number, z: number): Quat {
    const hx = x * 0.5;
    const hy = y * 0.5;
    const hz = z * 0.5;
    const cx = dcos(hx);
    const sx = dsin(hx);
    const cy = dcos(hy);
    const sy = dsin(hy);
    const cz = dcos(hz);
    const sz = dsin(hz);
    return new Quat(
      sx * cy * cz + cx * sy * sz,
      cx * sy * cz - sx * cy * sz,
      cx * cy * sz + sx * sy * cz,
      cx * cy * cz - sx * sy * sz,
    );
  }
  static fromAxisAngle(axis: Vec3, angle: number): Quat {
    const a = axis.normalize();
    const h = angle * 0.5;
    const s = dsin(h);
    return new Quat(a.x * s, a.y * s, a.z * s, dcos(h));
  }
  multiply(b: Quat): Quat {
    return new Quat(
      this.w * b.x + this.x * b.w + this.y * b.z - this.z * b.y,
      this.w * b.y - this.x * b.z + this.y * b.w + this.z * b.x,
      this.w * b.z + this.x * b.y - this.y * b.x + this.z * b.w,
      this.w * b.w - this.x * b.x - this.y * b.y - this.z * b.z,
    );
  }
}

/** Column-major 4x4 matrices stored as length-16 number[] (m[col*4 + row]). */
export const Mat4 = {
  identity(): number[] {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  },

  /** r = a * b (both column-major). */
  multiply(a: number[], b: number[]): number[] {
    const r = new Array<number>(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        r[col * 4 + row] =
          a[row] * b[col * 4] +
          a[4 + row] * b[col * 4 + 1] +
          a[8 + row] * b[col * 4 + 2] +
          a[12 + row] * b[col * 4 + 3];
      }
    }
    return r;
  },

  fromQuat(q: Quat): number[] {
    const { x, y, z, w } = q;
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    return [
      1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
      2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
      2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
      0, 0, 0, 1,
    ];
  },

  /** Model matrix from translation, rotation (quat) and per-axis scale. */
  compose(pos: Vec3, q: Quat, scale: Vec3): number[] {
    const m = Mat4.fromQuat(q);
    m[0] *= scale.x; m[1] *= scale.x; m[2] *= scale.x;
    m[4] *= scale.y; m[5] *= scale.y; m[6] *= scale.y;
    m[8] *= scale.z; m[9] *= scale.z; m[10] *= scale.z;
    m[12] = pos.x; m[13] = pos.y; m[14] = pos.z;
    return m;
  },

  /**
   * Standard right-handed perspective with REVERSED-Z (near -> 1, far -> 0).
   * NDC is Y-up (the GL/PSP-GE/PICA convention); the Y-flip to a Y-down screen
   * is each renderer's viewport job — only the software rasterizer
   * (framework/test/raster3d.ts, which writes a Y-down framebuffer directly)
   * applies it. Baking it into the matrix here double-flipped on the PSP GE,
   * which flips in its viewport already (see docs/3d-design.md §10.1 C4).
   * @param zeroToOne true: clip z in [0,1] (PSP/3DS, WebGL+EXT_clip_control).
   *                  false: clip z in [-1,1] reversed (WebGL fallback).
   */
  perspectiveReversedZ(
    fovDeg: number,
    aspect: number,
    near: number,
    far: number,
    zeroToOne = true,
  ): number[] {
    const t = tanHalf(fovDeg * DEG2RAD);
    const sy = 1 / t;
    const sx = sy / aspect;
    const m = new Array<number>(16).fill(0);
    m[0] = sx;
    m[5] = sy;
    m[11] = -1;
    if (zeroToOne) {
      m[10] = near / (far - near);
      m[14] = (near * far) / (far - near);
    } else {
      m[10] = (near + far) / (far - near);
      m[14] = (2 * near * far) / (far - near);
    }
    return m;
  },

  /** Right-handed look-at view matrix. */
  lookAt(eye: Vec3, center: Vec3, up: Vec3): number[] {
    const fwd = center.sub(eye).normalize();
    const s = fwd.cross(up).normalize();
    const u = s.cross(fwd);
    return [
      s.x, u.x, -fwd.x, 0,
      s.y, u.y, -fwd.y, 0,
      s.z, u.z, -fwd.z, 0,
      -s.dot(eye), -u.dot(eye), fwd.dot(eye), 1,
    ];
  },

  /** Pack to a fresh Float32Array (the wire type). */
  toF32(m: number[]): Float32Array {
    const out = new Float32Array(16);
    for (let i = 0; i < 16; i++) out[i] = m[i];
    return out;
  },
};

/** Deterministic tangent of a half-angle via dsin/dcos. */
function tanHalf(rad: number): number {
  const h = rad * 0.5;
  return dsin(h) / dcos(h);
}

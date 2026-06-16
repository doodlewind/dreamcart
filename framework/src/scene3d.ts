// A minimal 3D scene graph mirroring the 2D Scene/Node tree. The game builds a
// Scene3D of Node3Ds (each with a mesh + transform) and a Camera; once per frame
// the engine walks it and emits one SET_CAMERA + one DRAW per visible mesh into
// the CommandEncoder (see engine.ts). All transform math is shared deterministic
// f64 (math.ts), so the emitted bytes are identical on every host.
import { CommandEncoder, NO_TINT, colorToABGR } from './g3d';
import { Mat4, Quat, Vec3 } from './math';
import { SCREEN_H, SCREEN_W } from './host';
import type { Color } from './color';
import type { Mesh } from './mesh';

export class Camera {
  proj: number[] = Mat4.identity();
  view: number[] = Mat4.identity();
  viewProj: number[] = Mat4.identity();
  /** Set to false on the WebGL fallback path (clip z in [-1,1]). */
  zeroToOne = true;

  setPerspective(fovDeg: number, aspect: number, near: number, far: number): void {
    this.proj = Mat4.perspectiveReversedZ(fovDeg, aspect, near, far, this.zeroToOne);
    this.recompute();
  }
  lookAt(eye: Vec3, center: Vec3, up: Vec3): void {
    this.view = Mat4.lookAt(eye, center, up);
    this.recompute();
  }
  recompute(): void {
    this.viewProj = Mat4.multiply(this.proj, this.view);
  }
}

export interface Node3DOpts {
  mesh?: Mesh;
  position?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
  tint?: Color;
}

export class Node3D {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  mesh?: Mesh;
  tint: number; // ABGR, NO_TINT = untinted
  visible = true;
  children: Node3D[] = [];

  constructor(opts: Node3DOpts = {}) {
    this.position = opts.position ?? new Vec3(0, 0, 0);
    this.rotation = opts.rotation ?? Quat.identity();
    this.scale = opts.scale ?? new Vec3(1, 1, 1);
    this.mesh = opts.mesh;
    this.tint = opts.tint === undefined ? NO_TINT : colorToABGR(opts.tint);
  }

  add(child: Node3D): Node3D {
    this.children.push(child);
    return child;
  }

  /** Set the tint from an 0xRRGGBB color (or undefined to clear). */
  setTint(c: Color | undefined): void {
    this.tint = c === undefined ? NO_TINT : colorToABGR(c);
  }

  localMatrix(): number[] {
    return Mat4.compose(this.position, this.rotation, this.scale);
  }
}

export class Scene3D {
  root = new Node3D();
  camera = new Camera();

  constructor() {
    this.camera.setPerspective(60, SCREEN_W / SCREEN_H, 0.1, 100);
  }

  /** Add a node (or build one from opts) to the root. */
  add(nodeOrOpts: Node3D | Node3DOpts = {}): Node3D {
    const node =
      nodeOrOpts instanceof Node3D ? nodeOrOpts : new Node3D(nodeOrOpts);
    return this.root.add(node);
  }

  /** Emit SET_CAMERA then a DRAW per visible mesh (parent*local in shared JS). */
  render(enc: CommandEncoder): void {
    enc.setCamera(this.camera.viewProj);
    this.emit(this.root, Mat4.identity(), enc);
  }

  private emit(node: Node3D, parent: number[], enc: CommandEncoder): void {
    if (!node.visible) return;
    const world = Mat4.multiply(parent, node.localMatrix());
    if (node.mesh) {
      const h = node.mesh.handle();
      if (h >= 0) enc.draw(h, world, node.tint);
    }
    for (const c of node.children) this.emit(c, world, enc);
  }
}

// A minimal 3D scene graph mirroring the 2D Scene/Node tree. The game builds a
// Scene3D of Node3Ds (each with a mesh + transform) and a Camera; once per frame
// the engine walks it and emits one SET_CAMERA + one DRAW per visible mesh into
// the CommandEncoder (see engine.ts). All transform math is shared deterministic
// f64 (math.ts), so the emitted bytes are identical on every host.
import { CommandEncoder, NO_TINT, UNBIND_TEXTURE, colorToABGR } from './g3d';
import { Mat4, Quat, Vec3 } from './math';
import { SCREEN_H, SCREEN_W } from './host';
import type { Color } from './color';
import type { Mesh } from './mesh';
import type { Material } from './material';
import type { Lighting } from './light';
import type { SkinnedMesh } from './skin';

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
  material?: Material;
  skinned?: SkinnedMesh;
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
  /** Optional textured material; Scene3D binds its texture before drawing. */
  material?: Material;
  /** Optional hardware-skinned character; Scene3D emits its bone-batch draws. */
  skinned?: SkinnedMesh;
  tint: number; // ABGR, NO_TINT = untinted
  visible = true;
  children: Node3D[] = [];

  constructor(opts: Node3DOpts = {}) {
    this.position = opts.position ?? new Vec3(0, 0, 0);
    this.rotation = opts.rotation ?? Quat.identity();
    this.scale = opts.scale ?? new Vec3(1, 1, 1);
    this.mesh = opts.mesh;
    this.material = opts.material;
    this.skinned = opts.skinned;
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
  /** Optional hardware lighting; when set, one OP_SET_LIGHTS is emitted/frame. */
  lighting?: Lighting;
  // Texture currently bound on the GE during a render pass; tracked so we emit
  // OP_BIND_TEXTURE only when the active texture actually changes (and once to
  // unbind when a textured draw is followed by an untextured one). Initialized to
  // -1 ("nothing bound") — the host starts every frame with texturing disabled —
  // so a scene that never uses a texture emits ZERO bind records (v1 goldens stay
  // byte-identical).
  private boundTex = -1;

  constructor() {
    this.camera.setPerspective(60, SCREEN_W / SCREEN_H, 0.1, 100);
  }

  /** Add a node (or build one from opts) to the root. */
  add(nodeOrOpts: Node3D | Node3DOpts = {}): Node3D {
    const node =
      nodeOrOpts instanceof Node3D ? nodeOrOpts : new Node3D(nodeOrOpts);
    return this.root.add(node);
  }

  /** Emit SET_CAMERA, the lights (if any), then a DRAW per visible mesh. */
  render(enc: CommandEncoder): void {
    enc.setCamera(this.camera.viewProj);
    if (this.lighting && this.lighting.lights.length > 0) {
      enc.setLights(this.lighting.ambientABGR(), this.lighting.encoded());
    }
    this.boundTex = -1;
    this.emit(this.root, Mat4.identity(), enc);
  }

  // Emit the bind/unbind record for a desired texture handle (-1 = none), only
  // when it differs from the GE's currently-bound texture (sticky host state).
  private bindIfChanged(want: number, enc: CommandEncoder): void {
    if (want >= 0) {
      if (this.boundTex !== want) {
        enc.bindTexture(want);
        this.boundTex = want;
      }
    } else if (this.boundTex !== -1) {
      enc.bindTexture(UNBIND_TEXTURE);
      this.boundTex = -1;
    }
  }

  private emit(node: Node3D, parent: number[], enc: CommandEncoder): void {
    if (!node.visible) return;
    const world = Mat4.multiply(parent, node.localMatrix());
    if (node.skinned) {
      // Skinned characters carry their own texture + bone-batch draws.
      const tex = node.skinned.texture;
      this.bindIfChanged(tex ? tex.handle() : -1, enc);
      node.skinned.emit(enc, world, node.tint);
    } else if (node.mesh) {
      const h = node.mesh.handle();
      if (h >= 0) {
        const tex = node.material?.texture;
        this.bindIfChanged(tex ? tex.handle() : -1, enc);
        enc.draw(h, world, node.tint);
      }
    }
    for (const c of node.children) this.emit(c, world, enc);
  }
}

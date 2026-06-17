// @ts-check
// @title Lit 3D
// @order 11
// @controls D-pad tilt; START reset
// lit3d.js — the M1 milestone scene: a STATIC mesh exercising the v2 texture +
// hardware-lighting paths end-to-end. A checker-textured cube spins under one
// directional "sun" + ambient; the PSP GE samples the texture (sceGuTexImage) and
// does per-vertex T&L (sceGuLight) in hardware, while all motion/camera logic
// stays in shared deterministic JS. Proves OP_BIND_TEXTURE, OP_SET_LIGHTS,
// FMT_UV and FMT_NORMAL before the glTF bake (M2) wires real assets.
import {
  start, Scene, Scene3D, Mesh, Material, Texture, Lighting, DirectionalLight,
  Vec3, Quat, Colors, Btn,
} from '../src/index';

/** @import { UpdateContext, Graphics, Node3D } from '../src/index' */

class LitScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {Node3D} */ cube = /** @type {any} */ (null);
  rx = 0;
  ry = 0;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();

    // A 64×64 procedural checker (M2 replaces this with a baked palette). The
    // texture modulates the cube's white base color and is lit by the sun.
    const tex = Texture.checker(64, 64, 0xffffff, 0x3060c0, 8);
    const material = new Material({ texture: tex });
    const mesh = Mesh.texturedCube(1.6, 0xffffff);
    this.cube = this.world.add({ mesh, material });

    // One directional sun (down-forward) + soft ambient so back faces aren't black.
    const lighting = new Lighting(0x404048);
    lighting.add(new DirectionalLight(new Vec3(-0.4, -1, -0.6), 0xfff0d0));
    this.world.lighting = lighting;

    this.world.camera.lookAt(new Vec3(0, 1.4, 3.8), new Vec3(0, 0, 0), new Vec3(0, 1, 0));
    ctx.engine.scene3d = this.world;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    if (ctx.input.pressed(Btn.Start)) {
      this.rx = 0;
      this.ry = 0;
    }
    const d = ctx.input.dir();
    this.ry += (0.7 + d.x) * ctx.dt;
    this.rx += (0.4 - d.y * 0.9) * ctx.dt;
    this.cube.rotation = Quat.fromEuler(this.rx, this.ry, 0);
  }

  /** @param {Graphics} g */
  draw(g) {
    g.text('LIT 3D', 8, 8, Colors.white, 2);
    g.text('TEXTURE + HW LIGHT', 8, 256, Colors.cyan, 1);
  }
}

start(() => new LitScene());

// @ts-check
// @title Cube 3D
// @order 10
// @controls D-pad tilt; START reset
// cube3d.js — the hello-world of the DreamCart 3D contract. A single colored cube
// spins via shared deterministic math; the engine emits one SET_CAMERA + one DRAW
// per frame. The 2D text is a HUD drawn on top of the 3D pass.
import {
  start, Scene, Scene3D, Mesh, Vec3, Quat, Colors, rgb, Btn,
} from '../src/index';

/** @import { UpdateContext, Graphics, Node3D } from '../src/index' */

class CubeScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {Node3D} */ cube = /** @type {any} */ (null);
  rx = 0;
  ry = 0;
  /** @type {UpdateContext} */ ctxRef = /** @type {any} */ (null);

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.ctxRef = ctx;
    this.world = new Scene3D();

    // 6 face colors: +X,-X,+Y,-Y,+Z,-Z. Uploaded once on first draw.
    const mesh = Mesh.cube(1.4, [
      rgb(220, 70, 70), rgb(70, 180, 90),
      rgb(70, 110, 220), rgb(220, 200, 80),
      rgb(200, 90, 200), rgb(80, 200, 210),
    ]);
    this.cube = this.world.add({ mesh });

    this.world.camera.lookAt(new Vec3(0, 1.2, 3.6), new Vec3(0, 0, 0), new Vec3(0, 1, 0));

    // Hand the 3D scene to the engine — it auto-submits before the HUD.
    ctx.engine.scene3d = this.world;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    if (ctx.input.pressed(Btn.Start)) {
      this.rx = 0;
      this.ry = 0;
    }
    // Steer the spin with the d-pad; otherwise drift.
    const d = ctx.input.dir();
    this.ry += (0.8 + d.x) * ctx.dt;
    this.rx += (0.5 - d.y * 0.9) * ctx.dt;
    this.cube.rotation = Quat.fromEuler(this.rx, this.ry, 0);
  }

  /** @param {Graphics} g */
  draw(g) {
    // HUD overlay — plain 2D, drawn AFTER the 3D pass.
    g.text('CUBE 3D', 8, 8, Colors.white, 2);
    g.text('D-PAD TILT  START RESET', 8, 256, Colors.cyan, 1);
  }
}

start(() => new CubeScene());

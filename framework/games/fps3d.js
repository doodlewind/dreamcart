// @ts-check
// @title Room FPS 3D
// @order 12
// @controls UP/DOWN move; LEFT/RIGHT turn; CROSS shoot; START reset
// fps3d.js — a single-room first-person shooter. The first-person camera, AABB
// wall collision, and hitscan ray/AABB tests are ALL pure deterministic JS (the
// "logic is one shared copy" proof); the room is one static mesh animated only by
// the camera matrix. The crosshair + ammo/score are a 2D HUD over the 3D pass.
import {
  start, Scene, Scene3D, Mesh, Vec3, Quat, Colors, rgb, Btn, dsin, dcos,
} from '../src/index';

/** @import { UpdateContext, Graphics, Node3D } from '../src/index' */

/** @param {number} c @returns {number[]} */
const solid = (c) => [c, c, c, c, c, c];
/** @param {number} v @param {number} a @param {number} b @returns {number} */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const HALF = 9; // movable half-extent inside the 10-half room (0.5 player radius + margin)

// Ray vs axis-aligned box centered at c with half-extents h. Returns hit t>0 or -1.
/**
 * @param {number} ox @param {number} oy @param {number} oz
 * @param {number} dx @param {number} dy @param {number} dz
 * @param {number} cx @param {number} cy @param {number} cz
 * @param {number} hx @param {number} hy @param {number} hz
 * @returns {number}
 */
function rayAabb(ox, oy, oz, dx, dy, dz, cx, cy, cz, hx, hy, hz) {
  let tmin = -Infinity;
  let tmax = Infinity;
  /** @param {number} o @param {number} d @param {number} c @param {number} h @returns {boolean} */
  const slab = (o, d, c, h) => {
    if (Math.abs(d) < 1e-9) return o >= c - h && o <= c + h;
    let t1 = (c - h - o) / d;
    let t2 = (c + h - o) / d;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    return true;
  };
  if (!slab(ox, dx, cx, hx)) return -1;
  if (!slab(oy, dy, cy, hy)) return -1;
  if (!slab(oz, dz, cz, hz)) return -1;
  if (tmax < tmin || tmax < 0) return -1;
  return tmin > 0 ? tmin : tmax;
}

const TARGET_POS = [
  new Vec3(-6, 1, -6), new Vec3(6, 1, -6),
  new Vec3(-6, 1, 6), new Vec3(6, 1, 6), new Vec3(0, 1.5, -8),
];

class FpsScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {{ node: Node3D, c: Vec3, alive: boolean }[]} */ targets = [];
  px = 0;
  pz = 0;
  yaw = 0;
  ammo = 0;
  score = 0;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(70, 480 / 272, 0.1, 100);

    // The room: a box viewed from inside (no culling, so the inner faces show).
    // faces: +X,-X,+Y(ceiling),-Y(floor),+Z,-Z.
    const room = Mesh.box(20, 6, 20, [
      rgb(70, 90, 130), rgb(70, 90, 130),
      rgb(120, 130, 150), rgb(40, 44, 54),
      rgb(80, 100, 140), rgb(80, 100, 140),
    ]);
    this.world.add({ mesh: room, position: new Vec3(0, 3, 0) });

    // Shootable targets (a shared cube mesh).
    const tgt = Mesh.box(1, 1, 1, solid(rgb(230, 210, 70)));
    this.targets = TARGET_POS.map((c) => ({
      node: this.world.add({ mesh: tgt, position: c }),
      c,
      alive: true,
    }));

    this.reset();
    ctx.engine.scene3d = this.world;
  }

  reset() {
    this.px = 0;
    this.pz = 0;
    this.yaw = 0;
    this.ammo = 12;
    this.score = 0;
    for (const t of this.targets) {
      t.alive = true;
      t.node.visible = true;
    }
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) this.reset();

    // Left/Right turn, Up/Down walk along the facing direction.
    const d = inp.dir();
    this.yaw += d.x * 1.6 * ctx.dt;
    const fwdX = dsin(this.yaw);
    const fwdZ = -dcos(this.yaw);
    const move = -d.y; // Up = forward
    this.px = clamp(this.px + fwdX * move * 4 * ctx.dt, -HALF, HALF);
    this.pz = clamp(this.pz + fwdZ * move * 4 * ctx.dt, -HALF, HALF);

    const eye = new Vec3(this.px, 1.6, this.pz);
    this.world.camera.lookAt(eye, eye.add(new Vec3(fwdX, 0, fwdZ)), new Vec3(0, 1, 0));

    // Hitscan: ray from the eye along the facing direction; kill nearest target.
    if (inp.pressed(Btn.Cross) && this.ammo > 0) {
      this.ammo--;
      let bestT = Infinity;
      let best = null;
      for (const t of this.targets) {
        if (!t.alive) continue;
        const hit = rayAabb(eye.x, eye.y, eye.z, fwdX, 0, fwdZ, t.c.x, t.c.y, t.c.z, 0.6, 0.6, 0.6);
        if (hit > 0 && hit < bestT) { bestT = hit; best = t; }
      }
      if (best) {
        best.alive = false;
        best.node.visible = false;
        this.score++;
      }
    }
  }

  /** @param {Graphics} g */
  draw(g) {
    // Crosshair at screen center.
    const cx = 240;
    const cy = 136;
    g.rect(cx - 6, cy - 1, 12, 2, Colors.white);
    g.rect(cx - 1, cy - 6, 2, 12, Colors.white);

    g.text('ROOM FPS', 8, 8, Colors.white, 2);
    g.text('AMMO ' + this.ammo, 8, 246, Colors.cyan, 2);
    g.text('HITS ' + this.score, 360, 246, Colors.yellow, 2);
  }
}

start(() => new FpsScene());

// @ts-check
// @title Tactical 3D
// @order 16
// @controls UP/CROSS walk; SQUARE run; LEFT/RIGHT turn; DOWN back; START reset
// adventure3d.js — a compact tactical walking demo: static arena map, cover,
// simple collision, and a skinned soldier character on the native PSP skin path.
import {
  start, Scene, Scene3D, Node3D, Mesh, MeshBuilder, SkinnedMesh,
  Vec3, Quat, Colors, rgb, Btn, dsin, dcos, PI, HALF_PI,
} from '../src/index';
import { THREE_SOLDIER } from '../src/assets-three-soldier';

/** @import { UpdateContext, Graphics } from '../src/index' */

/** @param {number} v @param {number} a @param {number} b @returns {number} */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const GROUND_STEP = 8; // metres per ground tile (small => guard-band safe)
const GROUND_TILES = 20; // 20×8 = 160 m grid (edge past the 62 m fog) so no void ever shows

/**
 * A flat tile-grid centred at origin (one mesh, many small quads). The chase camera
 * can roam OUTSIDE the fixed arena floor; a single big floor plane would then leave a
 * black void in the foreground (no floor under the camera) AND its huge triangles trip
 * the PSP guard band. This grid follows the camera, so the floor is always under it.
 * @param {number} n @param {number} step @param {number} color
 */
function gridGround(n, step, color) {
  const b = new MeshBuilder();
  const half = (n * step) / 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * step;
      const z0 = -half + j * step;
      const x1 = x0 + step;
      const z1 = z0 + step;
      const i0 = b.vertex(x0, 0, z1, color);
      const i1 = b.vertex(x1, 0, z1, color);
      const i2 = b.vertex(x1, 0, z0, color);
      const i3 = b.vertex(x0, 0, z0, color);
      b.quad(i0, i1, i2, i3);
    }
  }
  return b.build();
}

const WALL = [rgb(104, 109, 111), rgb(82, 87, 90), rgb(138, 142, 140), rgb(55, 58, 60), rgb(92, 96, 98), rgb(72, 76, 78)];
const FLOOR = [rgb(74, 74, 70), rgb(64, 64, 61), rgb(94, 91, 82), rgb(48, 48, 46), rgb(78, 76, 70), rgb(58, 58, 55)];
const CRATE = [rgb(132, 98, 55), rgb(98, 70, 42), rgb(155, 121, 72), rgb(82, 57, 36), rgb(120, 86, 48), rgb(94, 65, 39)];
const METAL = [rgb(86, 100, 112), rgb(63, 75, 86), rgb(118, 130, 138), rgb(43, 49, 54), rgb(76, 88, 98), rgb(56, 65, 72)];
const TARGET = [rgb(168, 62, 45), rgb(114, 45, 38), rgb(205, 96, 60), rgb(70, 32, 29), rgb(148, 55, 44), rgb(96, 38, 34)];

class TacticalScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {SkinnedMesh} */ soldier = /** @type {any} */ (null);
  /** @type {Node3D} */ actor = /** @type {any} */ (null);
  /** @type {Node3D} */ ground = /** @type {any} */ (null);
  /** @type {{ minX: number, maxX: number, minZ: number, maxZ: number }[]} */
  blockers = [];
  x = -11.5;
  z = 12.0;
  heading = -0.22;
  fps = 0;
  _lastNow = 0;
  _accUs = 0;
  _frames = 0;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(62, 480 / 272, 0.08, 92);

    this.world.fog = { color: rgb(27, 31, 34), near: 34, far: 62 };

    // Camera-following ground (small tiles, one mesh) so the chase camera never
    // reveals a floorless black void when the soldier nears an arena edge.
    this.ground = this.world.add(new Node3D({
      mesh: gridGround(GROUND_TILES, GROUND_STEP, FLOOR[2]),
      position: new Vec3(0, -0.04, 0),
    }));

    this.buildArena();

    this.soldier = SkinnedMesh.fromBaked(THREE_SOLDIER);
    this.soldier.play(THREE_SOLDIER.clips.Walk);
    this.actor = this.world.add({
      position: new Vec3(this.x, 0, this.z),
      rotation: Quat.fromEuler(0, this.heading, 0),
    });
    this.actor.add(new Node3D({
      skinned: this.soldier,
      rotation: Quat.fromEuler(-HALF_PI, 0, 0),
      scale: new Vec3(THREE_SOLDIER.scale, THREE_SOLDIER.scale, THREE_SOLDIER.scale),
    }));

    this.reset();
    ctx.engine.scene3d = this.world;
  }

  buildArena() {
    // (floor is the camera-following gridGround set up in onEnter)
    this.addBox(0, 1.55, -18.6, 38.8, 3.1, 0.85, WALL);
    this.addBox(0, 1.55, 18.6, 38.8, 3.1, 0.85, WALL);
    this.addBox(-18.6, 1.55, 0, 0.85, 3.1, 38.8, WALL);
    this.addBox(18.6, 1.55, 0, 0.85, 3.1, 38.8, WALL);

    this.addBox(-10.8, 1.25, -5.8, 14.8, 2.5, 0.7, WALL);
    this.addBox(9.8, 1.25, -5.8, 12.8, 2.5, 0.7, WALL);
    this.addBox(-6.2, 1.25, 7.0, 0.7, 2.5, 16.0, WALL);
    this.addBox(7.2, 1.25, 5.8, 0.7, 2.5, 13.6, WALL);
    this.addBox(0.5, 1.25, 7.8, 6.7, 2.5, 0.7, WALL);
    this.addBox(-12.5, 1.25, 3.2, 5.0, 2.5, 0.7, WALL);
    this.addBox(13.4, 1.25, -0.8, 0.7, 2.5, 8.6, WALL);

    this.addCrates(-2.4, 0.55, 1.1, 0.15, 3);
    this.addCrates(11.8, 0.55, 10.4, -0.45, 3);
    this.addCrates(-13.6, 0.55, -12.0, 0.65, 2);
    this.addBox(2.7, 0.75, -12.4, 3.4, 1.5, 1.2, METAL);
    this.addBox(5.8, 0.55, -12.1, 1.2, 1.1, 1.2, TARGET);
    this.addBox(14.2, 0.75, 4.8, 1.5, 1.5, 3.5, METAL);
    this.addBox(-9.8, 0.35, 13.4, 4.2, 0.7, 1.2, TARGET);
  }

  /**
   * @param {number} x @param {number} y @param {number} z
   * @param {number} w @param {number} h @param {number} d
   * @param {number[]} colors
   * @param {boolean} solid
   */
  addBox(x, y, z, w, h, d, colors, solid = true) {
    const node = new Node3D({
      mesh: Mesh.box(w, h, d, colors),
      position: new Vec3(x, y, z),
      isStatic: true,
    });
    node.bounds = { min: [-w / 2, -h / 2, -d / 2], max: [w / 2, h / 2, d / 2] };
    this.world.add(node);
    if (solid) {
      this.blockers.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
    }
  }

  /** @param {number} x @param {number} y @param {number} z @param {number} yaw @param {number} count */
  addCrates(x, y, z, yaw, count) {
    for (let i = 0; i < count; i++) {
      const sx = x + (i % 2) * 1.15;
      const sz = z + ((i / 2) | 0) * 1.05;
      const node = new Node3D({
        mesh: Mesh.box(1.05, 1.1, 1.05, CRATE),
        position: new Vec3(sx, y + (i === 2 ? 0.55 : 0), sz),
        rotation: Quat.fromEuler(0, yaw + i * 0.2, 0),
        isStatic: true,
      });
      node.bounds = { min: [-0.75, -0.65, -0.75], max: [0.75, 0.65, 0.75] };
      this.world.add(node);
      this.blockers.push({ minX: sx - 0.7, maxX: sx + 0.7, minZ: sz - 0.7, maxZ: sz + 0.7 });
    }
  }

  reset() {
    this.x = -11.5;
    this.z = 12.0;
    this.heading = -0.22;
    this.soldier.play(THREE_SOLDIER.clips.Walk);
  }

  /** @param {number} nx @param {number} nz @returns {boolean} */
  blocked(nx, nz) {
    const r = 0.38;
    for (const b of this.blockers) {
      if (nx + r > b.minX && nx - r < b.maxX && nz + r > b.minZ && nz - r < b.maxZ) return true;
    }
    return false;
  }

  /** @param {number} nx @param {number} nz */
  moveTo(nx, nz) {
    nx = clamp(nx, -17.4, 17.4);
    nz = clamp(nz, -17.4, 17.4);
    if (!this.blocked(nx, this.z)) this.x = nx;
    if (!this.blocked(this.x, nz)) this.z = nz;
  }

  measureFps() {
    const host = /** @type {any} */ (globalThis);
    if (typeof host.now !== 'function') return;
    const t = host.now();
    if (this._lastNow) {
      this._accUs += t - this._lastNow;
      this._frames++;
      if (this._accUs >= 1e6) {
        this.fps = Math.round((this._frames * 1e6) / this._accUs);
        this._accUs = 0;
        this._frames = 0;
      }
    }
    this._lastNow = t;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.measureFps();
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) this.reset();
    if (inp.held(Btn.Left)) this.heading += 2.15 * ctx.dt;
    if (inp.held(Btn.Right)) this.heading -= 2.15 * ctx.dt;

    const forward = inp.held(Btn.Up) || inp.held(Btn.Cross);
    const back = inp.held(Btn.Down);
    const run = inp.held(Btn.Square);
    const speed = forward ? (run ? 6.4 : 3.0) : back ? -2.2 : 0;
    const fwdX = dsin(this.heading);
    const fwdZ = dcos(this.heading);
    const clip = speed === 0 ? THREE_SOLDIER.clips.Idle : run ? THREE_SOLDIER.clips.Run : THREE_SOLDIER.clips.Walk;
    if (this.soldier.player.clip !== clip) this.soldier.play(clip);
    if (speed !== 0) {
      this.soldier.player.advance(ctx.dt * (run ? 1.4 : 1.0));
      this.moveTo(this.x + fwdX * speed * ctx.dt, this.z + fwdZ * speed * ctx.dt);
    } else {
      this.soldier.player.advance(ctx.dt);
    }

    this.actor.position = new Vec3(this.x, 0, this.z);
    this.actor.rotation = Quat.fromEuler(0, this.heading, 0);

    const focus = new Vec3(this.x, 1.35, this.z);
    const eye = new Vec3(
      this.x - fwdX * 7.2,
      3.4,
      this.z - fwdZ * 7.2,
    );
    this.world.camera.lookAt(eye, new Vec3(focus.x + fwdX * 2.4, focus.y, focus.z + fwdZ * 2.4), new Vec3(0, 1, 0));

    // Keep the ground grid under the camera (snapped to its tile size so it doesn't
    // visibly swim), so there's always floor beneath the view.
    this.ground.position = new Vec3(
      Math.round(eye.x / GROUND_STEP) * GROUND_STEP, -0.04,
      Math.round(eye.z / GROUND_STEP) * GROUND_STEP,
    );
  }

  /** @param {Graphics} g */
  draw(g) {
    const total = this.world.root.children.length;
    const drawn = total - this.world.culledCount;
    g.text('TACTICAL 3D', 8, 8, Colors.white, 1);
    g.text('arena ' + drawn + '/' + total, 8, 246, Colors.cyan, 1);
    if (this.fps > 0) g.text(this.fps + ' FPS', 410, 8, Colors.yellow, 1);
    g.text('Soldier.glb MIT', 8, 258, Colors.gray, 1);
  }
}

start(() => new TacticalScene());

// @ts-check
// @title BSP Map 3D
// @order 18
// @controls D-PAD move (soldier turns to face); SQUARE run; O/^ orbit cam; START reset
// bsp3d.js — walk a GoldSrc / CS 1.6 map. The .bsp is parsed + baked by
// framework/bake/bake-bsp.ts into assets-bsp-*.ts (worldspawn faces -> textured,
// shade-baked sub-meshes keyed by texture, + a spawn + wall collision rects). This
// loads them as static culled nodes (one Material per texture), a camera-following
// ground/sky (so the chase cam never reveals a void), and a skinned soldier driven by
// the shared deterministic walker (bsp-walk.ts) with AABB collision.
//
// Default map = the committed CC0 box.bsp fixture. Swap by changing the import line.
// Soldier.glb: MIT (three.js).
import {
  start, Scene, Scene3D, Node3D, Mesh, MeshBuilder, SkinnedMesh, meshFromBaked,
  Material, Texture, Vec3, Quat, Colors, rgb, Btn, dsin, dcos, HALF_PI,
  walkStep,
} from '../src/index';
import { THREE_SOLDIER } from '../src/assets-three-soldier';
// Baked BSP scene — DIRECT import (never via index.ts; that would embed the blob in
// every game bundle and OOM the PSP at boot). Swap the map by changing only this line.
import { BSP_BOX as BSP } from '../src/assets-bsp-box';

/** @import { UpdateContext, Graphics } from '../src/index' */

/** @param {number} v @param {number} a @param {number} b @returns {number} */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Small-tile ground grid (one mesh) — guard-band-safe + follows the camera.
 * @param {number} n @param {number} step @param {number} color
 */
function gridGround(n, step, color) {
  const b = new MeshBuilder();
  const half = (n * step) / 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * step, z0 = -half + j * step, x1 = x0 + step, z1 = z0 + step;
      b.quad(b.vertex(x0, 0, z1, color), b.vertex(x1, 0, z1, color), b.vertex(x1, 0, z0, color), b.vertex(x0, 0, z0, color));
    }
  }
  return b.build();
}

/**
 * Tessellated box for a camera-following skybox (no giant guard-band triangle).
 * @param {number} half @param {number} n @param {number} side @param {number} top @param {number} bottom
 */
function tessBox(half, n, side, top, bottom) {
  const b = new MeshBuilder();
  const step = (2 * half) / n;
  const faces = [[0, 1, side], [0, -1, side], [2, 1, side], [2, -1, side], [1, 1, top], [1, -1, bottom]];
  for (const [ax, sign, col] of faces) {
    const u = (ax + 1) % 3, v = (ax + 2) % 3;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([di, dj]) => {
          const p = [0, 0, 0]; p[ax] = sign * half; p[u] = -half + (i + di) * step; p[v] = -half + (j + dj) * step;
          return b.vertex(p[0], p[1], p[2], col);
        });
        b.quad(idx[0], idx[1], idx[2], idx[3]);
      }
    }
  }
  return b.build();
}

const GSTEP = 6;
const GTILES = 14;

class BspScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {SkinnedMesh} */ soldier = /** @type {any} */ (null);
  /** @type {Node3D} */ actor = /** @type {any} */ (null);
  /** @type {Node3D} */ ground = /** @type {any} */ (null);
  /** @type {Node3D} */ sky = /** @type {any} */ (null);
  /** @type {Float32Array} */ aabbs = /** @type {any} */ (null);
  /** Shared walker state. */ st = { x: 0, z: 0, heading: 0 };
  camYaw = 0;
  span = BSP.span;
  floorY = BSP.floorY;
  camDist = clamp(BSP.span * 0.9, 3.5, 8.5);
  total = 0;
  fps = 0;
  _lastNow = 0; _accUs = 0; _frames = 0;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    const farFog = Math.max(60, this.span * 2.2);
    this.world.camera.setPerspective(64, 480 / 272, 0.08, farFog * 4);
    this.world.fog = { color: BSP.skyColor, near: farFog * 0.6, far: farFog };

    // One Material per baked texture; sub-meshes are pre-sorted by texId so each
    // texture binds once for its whole run.
    const mats = BSP.textures.map((t) => new Material({ texture: new Texture(t.pixels, t.width, t.height, t.psm) }));

    // Camera-following sky + ground (cover any void; small guard-band-safe tris).
    const sky = BSP.skyColor;
    const skyTop = rgb(Math.min(255, ((sky >> 16) & 255) + 22), Math.min(255, ((sky >> 8) & 255) + 22), Math.min(255, (sky & 255) + 26));
    this.sky = this.world.add(new Node3D({ mesh: tessBox(Math.max(120, this.span * 3), 4, sky, skyTop, BSP.groundColor), position: new Vec3(0, this.floorY + 30, 0) }));
    this.ground = this.world.add(new Node3D({ mesh: gridGround(GTILES, GSTEP, BSP.groundColor), position: new Vec3(0, this.floorY - 0.05, 0) }));

    // The baked map: static, bounded (=> culled) sub-meshes.
    for (const m of BSP.meshes()) {
      const node = new Node3D({ mesh: meshFromBaked(m), material: mats[m.texId], isStatic: true });
      node.bounds = { min: m.aabb.min, max: m.aabb.max };
      this.world.add(node);
    }

    const ab = BSP.solidAABBs;
    this.aabbs = new Float32Array(ab.buffer, ab.byteOffset, ab.byteLength >> 2);

    this.soldier = SkinnedMesh.fromBaked(THREE_SOLDIER);
    this.soldier.play(THREE_SOLDIER.clips.Walk);
    this.actor = this.world.add({});
    this.actor.add(new Node3D({
      skinned: this.soldier,
      rotation: Quat.fromEuler(-HALF_PI, 0, 0),
      scale: new Vec3(THREE_SOLDIER.scale, THREE_SOLDIER.scale, THREE_SOLDIER.scale),
    }));

    this.total = this.world.root.children.length;
    this.reset();
    ctx.engine.scene3d = this.world;
  }

  reset() {
    this.st.x = BSP.spawn[0]; this.st.z = BSP.spawn[1]; this.st.heading = BSP.spawn[2];
    this.camYaw = BSP.spawn[2];
    this.soldier.play(THREE_SOLDIER.clips.Walk);
  }

  measureFps() {
    const host = /** @type {any} */ (globalThis);
    if (typeof host.now !== 'function') return;
    const t = host.now();
    if (this._lastNow) {
      this._accUs += t - this._lastNow; this._frames++;
      if (this._accUs >= 1e6) { this.fps = Math.round((this._frames * 1e6) / this._accUs); this._accUs = 0; this._frames = 0; }
    }
    this._lastNow = t;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.measureFps();
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) this.reset();
    if (inp.held(Btn.Circle)) this.camYaw += 1.7 * ctx.dt;
    if (inp.held(Btn.Triangle)) this.camYaw -= 1.7 * ctx.dt;

    const iz = (inp.held(Btn.Up) ? 1 : 0) - (inp.held(Btn.Down) ? 1 : 0);
    const ix = (inp.held(Btn.Right) ? 1 : 0) - (inp.held(Btn.Left) ? 1 : 0);
    const run = inp.held(Btn.Square);
    const moving = walkStep(this.st, this.aabbs, this.span - 0.5, ix, iz, run, this.camYaw, ctx.dt);

    const clip = !moving ? THREE_SOLDIER.clips.Idle : run ? THREE_SOLDIER.clips.Run : THREE_SOLDIER.clips.Walk;
    if (this.soldier.player.clip !== clip) this.soldier.play(clip);
    this.soldier.player.advance(ctx.dt * (run ? 1.4 : 1.0));

    this.actor.position = new Vec3(this.st.x, this.floorY, this.st.z);
    this.actor.rotation = Quat.fromEuler(0, this.st.heading, 0);

    const camFx = dsin(this.camYaw), camFz = dcos(this.camYaw);
    const eye = new Vec3(this.st.x - camFx * this.camDist, this.floorY + 2.4, this.st.z - camFz * this.camDist);
    const focus = new Vec3(this.st.x + camFx * 1.5, this.floorY + 1.4, this.st.z + camFz * 1.5);
    this.world.camera.lookAt(eye, focus, new Vec3(0, 1, 0));
    this.ground.position = new Vec3(Math.round(eye.x / GSTEP) * GSTEP, this.floorY - 0.05, Math.round(eye.z / GSTEP) * GSTEP);
    this.sky.position = new Vec3(eye.x, this.floorY + 30, eye.z);
  }

  /** @param {Graphics} g */
  draw(g) {
    const drawn = this.total - this.world.culledCount;
    g.text('BSP MAP 3D', 8, 8, Colors.white, 1);
    g.text(BSP.title, 8, 20, Colors.yellow, 1);
    if (this.fps > 0) g.text(this.fps + ' FPS  ' + drawn + '/' + this.total, 410 - 96, 8, Colors.yellow, 1);
    g.text('D-PAD MOVE  [] RUN  O/^ ORBIT CAM', 8, 246, Colors.cyan, 1);
    g.text(BSP.attribution, 8, 258, Colors.gray, 1);
  }
}

start(() => new BspScene());

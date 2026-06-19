// @ts-check
// @title City Walk 3D
// @order 17
// @controls D-PAD move (soldier turns to face); SQUARE run; O/^ orbit cam; START reset
// city3d.js — walk a REAL place. The streetscape is baked from OpenStreetMap by
// framework/bake/bake-osm.ts into assets-osm-*.ts (buildings extruded from their
// footprints + tagged heights, window-textured walls, roads as flat ribbons, sun-lit).
// We load those static culled sub-meshes (like outdoor3d), optionally add a hand-modeled
// hero landmark, and let a skinned soldier walk the streets with AABB collision against
// every building. Swap the location by changing only the import line below.
//
// Movement is CAMERA-RELATIVE: the D-pad moves the soldier in screen directions and
// the model turns to FACE the way it walks (datan2 of the move vector, eased); the
// camera holds a stable yaw you orbit with Circle/Triangle, so the turn is visible.
// The ground + sky are small, tessellated, CAMERA-FOLLOWING meshes — never one giant
// triangle, which the PSP GE guard-band would drop (the "random black faces" bug).
//
// Map data © OpenStreetMap contributors, ODbL — https://www.openstreetmap.org/copyright
// Soldier.glb: MIT (three.js).
import {
  start, Scene, Scene3D, Node3D, Mesh, MeshBuilder, TexMeshBuilder, SkinnedMesh, meshFromBaked,
  Material, Texture, Lighting, DirectionalLight, Vec3, Quat, Colors, rgb, Btn,
  dsin, dcos, datan2, HALF_PI, TWO_PI,
} from '../src/index';
import { THREE_SOLDIER } from '../src/assets-three-soldier';
// Baked OSM scene — imported via its DIRECT path (NEVER through index.ts, which
// would embed this blob into every game's bundle and OOM the PSP at boot). Swap the
// location by changing ONLY this line to another baked assets-osm-*.ts module.
import { OSM_SHANGHAI as OSM } from '../src/assets-osm-shanghai';

/** @import { UpdateContext, Graphics } from '../src/index' */

/** @param {number} v @param {number} a @param {number} b @returns {number} */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Ease angle `a` toward `b` by fraction `t`, taking the short way around the
 * circle. Deterministic (only Math.round) so it never breaks the no-trig golden.
 * @param {number} a @param {number} b @param {number} t @returns {number}
 */
function turnToward(a, b, t) {
  let d = b - a;
  d -= TWO_PI * Math.round(d / TWO_PI); // wrap to [-PI, PI]
  return a + d * (t < 1 ? t : 1);
}

/**
 * A flat ground tile-grid centred at origin: `n`×`n` quads of `step` metres. Many
 * small triangles instead of one giant plane, so the PSP guard band never drops it.
 * @param {number} n @param {number} step @param {import('../src/index').Color} color
 */
function gridGround(n, step, color) {
  const b = new TexMeshBuilder({ uv: true, normal: true });
  const half = (n * step) / 2;
  const t = step / 6; // pavement-tile repeats per quad (≈6 m tiles)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * step;
      const z0 = -half + j * step;
      const x1 = x0 + step;
      const z1 = z0 + step;
      const u0 = i * t;
      const v0 = j * t;
      const i0 = b.vertex(x0, 0, z1, color, u0, v0 + t, 0, 1, 0);
      const i1 = b.vertex(x1, 0, z1, color, u0 + t, v0 + t, 0, 1, 0);
      const i2 = b.vertex(x1, 0, z0, color, u0 + t, v0, 0, 1, 0);
      const i3 = b.vertex(x0, 0, z0, color, u0, v0, 0, 1, 0);
      b.quad(i0, i1, i2, i3);
    }
  }
  return b.build();
}

/**
 * A tessellated box (each face `n`×`n` quads) used as a camera-following skybox, so
 * no single sky triangle is huge enough to trip the guard band. Side faces get
 * `side`, top `top`, bottom `bottom`.
 * @param {number} half @param {number} n
 * @param {number} side @param {number} top @param {number} bottom
 */
function tessBox(half, n, side, top, bottom) {
  const b = new MeshBuilder();
  const step = (2 * half) / n;
  // [fixed axis, sign, color]; the other two axes are tessellated.
  const faces = [[0, 1, side], [0, -1, side], [2, 1, side], [2, -1, side], [1, 1, top], [1, -1, bottom]];
  for (const [ax, sign, col] of faces) {
    const u = (ax + 1) % 3;
    const v = (ax + 2) % 3;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const idx = corners.map(([di, dj]) => {
          const p = [0, 0, 0];
          p[ax] = sign * half;
          p[u] = -half + (i + di) * step;
          p[v] = -half + (j + dj) * step;
          return b.vertex(p[0], p[1], p[2], col);
        });
        b.quad(idx[0], idx[1], idx[2], idx[3]);
      }
    }
  }
  return b.build();
}

// Hero Arc de Triomphe stone (6 box face colors: +X,-X,+Y,-Y,+Z,-Z).
const STONE = [rgb(208, 198, 178), rgb(186, 176, 158), rgb(224, 214, 192), rgb(150, 142, 128), rgb(198, 188, 169), rgb(172, 163, 146)];

const GROUND_STEP = 30; // metres per ground tile (small => guard-band safe)
const GROUND_TILES = 11; // 11×30 = 330 m grid, follows the camera

class CityScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  /** @type {SkinnedMesh} */ soldier = /** @type {any} */ (null);
  /** @type {Node3D} */ actor = /** @type {any} */ (null);
  /** Per-building XZ collision rects [minX, minZ, maxX, maxZ]. @type {Float32Array} */
  aabbs = /** @type {any} */ (null);
  /** Extra hand-placed blockers (the Arc piers). @type {number[][]} */
  piers = [];
  x = 0;
  z = 0;
  heading = 0;
  camYaw = 0; // camera orbit angle (decoupled from the soldier's heading)
  /** @type {Node3D} */ ground = /** @type {any} */ (null);
  /** @type {Node3D} */ sky = /** @type {any} */ (null);
  span = OSM.span;
  drawn = 0;
  total = 0;
  fps = 0;
  _lastNow = 0;
  _accUs = 0;
  _frames = 0;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    // Far clip only needs to clear the camera-following sky box (half 170 ⇒ corner
    // ~240 m); the real cull far-plane is the much nearer fog.far.
    this.world.camera.setPerspective(64, 480 / 272, 0.1, 520);

    // Atmospheric haze that doubles as the cull far-plane. far must EXCEED a chunk's
    // half-diagonal (~55 m for the 77 m cells) so a chunk only ever distance-culls
    // once it is already fog-faded — never a hard pop to black.
    this.world.fog = { color: OSM.skyColor, near: 95, far: 145 };

    // One directional sun + ambient; the GE lights every building wall by its
    // baked normal, so sunlit and shaded facades read with real relief. Ambient is
    // kept high so north-facing walls never go black.
    const lighting = new Lighting(rgb(120, 124, 134));
    lighting.add(new DirectionalLight(new Vec3(-0.55, -1, -0.4), rgb(255, 246, 224)));
    this.world.lighting = lighting;

    // The two baked wrapping textures, shared by every sub-mesh of their kind so the
    // GE binds each only once: facade (windows) modulates walls; pavement modulates
    // roads + the ground. Both REPEAT, so the baked UVs tile them.
    const fa = OSM.facade;
    const pv = OSM.pavement;
    const facadeMat = new Material({ texture: new Texture(fa.pixels, fa.width, fa.height, fa.psm) });
    const paveMat = new Material({ texture: new Texture(pv.pixels, pv.width, pv.height, pv.psm) });

    // Camera-following skybox: a TESSELLATED box (no giant triangle => no guard-band
    // dropout) whose walls sit at 170 m — past fog.far, so they fade to exactly the
    // fog colour for a seamless daytime horizon. Dynamic (not isStatic) so it rides
    // the per-frame pass and is never culled; repositioned onto the camera each frame.
    const sky = OSM.skyColor;
    const skyTop = rgb(
      Math.min(255, ((sky >> 16) & 255) + 26),
      Math.min(255, ((sky >> 8) & 255) + 22),
      Math.min(255, (sky & 255) + 18),
    );
    this.sky = this.world.add(new Node3D({
      mesh: tessBox(170, 4, sky, skyTop, OSM.groundColor),
      position: new Vec3(0, 40, 0),
    }));

    // Camera-following tessellated ground grid (small quads => guard-band safe),
    // covering a 330 m disc around the camera; edges sit past fog.far so they fade
    // into the horizon. Dynamic so it tracks the camera each frame.
    this.ground = this.world.add(new Node3D({
      mesh: gridGround(GROUND_TILES, GROUND_STEP, OSM.groundColor),
      material: paveMat,
      position: new Vec3(0, -0.03, 0),
    }));

    // The baked city: each sub-mesh is a static, bounded (=> culled) node. They come
    // pre-sorted by texId, so binding facade→pavement→none stays coherent.
    const mat = [facadeMat, paveMat]; // texId 0, 1; texId -1 => untextured
    for (const m of OSM.meshes()) {
      const node = new Node3D({
        mesh: meshFromBaked(m),
        material: m.texId >= 0 ? mat[m.texId] : undefined,
        isStatic: true,
      });
      node.bounds = { min: m.aabb.min, max: m.aabb.max };
      this.world.add(node);
    }

    // Per-building collision rectangles (decoded Float32 view of the baked blob).
    const ab = OSM.buildingAABBs;
    this.aabbs = new Float32Array(ab.buffer, ab.byteOffset, ab.byteLength >> 2);

    if (OSM.hero === 'arc') this.buildArch(); // hand-modeled landmark (Paris only)

    // The walking soldier (humanoid, native PSP skin path). Parent actor carries
    // world position/heading; the child tilts the Z-up model up to Y-up + scales.
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

  // A hand-modeled hero Arc de Triomphe at the plaza centre: four corner piers +
  // an attic slab, open on both avenue axes so the soldier can walk through it and
  // the camera sees daylight under it. The real Arc's tiny OSM footprint is dropped
  // at bake time (skipNames) so this stands alone.
  buildArch() {
    const pierW = 9, pierH = 36, off = 13, atticY = 42, atticH = 12, atticW = 46;
    for (const sx of [-off, off]) {
      for (const sz of [-off, off]) {
        const node = new Node3D({
          mesh: Mesh.box(pierW, pierH, pierW, STONE),
          position: new Vec3(sx, pierH / 2, sz),
          isStatic: true,
        });
        node.bounds = { min: [-pierW / 2, -pierH / 2, -pierW / 2], max: [pierW / 2, pierH / 2, pierW / 2] };
        this.world.add(node);
        this.piers.push([sx - pierW / 2, sz - pierW / 2, sx + pierW / 2, sz + pierW / 2]);
      }
    }
    const attic = new Node3D({
      mesh: Mesh.box(atticW, atticH, atticW, STONE),
      position: new Vec3(0, atticY, 0),
      isStatic: true,
    });
    attic.bounds = { min: [-atticW / 2, -atticH / 2, -atticW / 2], max: [atticW / 2, atticH / 2, atticW / 2] };
    this.world.add(attic);
  }

  reset() {
    const s = OSM.spawn;
    this.x = s[0];
    this.z = s[1];
    this.heading = s[2];
    this.camYaw = s[2];
    this.soldier.play(THREE_SOLDIER.clips.Walk);
  }

  /** @param {number} nx @param {number} nz @returns {boolean} */
  blocked(nx, nz) {
    const r = 0.6;
    const a = this.aabbs;
    for (let i = 0; i < a.length; i += 4) {
      if (nx + r > a[i] && nx - r < a[i + 2] && nz + r > a[i + 1] && nz - r < a[i + 3]) return true;
    }
    for (const p of this.piers) {
      if (nx + r > p[0] && nx - r < p[2] && nz + r > p[1] && nz - r < p[3]) return true;
    }
    return false;
  }

  /**
   * Axis-separated move so the soldier slides along walls instead of sticking.
   * @param {number} nx @param {number} nz
   */
  moveTo(nx, nz) {
    const lim = this.span - 12;
    nx = clamp(nx, -lim, lim);
    nz = clamp(nz, -lim, lim);
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

    // Circle / Triangle orbit the camera (the camera yaw is independent of where
    // the soldier faces, so a turn is actually visible on screen).
    if (inp.held(Btn.Circle)) this.camYaw += 1.7 * ctx.dt;
    if (inp.held(Btn.Triangle)) this.camYaw -= 1.7 * ctx.dt;
    const camFx = dsin(this.camYaw);
    const camFz = dcos(this.camYaw);

    // Camera-relative D-pad: Up = into the screen, Right = camera-right, etc.
    const iz = (inp.held(Btn.Up) ? 1 : 0) - (inp.held(Btn.Down) ? 1 : 0);
    const ix = (inp.held(Btn.Right) ? 1 : 0) - (inp.held(Btn.Left) ? 1 : 0);
    const run = inp.held(Btn.Square);
    const moving = ix !== 0 || iz !== 0;
    // World move = forward*iz + cameraRight*ix; cameraRight = forward rotated -90°.
    const mx = camFx * iz + camFz * ix;
    const mz = camFz * iz - camFx * ix;

    const clip = !moving ? THREE_SOLDIER.clips.Idle : run ? THREE_SOLDIER.clips.Run : THREE_SOLDIER.clips.Walk;
    if (this.soldier.player.clip !== clip) this.soldier.play(clip);

    if (moving) {
      const speed = run ? 6.6 : 3.2;
      // Turn the model to FACE the direction it walks (eased, shortest arc).
      const target = datan2(mx, mz);
      this.heading = turnToward(this.heading, target, 12 * ctx.dt);
      this.soldier.player.advance(ctx.dt * (run ? 1.4 : 1.0));
      const inv = 1 / Math.sqrt(mx * mx + mz * mz); // normalize diagonals
      this.moveTo(this.x + mx * inv * speed * ctx.dt, this.z + mz * inv * speed * ctx.dt);
    } else {
      this.soldier.player.advance(ctx.dt);
    }

    this.actor.position = new Vec3(this.x, 0, this.z);
    this.actor.rotation = Quat.fromEuler(0, this.heading, 0);

    // Chase camera anchored on camYaw (NOT the soldier's heading): behind + above,
    // looking a little ahead. The ground + sky follow the camera so they always
    // cover the view with small (guard-band-safe) triangles.
    const eye = new Vec3(this.x - camFx * 8.5, 4.2, this.z - camFz * 8.5);
    const focus = new Vec3(this.x + camFx * 2.0, 2.2, this.z + camFz * 2.0);
    this.world.camera.lookAt(eye, focus, new Vec3(0, 1, 0));
    // Snap the ground to its tile grid so it doesn't visibly swim under the player.
    this.ground.position = new Vec3(
      Math.round(this.x / GROUND_STEP) * GROUND_STEP, -0.03,
      Math.round(this.z / GROUND_STEP) * GROUND_STEP,
    );
    this.sky.position = new Vec3(this.x, 40, this.z);
  }

  /** @param {Graphics} g */
  draw(g) {
    this.drawn = this.total - this.world.culledCount;
    g.text('CITY WALK 3D', 8, 8, Colors.white, 1);
    g.text(OSM.title, 8, 20, Colors.yellow, 1);
    if (this.fps > 0) g.text(this.fps + ' FPS  ' + this.drawn + '/' + this.total, 410 - 96, 8, Colors.yellow, 1);
    g.text('D-PAD MOVE  [] RUN  O/^ ORBIT CAM', 8, 246, Colors.cyan, 1);
    g.text('(c) OpenStreetMap (ODbL)', 8, 258, Colors.gray, 1);
  }
}

start(() => new CityScene());

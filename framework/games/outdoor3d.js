// @ts-check
// @title Outdoor 3D
// @order 15
// @controls LEFT/RIGHT turn; CROSS boost; UP/DOWN pitch; START reset
// outdoor3d.js — the M6 milestone: the hardware MAX-OUT scene. A JS heightmap
// terrain (deterministic dsin/dcos noise) split into chunks, scattered with
// instanced Kenney nature props (one upload each, many draws), lit by one
// directional sun + ambient (HW T&L over the terrain/prop normals), with distance
// fog bounding draw distance. Scene3D frustum/distance-culls chunks + props each
// frame so the GE stays in budget. All terrain/scatter/camera logic is JS.
import {
  start, Scene, Scene3D, Node3D, TexMeshBuilder, Texture, Material,
  Lighting, DirectionalLight, meshFromBaked,
  Vec3, Quat, Colors, rgb, Btn, dsin, dcos,
} from '../src/index';
import { NATURE_PROPS } from '../src/assets-kenney-nature';

/** @import { UpdateContext, Graphics } from '../src/index' */

/** @param {number} v @param {number} a @param {number} b @returns {number} */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Deterministic terrain height (shared by mesh gen + camera grounding).
/** @param {number} x @param {number} z @returns {number} */
function height(x, z) {
  return (
    2.2 * dsin(x * 0.15) * dcos(z * 0.13) +
    1.3 * dsin(x * 0.06 + z * 0.05) +
    0.7 * dcos(x * 0.27 - z * 0.21)
  );
}

const WORLD = 120; // terrain spans [-60,60] in X and Z
const CHUNKS = 6; // CHUNKS×CHUNKS grid
const CELLS = 8; // quads per chunk edge

class OutdoorScene extends Scene {
  /** @type {Scene3D} */ world = /** @type {any} */ (null);
  x = 0;
  z = 40;
  y = 6;
  heading = Math.PI; // face -Z (into the field)
  pitch = -0.15;
  drawn = 0;

  /** @param {UpdateContext} ctx */
  onEnter(ctx) {
    this.world = new Scene3D();
    this.world.camera.setPerspective(64, 480 / 272, 0.1, 200);

    // One directional sun + ambient; the GE lights terrain + props by their normals.
    const lighting = new Lighting(0x383c44);
    lighting.add(new DirectionalLight(new Vec3(-0.5, -1, -0.35), 0xfff2d8));
    this.world.lighting = lighting;

    // Distance fog fades far geometry into the sky-ish background; also the cull
    // far plane, so chunks past it are skipped entirely.
    this.world.fog = { color: rgb(0x18, 0x20, 0x30), near: 26, far: 60 };

    // Shared ground texture (procedural grass-ish checker).
    const groundMat = new Material({ texture: Texture.checker(64, 64, rgb(58, 104, 52), rgb(74, 120, 64), 8) });

    this.buildTerrain(groundMat);
    this.scatterProps();

    ctx.engine.scene3d = this.world;
  }

  /** Build the chunked, lit, textured heightmap terrain. @param {Material} mat */
  buildTerrain(mat) {
    const half = WORLD / 2;
    const chunkSize = WORLD / CHUNKS;
    const step = chunkSize / CELLS;
    const e = 0.5; // normal finite-difference epsilon
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const ox = -half + cx * chunkSize;
        const oz = -half + cz * chunkSize;
        const b = new TexMeshBuilder({ uv: true, normal: true });
        let minY = 1e9;
        let maxY = -1e9;
        const idx = [];
        for (let j = 0; j <= CELLS; j++) {
          for (let i = 0; i <= CELLS; i++) {
            const wx = ox + i * step;
            const wz = oz + j * step;
            const h = height(wx, wz);
            if (h < minY) minY = h;
            if (h > maxY) maxY = h;
            // normal from the heightfield gradient.
            const dx = height(wx + e, wz) - height(wx - e, wz);
            const dz = height(wx, wz + e) - height(wx, wz - e);
            const nl = Math.hypot(-dx, 2 * e, -dz) || 1;
            // tint by height (darker low, lighter high) for relief without texture.
            const t = clamp((h + 4) / 8, 0, 1);
            const col = rgb(50 + (t * 40) | 0, 90 + (t * 50) | 0, 48 + (t * 30) | 0);
            idx.push(b.vertex(wx, h, wz, col, i / CELLS, j / CELLS, -dx / nl, (2 * e) / nl, -dz / nl));
          }
        }
        const row = CELLS + 1;
        for (let j = 0; j < CELLS; j++) {
          for (let i = 0; i < CELLS; i++) {
            const a = idx[j * row + i];
            const bb = idx[j * row + i + 1];
            const c = idx[(j + 1) * row + i + 1];
            const d = idx[(j + 1) * row + i];
            b.quad(a, bb, c, d);
          }
        }
        // Static: terrain never moves, so Scene3D caches its world matrix +
        // bounds (only a cheap per-frame cull test remains).
        const node = new Node3D({ mesh: b.build(), material: mat, isStatic: true });
        node.bounds = { min: [ox, minY, oz], max: [ox + chunkSize, maxY, oz + chunkSize] };
        this.world.add(node);
      }
    }
  }

  /** Scatter instanced nature props (one upload each, culled per-instance). */
  scatterProps() {
    const meshes = {
      tree: meshFromBaked(NATURE_PROPS.tree),
      rock: meshFromBaked(NATURE_PROPS.rock),
      bush: meshFromBaked(NATURE_PROPS.bush),
    };
    const bounds = {
      tree: NATURE_PROPS.tree.aabb,
      rock: NATURE_PROPS.rock.aabb,
      bush: NATURE_PROPS.bush.aabb,
    };
    const kinds = /** @type {const} */ (['tree', 'tree', 'rock', 'bush']);
    // Deterministic scatter via a small LCG over a grid (no Math.random).
    let seed = 0x9e3779b1 >>> 0;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const half = WORLD / 2 - 4;
    for (let n = 0; n < 90; n++) {
      const px = -half + rnd() * (half * 2);
      const pz = -half + rnd() * (half * 2);
      const kind = kinds[(rnd() * kinds.length) | 0];
      const s = 1.6 + rnd() * 1.6;
      const yaw = rnd() * Math.PI * 2;
      const node = new Node3D({
        mesh: meshes[kind],
        position: new Vec3(px, height(px, pz), pz),
        rotation: Quat.fromEuler(0, yaw, 0),
        scale: new Vec3(s, s, s),
        isStatic: true, // scattered props never move
      });
      const ab = bounds[kind];
      // local bounds scaled (rotation about Y kept loose; pad a touch).
      node.bounds = {
        min: [ab.min[0] * s, ab.min[1] * s, ab.min[2] * s],
        max: [ab.max[0] * s, ab.max[1] * s, ab.max[2] * s],
      };
      this.world.add(node);
    }
  }

  reset() {
    this.x = 0;
    this.z = 40;
    this.heading = Math.PI;
    this.pitch = -0.15;
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    const inp = ctx.input;
    if (inp.pressed(Btn.Start)) this.reset();
    if (inp.held(Btn.Left)) this.heading += 1.1 * ctx.dt;
    if (inp.held(Btn.Right)) this.heading -= 1.1 * ctx.dt;
    if (inp.held(Btn.Up)) this.pitch = clamp(this.pitch + 0.8 * ctx.dt, -0.8, 0.5);
    if (inp.held(Btn.Down)) this.pitch = clamp(this.pitch - 0.8 * ctx.dt, -0.8, 0.5);

    // Always drift forward (a slow fly-through that exercises culling); boost on X.
    const speed = inp.held(Btn.Cross) ? 16 : 7;
    const fwdX = dsin(this.heading);
    const fwdZ = dcos(this.heading);
    this.x = clamp(this.x + fwdX * speed * ctx.dt, -56, 56);
    this.z = clamp(this.z + fwdZ * speed * ctx.dt, -56, 56);
    // Stay a fixed height above the ground under the camera.
    this.y = height(this.x, this.z) + 5;

    const eye = new Vec3(this.x, this.y, this.z);
    const look = new Vec3(
      this.x + fwdX * 6,
      this.y + this.pitch * 6,
      this.z + fwdZ * 6,
    );
    this.world.camera.lookAt(eye, look, new Vec3(0, 1, 0));
  }

  /** @param {Graphics} g */
  draw(g) {
    g.text('OUTDOOR 3D', 8, 8, Colors.white, 2);
    // Show the culling at work: drawn vs culled node counts.
    const total = this.world.root.children.length;
    const culled = this.world.culledCount;
    g.text(total - culled + '/' + total + ' DRAWN  (' + culled + ' CULLED)', 8, 256, Colors.cyan, 1);
  }
}

start(() => new OutdoorScene());

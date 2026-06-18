// A minimal 3D scene graph mirroring the 2D Scene/Node tree. The game builds a
// Scene3D of Node3Ds (each with a mesh + transform) and a Camera; once per frame
// the engine walks it and emits one SET_CAMERA + one DRAW per visible mesh into
// the CommandEncoder (see engine.ts). All transform math is shared deterministic
// f64 (math.ts), so the emitted bytes are identical on every host.
import { CommandEncoder, NO_TINT, UNBIND_TEXTURE, colorToABGR } from './g3d';
import { Mat4, Quat, Vec3 } from './math';
import { SCREEN_H, SCREEN_W } from './host';
import { hasNativeScene } from './host3d';
import type { Color } from './color';
import type { Mesh } from './mesh';
import type { Material } from './material';
import type { Lighting } from './light';
import type { SkinnedMesh } from './skin';

export class Camera {
  proj: number[] = Mat4.identity();
  view: number[] = Mat4.identity();
  viewProj: number[] = Mat4.identity();
  /** Eye position in world space (kept for distance-based culling). */
  eye = new Vec3(0, 0, 0);
  /** Set to false on the WebGL fallback path (clip z in [-1,1]). */
  zeroToOne = true;

  setPerspective(fovDeg: number, aspect: number, near: number, far: number): void {
    this.proj = Mat4.perspectiveReversedZ(fovDeg, aspect, near, far, this.zeroToOne);
    this.recompute();
  }
  lookAt(eye: Vec3, center: Vec3, up: Vec3): void {
    this.eye = eye;
    this.view = Mat4.lookAt(eye, center, up);
    this.recompute();
  }
  recompute(): void {
    this.viewProj = Mat4.multiply(this.proj, this.view);
  }
}

/** Local-space axis-aligned bounds, for frustum/distance culling. */
export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}

// A culling frustum: the 4 side planes (a,b,c,d with inside = a*x+b*y+c*z+d ≥ 0)
// derived from a column-major viewProj, plus the eye + a far cutoff. We skip the
// near/far planes (their derivation depends on the reversed-Z clip convention) and
// bound depth with the explicit far distance instead — robust and convention-free.
interface Frustum {
  planes: number[][];
  ex: number;
  ey: number;
  ez: number;
  far2: number;
}

function makeFrustum(m: number[], eye: Vec3, far: number): Frustum {
  // rows r_i = [m[i], m[4+i], m[8+i], m[12+i]]; side planes = r3 ± r0, r3 ± r1.
  const r0 = [m[0], m[4], m[8], m[12]];
  const r1 = [m[1], m[5], m[9], m[13]];
  const r3 = [m[3], m[7], m[11], m[15]];
  const planes = [
    [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]], // left
    [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]], // right
    [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]], // bottom
    [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]], // top
  ];
  return { planes, ex: eye.x, ey: eye.y, ez: eye.z, far2: far * far };
}

// True when the world-space AABB [wmin,wmax] is entirely outside the frustum (so
// the node can be skipped). Uses the positive-vertex test per side plane + a
// center-distance far cutoff.
function aabbCulled(f: Frustum, wmin: number[], wmax: number[]): boolean {
  for (const p of f.planes) {
    // the corner farthest along the plane normal (most likely inside).
    const px = p[0] >= 0 ? wmax[0] : wmin[0];
    const py = p[1] >= 0 ? wmax[1] : wmin[1];
    const pz = p[2] >= 0 ? wmax[2] : wmin[2];
    if (p[0] * px + p[1] * py + p[2] * pz + p[3] < 0) return true; // fully outside
  }
  const cx = (wmin[0] + wmax[0]) * 0.5 - f.ex;
  const cy = (wmin[1] + wmax[1]) * 0.5 - f.ey;
  const cz = (wmin[2] + wmax[2]) * 0.5 - f.ez;
  return cx * cx + cy * cy + cz * cz > f.far2;
}

export interface Node3DOpts {
  mesh?: Mesh;
  material?: Material;
  skinned?: SkinnedMesh;
  position?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
  tint?: Color;
  /**
   * Mark a node that NEVER moves (terrain, scenery). Scene3D then computes its
   * world matrix + world-space bounds ONCE and reuses them every frame, so a
   * large static scene only pays a cheap cull test per node — not a matrix
   * compose/multiply + 8-corner AABB transform + allocations. Huge win on the
   * interpreted PSP core. Do NOT set on anything that moves or is re-parented.
   */
  isStatic?: boolean;
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
  /** Optional LOCAL-space bounds; when set, Scene3D frustum/distance-culls it. */
  bounds?: AABB;
  tint: number; // ABGR, NO_TINT = untinted
  visible = true;
  /** When true, Scene3D caches this node's world matrix + bounds (see opts). */
  isStatic = false;
  children: Node3D[] = [];
  // Cached world transform + world-space AABB for static nodes (filled lazily by
  // Scene3D.emit on the first frame, reused thereafter). Public so a game that
  // mutates a "static" node can clear them (set to undefined) to force a recompute.
  cw?: number[]; // cached world matrix
  cwMin?: number[]; // cached world AABB min
  cwMax?: number[]; // cached world AABB max

  constructor(opts: Node3DOpts = {}) {
    this.position = opts.position ?? new Vec3(0, 0, 0);
    this.rotation = opts.rotation ?? Quat.identity();
    this.scale = opts.scale ?? new Vec3(1, 1, 1);
    this.mesh = opts.mesh;
    this.material = opts.material;
    this.skinned = opts.skinned;
    this.isStatic = opts.isStatic ?? false;
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
  /** Optional distance fog: fades geometry to `color` between `near` and `far`. */
  fog?: { color: number; near: number; far: number };
  // Per-frame culling frustum (built in render() when any node has bounds).
  private frustum?: Frustum;
  /** Diagnostic: nodes culled in the last render() (for HUD/profiling). */
  culledCount = 0;
  // Flat static draw list (built lazily). When EVERY drawable node is static, the
  // whole scene is flattened into typed arrays and drawn by a tight loop with no
  // per-node object property access / function calls — the interpreted PSP core
  // spends ~1ms/node walking the object tree, which dominates a large scene.
  private flatBuilt = false;
  private allStatic = false;
  // True when static/rigid parts can be drawn by the native retained scene. Any
  // skinned dynamic nodes are appended as a post-pass command buffer so the host
  // still clears only once.
  private nativeEligible = false;
  // Top-of-subtree dynamic nodes (e.g. a moving car); their subtrees are walked
  // each frame for the native scene's dynamic-instance pass. parentWorld is the
  // (constant) world matrix of their static parent.
  private dynamicRoots: { node: Node3D; parentWorld: number[] }[] = [];
  private dynBytes = new ArrayBuffer(256 * 76); // ≤256 dynamic instances × 76 B
  private dynView = new DataView(this.dynBytes);
  private dynCount = 0;
  private sCount = 0;
  // f64 so culling matches the object-walk (f64) bit-for-bit -> identical .dc3d.
  private sAabb = new Float64Array(0); // 6 per node: min xyz, max xyz
  private sModel = new Float32Array(0); // 16 per node (world matrix)
  private sHandle = new Int32Array(0);
  private sTint = new Int32Array(0);
  private sTex = new Int32Array(0);

  /** Force the flat static list + native scene to rebuild (if static nodes change). */
  invalidateStatic(): void {
    this.flatBuilt = false;
    this.sceneUploaded = false;
  }
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

  /**
   * Render the scene. For an all-static scene on a host with the retained native
   * scene API, the scene is uploaded once and the per-frame cull+draw runs
   * NATIVELY (JS only sends the camera). Otherwise a per-frame command buffer is
   * built (flat fast path for all-static, object walk for dynamic) and submitted.
   * Handles submission itself (the engine no longer calls enc.finish()).
   */
  render(enc: CommandEncoder): void {
    if (!this.flatBuilt) this.buildFlat();

    // Native retained-scene fast path (PSP): static instances uploaded once; only
    // the small dynamic subtree (e.g. a car) is walked in JS each frame. Used for
    // any non-skinned scene on a host with the API.
    if (this.nativeEligible && hasNativeScene()) {
      this.renderNative(enc);
      return;
    }

    enc.setCamera(this.camera.viewProj);
    if (this.lighting && this.lighting.lights.length > 0) {
      enc.setLights(this.lighting.ambientABGR(), this.lighting.encoded());
    }
    if (this.fog) {
      enc.setFog(colorToABGR(this.fog.color), this.fog.near, this.fog.far);
      // Cull beyond the fog far plane (geometry there is fully fogged out anyway).
      this.frustum = makeFrustum(this.camera.viewProj, this.camera.eye, this.fog.far);
    } else {
      // Cull only when some node opts in (has bounds); large default far cutoff.
      this.frustum = makeFrustum(this.camera.viewProj, this.camera.eye, 1e6);
    }
    this.boundTex = -1;
    this.culledCount = 0;
    if (this.allStatic) {
      this.emitFlat(enc);
    } else {
      this.emit(this.root, Mat4.identity(), enc);
    }
    enc.finish();
  }

  // Upload the flat static list to the native scene once, then per frame send the
  // camera and let the host cull + draw. The flat arrays (sModel/sAabb/sHandle/
  // sTex/sTint) were already filled by buildFlat().
  private sceneUploaded = false;
  private camBuf = new Float32Array(20);
  private geomBuf = new Float32Array(22);

  private renderNative(enc: CommandEncoder): void {
    const g = globalThis.g3d!;
    if (!this.sceneUploaded) {
      g.sceneClear!();
      const geom = this.geomBuf;
      for (let i = 0; i < this.sCount; i++) {
        for (let k = 0; k < 16; k++) geom[k] = this.sModel[i * 16 + k];
        geom[16] = this.sAabb[i * 6];
        geom[17] = this.sAabb[i * 6 + 1];
        geom[18] = this.sAabb[i * 6 + 2];
        geom[19] = this.sAabb[i * 6 + 3];
        geom[20] = this.sAabb[i * 6 + 4];
        geom[21] = this.sAabb[i * 6 + 5];
        g.sceneAdd!(this.sHandle[i], this.sTex[i], this.sTint[i] >>> 0, geom.buffer);
      }
      g.sceneSetEnv!(this.packEnv());
      this.sceneUploaded = true;
    }
    const vp = this.camera.viewProj;
    const c = this.camBuf;
    for (let i = 0; i < 16; i++) c[i] = vp[i];
    c[16] = this.camera.eye.x;
    c[17] = this.camera.eye.y;
    c[18] = this.camera.eye.z;
    c[19] = this.fog ? this.fog.far : 1e6;
    // Walk the (small) dynamic subtrees each frame, packing rigid world matrices
    // and appending skinned draws into a post-pass command buffer.
    this.dynCount = 0;
    enc.reset();
    this.boundTex = -2; // force the post pass to establish texture state.
    for (let i = 0; i < this.dynamicRoots.length; i++) {
      const dr = this.dynamicRoots[i];
      this.walkDynamic(dr.node, dr.parentWorld, enc);
    }
    const post = enc.packet();
    const drawn = g.sceneRender!(
      this.camBuf.buffer,
      this.dynBytes,
      this.dynCount,
      post.buffer,
      post.byteLength,
    );
    this.culledCount = this.sCount + this.dynCount - (drawn | 0); // HUD/profiling
  }

  // Pack one dynamic subtree into dynBytes (handle, tex, tint, 16 f32 model per
  // rigid drawable node), and emit skinned nodes into the post-pass encoder. Few
  // nodes (a character / car + wheels), so per-node JS cost is fine here.
  private walkDynamic(node: Node3D, parent: number[], post: CommandEncoder): void {
    if (!node.visible) return;
    const world = Mat4.multiply(parent, node.localMatrix());
    if (node.skinned) {
      const tex = node.skinned.texture;
      this.bindIfChanged(tex ? tex.handle() : -1, post);
      node.skinned.emit(post, world, node.tint);
    } else if (node.mesh) {
      const h = node.mesh.handle();
      if (h >= 0 && this.dynCount < 256) {
        const o = this.dynCount * 76;
        const dv = this.dynView;
        dv.setInt32(o, h, true);
        const tex = node.material?.texture;
        dv.setInt32(o + 4, tex ? tex.handle() : -1, true);
        dv.setUint32(o + 8, node.tint >>> 0, true);
        for (let k = 0; k < 16; k++) dv.setFloat32(o + 12 + k * 4, world[k], true);
        this.dynCount++;
      }
    }
    for (let i = 0; i < node.children.length; i++) this.walkDynamic(node.children[i], world, post);
  }

  // Pack lights + fog into the sceneSetEnv buffer (see host3d.ts for the layout).
  private packEnv(): ArrayBuffer {
    const lights = this.lighting && this.lighting.lights.length > 0 ? this.lighting.encoded() : [];
    const count = Math.min(lights.length, 4);
    const ambient = this.lighting ? this.lighting.ambientABGR() : 0;
    const buf = new ArrayBuffer((2 + count * 4 + 3) * 4);
    const dv = new DataView(buf);
    dv.setUint32(0, count, true);
    dv.setUint32(4, ambient >>> 0, true);
    let o = 8;
    for (let i = 0; i < count; i++) {
      dv.setUint32(o, lights[i].color >>> 0, true);
      dv.setFloat32(o + 4, lights[i].dir[0], true);
      dv.setFloat32(o + 8, lights[i].dir[1], true);
      dv.setFloat32(o + 12, lights[i].dir[2], true);
      o += 16;
    }
    if (this.fog) {
      dv.setUint32(o, colorToABGR(this.fog.color) >>> 0, true);
      dv.setFloat32(o + 4, this.fog.near, true);
      dv.setFloat32(o + 8, this.fog.far, true);
    } else {
      dv.setUint32(o, 0xffffffff, true);
    }
    return buf;
  }

  // Walk the tree once (DFS / emit order) and classify drawable nodes: static mesh
  // nodes go to the flat arrays (uploaded once / drawn by emitFlat); the topmost
  // node of each dynamic subtree becomes a dynamicRoot (walked per frame). Skinned
  // nodes are dynamic roots too on native hosts, but only their small subtree is
  // walked; static scenery stays in the retained native scene.
  private buildFlat(): void {
    this.flatBuilt = true;
    this.dynamicRoots = [];
    const nodes: Node3D[] = []; // static mesh nodes
    const worlds: number[][] = [];
    let allStatic = true;
    const walk = (node: Node3D, parent: number[], parentStatic: boolean): void => {
      if (!node.visible) return;
      if (node.skinned) {
        allStatic = false;
        if (parentStatic) this.dynamicRoots.push({ node, parentWorld: parent });
        return;
      }
      if (node.isStatic) {
        const world = node.cw ? node.cw : Mat4.multiply(parent, node.localMatrix());
        node.cw = world;
        if (node.mesh) {
          nodes.push(node);
          worlds.push(world);
        }
        for (const c of node.children) walk(c, world, true);
      } else {
        // Dynamic node: the topmost one (static parent) is a dynamic root; its
        // subtree is walked each frame, not collected here.
        allStatic = false;
        if (parentStatic && (node.mesh || node.children.length > 0)) {
          this.dynamicRoots.push({ node, parentWorld: parent });
        }
        const world = Mat4.multiply(parent, node.localMatrix());
        for (const c of node.children) walk(c, world, false);
      }
    };
    // The root is a pure container (identity, never moves) — treat as static origin.
    for (const c of this.root.children) walk(c, Mat4.identity(), true);
    this.allStatic = allStatic && nodes.length > 0;
    this.nativeEligible = nodes.length + this.dynamicRoots.length > 0;

    // Only flatten (and eagerly upload static meshes) when a path actually uses
    // the flat arrays: the native scene, or the non-native emitFlat fast path.
    // A mixed scene on a non-native host uses the object walk (lazy upload), so
    // leaving the arrays empty keeps its .dc3d golden's upload order unchanged.
    const useFlat = this.allStatic || (this.nativeEligible && hasNativeScene());
    if (!useFlat) return;

    const n = nodes.length;
    this.sCount = n;
    this.sAabb = new Float64Array(n * 6);
    this.sModel = new Float32Array(n * 16);
    this.sHandle = new Int32Array(n);
    this.sTint = new Int32Array(n);
    this.sTex = new Int32Array(n);
    const wmin: number[] = [0, 0, 0];
    const wmax: number[] = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      const world = worlds[i];
      for (let k = 0; k < 16; k++) this.sModel[i * 16 + k] = world[k];
      if (node.bounds) {
        this.worldAABB(node.bounds, world, wmin, wmax);
      } else {
        wmin[0] = wmin[1] = wmin[2] = -1e30; // no bounds -> never cull
        wmax[0] = wmax[1] = wmax[2] = 1e30;
      }
      this.sAabb[i * 6] = wmin[0];
      this.sAabb[i * 6 + 1] = wmin[1];
      this.sAabb[i * 6 + 2] = wmin[2];
      this.sAabb[i * 6 + 3] = wmax[0];
      this.sAabb[i * 6 + 4] = wmax[1];
      this.sAabb[i * 6 + 5] = wmax[2];
      this.sHandle[i] = node.mesh!.handle();
      this.sTint[i] = node.tint | 0;
      const tex = node.material?.texture;
      this.sTex[i] = tex ? tex.handle() : -1;
    }
  }

  // The flat static draw loop: cull + draw straight from typed arrays, no per-node
  // object access. Emits the SAME records in the SAME order as the object walk
  // (so the .dc3d golden is byte-identical), just far cheaper on the PSP.
  private emitFlat(enc: CommandEncoder): void {
    const f = this.frustum!;
    const planes = f.planes;
    const a = this.sAabb;
    for (let i = 0; i < this.sCount; i++) {
      const b = i * 6;
      let culled = false;
      for (let p = 0; p < 4; p++) {
        const pl = planes[p];
        const px = pl[0] >= 0 ? a[b + 3] : a[b];
        const py = pl[1] >= 0 ? a[b + 4] : a[b + 1];
        const pz = pl[2] >= 0 ? a[b + 5] : a[b + 2];
        if (pl[0] * px + pl[1] * py + pl[2] * pz + pl[3] < 0) {
          culled = true;
          break;
        }
      }
      if (!culled) {
        const cx = (a[b] + a[b + 3]) * 0.5 - f.ex;
        const cy = (a[b + 1] + a[b + 4]) * 0.5 - f.ey;
        const cz = (a[b + 2] + a[b + 5]) * 0.5 - f.ez;
        if (cx * cx + cy * cy + cz * cz > f.far2) culled = true;
      }
      if (culled) {
        this.culledCount++;
        continue;
      }
      const h = this.sHandle[i];
      if (h < 0) continue;
      this.bindIfChanged(this.sTex[i], enc);
      enc.drawAt(h, this.sModel, i * 16, this.sTint[i] >>> 0);
    }
  }

  // World-space AABB of a node's local bounds under `world` (transform 8 corners).
  private worldAABB(b: AABB, world: number[], outMin: number[], outMax: number[]): void {
    for (let i = 0; i < 3; i++) { outMin[i] = Infinity; outMax[i] = -Infinity; }
    for (let c = 0; c < 8; c++) {
      const lx = c & 1 ? b.max[0] : b.min[0];
      const ly = c & 2 ? b.max[1] : b.min[1];
      const lz = c & 4 ? b.max[2] : b.min[2];
      const x = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
      const y = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
      const z = world[2] * lx + world[6] * ly + world[10] * lz + world[14];
      if (x < outMin[0]) outMin[0] = x; if (x > outMax[0]) outMax[0] = x;
      if (y < outMin[1]) outMin[1] = y; if (y > outMax[1]) outMax[1] = y;
      if (z < outMin[2]) outMin[2] = z; if (z > outMax[2]) outMax[2] = z;
    }
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
    // World matrix: cached for static nodes (computed once), else recomputed.
    let world: number[];
    if (node.isStatic && node.cw) {
      world = node.cw;
    } else {
      world = Mat4.multiply(parent, node.localMatrix());
      if (node.isStatic) node.cw = world;
    }
    // Frustum/distance cull (bounds encompass the node's subtree by convention).
    // Static nodes cache their world AABB; only the (cheap) plane test runs/frame.
    if (node.bounds && this.frustum) {
      let wmin: number[];
      let wmax: number[];
      if (node.isStatic && node.cwMin) {
        wmin = node.cwMin;
        wmax = node.cwMax!;
      } else {
        wmin = [0, 0, 0];
        wmax = [0, 0, 0];
        this.worldAABB(node.bounds, world, wmin, wmax);
        if (node.isStatic) {
          node.cwMin = wmin;
          node.cwMax = wmax;
        }
      }
      if (aabbCulled(this.frustum, wmin, wmax)) {
        this.culledCount++;
        return;
      }
    }
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

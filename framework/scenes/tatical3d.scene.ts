// Data-driven arena for tatical3d ("Tactical 3D"). The floor is a subdivided
// plane, and every box is its OWN Mesh (inline `box` geometry, one upload per
// node) — tatical3d has ~18 boxes of DIFFERENT sizes plus 8 crates, each
// hand-built with its own mesh. Large arena boxes request face subdivision so
// PSP/PPSSPP does not drop a large triangle that straddles the camera/near plane.
// Add order stays identical to buildArena():
//   1. floor plane (no collider)
//   2. 4 perimeter walls
//   3. 7 cover walls
//   4. 3 crate GROUPS (each crate its own node, ROTATED -> carries a precomputed
//      16-float local matrix so the bake->loadScene round trip stays byte-exact)
//   5. 4 metal/target boxes
// The soldier actor is NOT in the descriptor: tatical3d adds it AFTER loadScene
// (it must stay dynamic + keep the live node reference).
//
// Colliders are the EXACT blocker AABBs buildArena() pushed, IN ORDER: walls/cover
// (x±w/2, z±d/2), then the 8 crates (sx±0.7, sz±0.7), then the 4 metal/target
// boxes. The floor pushed no blocker, so it has no collider. The game harvests
// these into its blockers[] ({minX,maxX,minZ,maxZ}).
import type { SceneDescriptor, EntityDesc, AABBDesc } from '../src/scene-desc';
import { rgb } from '../src/color';
import { Mat4, Quat, Vec3 } from '../src/math';

const WALL = [rgb(104, 109, 111), rgb(82, 87, 90), rgb(138, 142, 140), rgb(55, 58, 60), rgb(92, 96, 98), rgb(72, 76, 78)];
const FLOOR = [rgb(74, 74, 70), rgb(64, 64, 61), rgb(94, 91, 82), rgb(48, 48, 46), rgb(78, 76, 70), rgb(58, 58, 55)];
const CRATE = [rgb(132, 98, 55), rgb(98, 70, 42), rgb(155, 121, 72), rgb(82, 57, 36), rgb(120, 86, 48), rgb(94, 65, 39)];
const METAL = [rgb(86, 100, 112), rgb(63, 75, 86), rgb(118, 130, 138), rgb(43, 49, 54), rgb(76, 88, 98), rgb(56, 65, 72)];
const TARGET = [rgb(168, 62, 45), rgb(114, 45, 38), rgb(205, 96, 60), rgb(70, 32, 29), rgb(148, 55, 44), rgb(96, 38, 34)];

const entities: EntityDesc[] = [];
const colliders: AABBDesc[] = [];
const FLOOR_CELL = 0.5;
const WALL_CELL = 0.5;

// addBox(x,y,z, w,h,d, colors, solid=true): one inline-box entity (translation-only,
// already byte-exact via the f32 xforms blob), plus a collider unless solid=false.
function addBox(
  x: number, y: number, z: number,
  w: number, h: number, d: number,
  colors: number[], solid = true, cell?: number,
): void {
  entities.push({
    box: { size: [w, h, d], colors, ...(cell !== undefined ? { cell } : {}) },
    position: [x, y, z],
    bounds: { min: [-w / 2, -h / 2, -d / 2], max: [w / 2, h / 2, d / 2] },
    isStatic: true,
  });
  if (solid) {
    colliders.push({ min: [x - w / 2, y, z - d / 2], max: [x + w / 2, y, z + d / 2] });
  }
}

// addCrates(x,y,z, yaw, count): `count` rotated crate boxes. Each crate is ROTATED
// (Quat.fromEuler(0, yaw+i*0.2, 0)), so it carries a precomputed local matrix =
// the inline f64 Mat4.compose — bit-identical through the f32 round trip. The
// collider is sx±0.7 / sz±0.7 (note: y bounds are 0 here, exactly as buildArena()
// pushed {minX,maxX,minZ,maxZ} with no y term).
function addCrates(x: number, y: number, z: number, yaw: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const sx = x + (i % 2) * 1.15;
    const sz = z + ((i / 2) | 0) * 1.05;
    const pos = new Vec3(sx, y + (i === 2 ? 0.55 : 0), sz);
    const rot = Quat.fromEuler(0, yaw + i * 0.2, 0);
    const matrix = Mat4.compose(pos, rot, new Vec3(1, 1, 1));
    entities.push({
      box: { size: [1.05, 1.1, 1.05], colors: CRATE },
      matrix,
      bounds: { min: [-0.75, -0.65, -0.75], max: [0.75, 0.65, 0.75] },
      isStatic: true,
    });
    colliders.push({ min: [sx - 0.7, 0, sz - 0.7], max: [sx + 0.7, 0, sz + 0.7] });
  }
}

// --- buildArena(), verbatim add order ---------------------------------------
entities.push({
  proto: 'floor',
  position: [0, 0, 0],
  bounds: { min: [-19, 0, -19], max: [19, 0, 19] },
  isStatic: true,
});
addBox(0, 1.55, -18.6, 38.8, 3.1, 0.85, WALL, true, WALL_CELL);
addBox(0, 1.55, 18.6, 38.8, 3.1, 0.85, WALL, true, WALL_CELL);
addBox(-18.6, 1.55, 0, 0.85, 3.1, 38.8, WALL, true, WALL_CELL);
addBox(18.6, 1.55, 0, 0.85, 3.1, 38.8, WALL, true, WALL_CELL);

addBox(-10.8, 1.25, -5.8, 14.8, 2.5, 0.7, WALL, true, WALL_CELL);
addBox(9.8, 1.25, -5.8, 12.8, 2.5, 0.7, WALL, true, WALL_CELL);
addBox(-6.2, 1.25, 7.0, 0.7, 2.5, 16.0, WALL, true, WALL_CELL);
addBox(7.2, 1.25, 5.8, 0.7, 2.5, 13.6, WALL, true, WALL_CELL);
addBox(0.5, 1.25, 7.8, 6.7, 2.5, 0.7, WALL, true, WALL_CELL);
addBox(-12.5, 1.25, 3.2, 5.0, 2.5, 0.7, WALL, true, WALL_CELL);
addBox(13.4, 1.25, -0.8, 0.7, 2.5, 8.6, WALL, true, WALL_CELL);

addCrates(-2.4, 0.55, 1.1, 0.15, 3);
addCrates(11.8, 0.55, 10.4, -0.45, 3);
addCrates(-13.6, 0.55, -12.0, 0.65, 2);
addBox(2.7, 0.75, -12.4, 3.4, 1.5, 1.2, METAL);
addBox(5.8, 0.55, -12.1, 1.2, 1.1, 1.2, TARGET);
addBox(14.2, 0.75, 4.8, 1.5, 1.5, 3.5, METAL);
addBox(-9.8, 0.35, 13.4, 4.2, 0.7, 1.2, TARGET);

export const tatical3dScene: SceneDescriptor = {
  camera: { fovDeg: 62, aspect: 480 / 272, near: 0.01, far: 92 },
  fog: { color: rgb(27, 31, 34), near: 34, far: 62 },
  prototypes: {
    floor: { kind: 'plane', size: [38, 38], color: FLOOR[2], cell: FLOOR_CELL },
  },
  entities,
  colliders,
};

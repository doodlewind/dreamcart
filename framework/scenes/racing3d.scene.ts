// Data-driven scene for racing3d, byte-exact with the game's original onEnter.
// Add order (must stay identical for the .dc3d golden):
//   1. ground plane         600x600  @ (0,0,0)
//   2. road strip box       10 x 0.05 x 600 @ (0, 0.02, -260)
//   3. 22*2 cones (ONE shared cone mesh) @ (-5/+5, 0.7, -i*14-8), i = 0..21
// The car (a single dynamic box, moved every frame) is NOT part of the descriptor:
// the game adds it AFTER loadScene so it keeps the live node reference AND so the
// add order stays ground, road, cones..., car — exactly the original onEnter.
//
// The cone group is NOT merged: racing3d keeps each cone its own node so the single
// cone prototype is uploaded once and drawn at 44 model matrices (the scaling proof).
import type { SceneDescriptor } from '../src/scene-desc';
import { rgb } from '../src/color';

const solid = (c: number): number[] => [c, c, c, c, c, c];

const CONE_SPACING = 14;
const CONE_COUNT = 22;
const LANE = 5;

const conePositions: [number, number, number][] = [];
for (let i = 0; i < CONE_COUNT; i++) {
  const z = -i * CONE_SPACING - 8;
  conePositions.push([-LANE, 0.7, z]); // left, then right — same order as the loop
  conePositions.push([LANE, 0.7, z]);
}

export const racing3dScene: SceneDescriptor = {
  camera: { fovDeg: 62, aspect: 480 / 272, near: 0.1, far: 300 },
  prototypes: {
    ground: { kind: 'plane', size: [600, 600], color: rgb(46, 78, 46) },
    road: { kind: 'box', size: [10, 0.05, 600], colors: solid(rgb(54, 54, 60)) },
    cone: { kind: 'box', size: [0.7, 1.4, 0.7], colors: solid(rgb(230, 120, 40)) },
  },
  entities: [
    { proto: 'ground', position: [0, 0, 0] },
    { proto: 'road', position: [0, 0.02, -260] },
  ],
  instances: [
    { proto: 'cone', positions: conePositions }, // 44 nodes, one shared cone mesh
  ],
};

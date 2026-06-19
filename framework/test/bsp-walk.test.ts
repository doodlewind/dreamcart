// E2E Stage 4 — WALKABILITY. Drives the SHARED deterministic walker (bsp-walk.ts,
// the exact logic bsp3d.js uses) over the baked box room and asserts the player can
// actually walk it: it MOVES, stays IN BOUNDS, and COLLISION stops it at a wall
// (doesn't pass through). A committed trajectory golden catches any physics drift.
// Run: bun framework/test/bsp-walk.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { walkStep, RADIUS } from '../src/bsp-walk';
import { BSP_BOX as BSP } from '../src/assets-bsp-box';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log('FAIL:', msg); } };

const aabbs = new Float32Array(BSP.solidAABBs.buffer, BSP.solidAABBs.byteOffset, BSP.solidAABBs.byteLength >> 2);
const span = BSP.span - 0.5;
const DT = 1 / 60;

// Room interior half-extent from the wall rects (innermost wall faces).
let roomHalf = 0;
for (let i = 0; i + 3 < aabbs.length; i += 4) roomHalf = Math.max(roomHalf, Math.abs(aabbs[i]), Math.abs(aabbs[i + 2]), Math.abs(aabbs[i + 1]), Math.abs(aabbs[i + 3]));
ok(aabbs.length >= 4, 'map has wall collision rects');
ok(roomHalf > 0.5, `room has a sensible extent (${roomHalf.toFixed(2)} m)`);

// --- (1) MOVES + (2) IN BOUNDS: forward (camera-relative iz=1, camYaw=0) ---
let st = { x: BSP.spawn[0], z: BSP.spawn[1], heading: BSP.spawn[2] };
const start = { x: st.x, z: st.z };
let inBounds = true;
for (let f = 0; f < 40; f++) {
  walkStep(st, aabbs, span, 0, 1, false, 0, DT);
  if (Math.abs(st.x) > span + 1e-3 || Math.abs(st.z) > span + 1e-3) inBounds = false;
}
const moved = Math.hypot(st.x - start.x, st.z - start.z);
ok(moved > 1, `soldier moved off the spawn (${moved.toFixed(2)} m)`);
ok(inBounds, 'stayed within the map span every frame');

// --- (3) COLLISION: run straight into the +Z wall, assert it STOPS, never penetrates ---
st = { x: 0, z: 0, heading: 0 };
let maxZ = 0, penetrated = false;
for (let f = 0; f < 240; f++) {
  walkStep(st, aabbs, span, 0, 1, true, 0, DT); // run forward
  maxZ = Math.max(maxZ, st.z);
  // a point at the soldier's centre must never end up INSIDE a wall rect
  for (let i = 0; i + 3 < aabbs.length; i += 4) {
    if (st.x > aabbs[i] && st.x < aabbs[i + 2] && st.z > aabbs[i + 1] && st.z < aabbs[i + 3]) penetrated = true;
  }
}
ok(maxZ > 1, `reached the far wall (z=${maxZ.toFixed(2)})`);
ok(maxZ <= roomHalf + 1e-3, `stopped at the wall, no pass-through (maxZ ${maxZ.toFixed(2)} <= roomHalf ${roomHalf.toFixed(2)})`);
ok(!penetrated, 'soldier centre never entered a wall rect');
// after hitting the wall it should have settled (last few frames barely move)
const settledZ = st.z;
walkStep(st, aabbs, span, 0, 1, true, 0, DT);
ok(Math.abs(st.z - settledZ) < 0.02, 'pinned against the wall (no creep through)');

// --- (4) TRAJECTORY GOLDEN: a scripted walk; serialize (x,z,heading) per frame ---
// forward 40 · forward+strafe 30 · turn(camYaw)+forward 60
const SCRIPT: [number, number, number][] = []; // [ix, iz, camYaw]
for (let f = 0; f < 40; f++) SCRIPT.push([0, 1, 0]);
for (let f = 0; f < 30; f++) SCRIPT.push([1, 1, 0]);
for (let f = 0; f < 60; f++) SCRIPT.push([0, 1, 0.9]);
const traj: number[] = [];
const w = { x: BSP.spawn[0], z: BSP.spawn[1], heading: BSP.spawn[2] };
for (const [ix, iz, cam] of SCRIPT) {
  walkStep(w, aabbs, span, ix, iz, false, cam, DT);
  traj.push(Math.round(w.x * 1e4) / 1e4, Math.round(w.z * 1e4) / 1e4, Math.round(w.heading * 1e4) / 1e4);
}
const goldenPath = new URL('goldens/bsp3d.walk.json', import.meta.url).pathname;
const UPDATE = !!process.env.UPDATE;
if (UPDATE || !existsSync(goldenPath)) {
  writeFileSync(goldenPath, JSON.stringify(traj));
  console.log(UPDATE ? 'WROTE bsp3d.walk.json' : 'NEW   bsp3d.walk.json');
  pass++;
} else {
  const gold = JSON.parse(readFileSync(goldenPath, 'utf8'));
  ok(gold.length === traj.length && gold.every((v: number, i: number) => v === traj[i]), 'trajectory matches the committed walk golden (no physics drift)');
}

console.log(`\nbsp-walk: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

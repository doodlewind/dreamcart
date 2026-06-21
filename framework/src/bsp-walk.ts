// Shared, deterministic walk + AABB collision for the BSP map walker. Used by both
// the game (bsp3d.js) and the walkability E2E (bsp-walk.test.ts) so they exercise the
// SAME physics. Uses only math.ts trig (dsin/dcos/datan2) + arithmetic — never
// Math.sin/cos — so the bytes the game feeds the golden are host-stable.
import { dsin, dcos, datan2, TWO_PI } from './math';

export interface WalkState {
  x: number;
  z: number;
  y: number; // floor-tracked height the model stands on (metres, engine-Y)
  heading: number; // model facing; forward = (dsin h, dcos h)
}

export const WALK_SPEED = 2.4;
export const RUN_SPEED = 4.8;
export const RADIUS = 0.45; // collision radius (metres)
export const TURN_RATE = 14; // how fast the model pivots toward the move direction (rad/s factor)
export const STEP_UP = 1.3; // max height the player can step up onto in one go (metres)

/**
 * Floor-height under (x,z): the HIGHEST floor span containing the point that is no more
 * than STEP_UP above `curY` (so you stand on the level you're on / can step up to, and
 * ceilings + higher ledges + lower levels under a bridge are skipped). `spans` is
 * [minX,minZ,maxX,maxZ,y] × N. Falls back to `fallback` when no span covers the point.
 */
export function floorAt(spans: Float32Array, x: number, z: number, curY: number, fallback: number): number {
  let best = -Infinity;
  const reach = curY + STEP_UP;
  for (let i = 0; i + 4 < spans.length; i += 5) {
    if (x >= spans[i] && x <= spans[i + 2] && z >= spans[i + 1] && z <= spans[i + 3]) {
      const y = spans[i + 4];
      if (y <= reach && y > best) best = y;
    }
  }
  return best > -Infinity ? best : fallback;
}

/** Ease angle `a` toward `b` by fraction `t` the short way round the circle. */
export function turnToward(a: number, b: number, t: number): number {
  let d = b - a;
  d -= TWO_PI * Math.round(d / TWO_PI);
  return a + d * (t < 1 ? t : 1);
}

/** True if a circle of `RADIUS` at (nx,nz) overlaps any wall rect [minX,minZ,maxX,maxZ]. */
export function blocked(aabbs: Float32Array, nx: number, nz: number): boolean {
  const r = RADIUS;
  for (let i = 0; i + 3 < aabbs.length; i += 4) {
    if (nx + r > aabbs[i] && nx - r < aabbs[i + 2] && nz + r > aabbs[i + 1] && nz - r < aabbs[i + 3]) return true;
  }
  return false;
}

/** Axis-separated move (slide along walls), clamped to the map span. */
export function moveTo(st: WalkState, aabbs: Float32Array, span: number, nx: number, nz: number): void {
  const lim = span;
  if (nx > lim) nx = lim; else if (nx < -lim) nx = -lim;
  if (nz > lim) nz = lim; else if (nz < -lim) nz = -lim;
  if (!blocked(aabbs, nx, st.z)) st.x = nx;
  if (!blocked(aabbs, st.x, nz)) st.z = nz;
}

/**
 * One camera-relative movement step. `ix` = strafe (-1/0/1), `iz` = forward
 * (-1/0/1) in CAMERA space (`camYaw`); the model turns to face the move direction.
 * Mutates `st`; returns whether it moved (for clip/animation selection).
 */
export function walkStep(
  st: WalkState, aabbs: Float32Array, span: number,
  ix: number, iz: number, run: boolean, camYaw: number, dt: number,
): boolean {
  const moving = ix !== 0 || iz !== 0;
  if (!moving) return false;
  const camFx = dsin(camYaw);
  const camFz = dcos(camYaw);
  // world move = forward*iz + cameraRight*ix (cameraRight = forward rotated -90°)
  const mx = camFx * iz + camFz * ix;
  const mz = camFz * iz - camFx * ix;
  const inv = 1 / Math.sqrt(mx * mx + mz * mz);
  // Turn the model toward the move direction, THEN walk: the gait speed ramps with how
  // well we already face it, so a big direction change pivots in place first.
  st.heading = turnToward(st.heading, datan2(mx, mz), TURN_RATE * dt);
  const align = (dsin(st.heading) * mx + dcos(st.heading) * mz) * inv; // cos(angle to move dir)
  const gait = align <= 0.1 ? 0 : align >= 0.7 ? 1 : (align - 0.1) / 0.6;
  if (gait > 0) {
    const speed = (run ? RUN_SPEED : WALK_SPEED) * gait;
    moveTo(st, aabbs, span, st.x + mx * inv * speed * dt, st.z + mz * inv * speed * dt);
  }
  return true;
}

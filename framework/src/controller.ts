// Shared character controller, camera rig and collision helpers — the reusable
// core the 3D games used to each reinvent (heading/speed integration, chase/fps/
// freefly cameras, AABB blocking, hitscan). A game supplies a MoveConfig + a
// CamRig and per-frame InputSample; kinematicStep advances a KinematicState and
// camApply positions the camera. All math is dsin/dcos (deterministic) and in the
// same operation order the hand-written games used, so migrating a game is a pure
// refactor that keeps its golden byte-identical.
import { Vec3, dsin, dcos } from './math';
import type { Camera } from './scene3d';

export interface KinematicState {
  x: number; y: number; z: number;
  heading: number; pitch: number; speed: number;
  fwdX: number; fwdZ: number;
}
export function newState(x = 0, y = 0, z = 0, heading = 0): KinematicState {
  return { x, y, z, heading, pitch: 0, speed: 0, fwdX: 0, fwdZ: 1 };
}

export interface MoveConfig {
  // Omitted when alwaysForward drives speed (freefly/outdoor).
  speed?: 'continuous' | 'gated';
  // continuous (car/racing): integrate speed by accel/decel up to maxSpeed.
  accel?: number; decel?: number; maxSpeed?: number;
  // gated (walk): pick walk/run/back speed directly from throttle sign.
  walkSpeed?: number; runSpeed?: number; backSpeed?: number;
  // outdoor base drift; throttle>0 doubles it (boost). Overrides speed mode.
  alwaysForward?: number;
  turnRate?: number;            // rad/s direct turn (steer * turnRate * dt)
  steerScalesWithSpeed?: number; // bicycle steer (authority ~ speed); 0 = direct
  steerSpeedCap?: number;        // cap on speed used for steer authority (default 10)
  pitchRate?: number;            // freefly pitch rad/s; 0 = none
  fwdSignZ: 1 | -1;              // local forward Z sign: walk/adv/outdoor +1; car/racing/fps -1
}

/**
 * Advance one fixed step. throttle/steer/pitch are -1..1, run gates run-speed.
 * Mirrors the per-game math exactly: heading += steer*authority*dt, then
 * fwd = (dsin(h), fwdSignZ*dcos(h)), then x/z += fwd*speed*dt (no clamp — use
 * Collide.clampBox/slideAabb afterward, matching the games' separate clamp step).
 */
export function kinematicStep(
  s: KinematicState, throttle: number, steer: number, pitch: number,
  run: boolean, cfg: MoveConfig, dt: number,
): void {
  if (cfg.alwaysForward != null) {
    s.speed = throttle > 0 ? cfg.alwaysForward * 2 : cfg.alwaysForward;
  } else if (cfg.speed === 'continuous') {
    if (throttle > 0) s.speed += cfg.accel! * dt;
    else s.speed -= cfg.decel! * dt;
    s.speed = s.speed < 0 ? 0 : s.speed > cfg.maxSpeed! ? cfg.maxSpeed! : s.speed;
  } else {
    s.speed = throttle > 0 ? (run ? cfg.runSpeed! : cfg.walkSpeed!)
      : throttle < 0 ? -(cfg.backSpeed ?? 0) : 0;
  }
  const auth = cfg.steerScalesWithSpeed
    ? Math.min(Math.abs(s.speed), cfg.steerSpeedCap ?? 10) * cfg.steerScalesWithSpeed
    : (cfg.turnRate ?? 0);
  s.heading += steer * auth * dt;
  if (cfg.pitchRate) s.pitch += pitch * cfg.pitchRate * dt;
  s.fwdX = dsin(s.heading);
  s.fwdZ = cfg.fwdSignZ * dcos(s.heading);
  s.x += s.fwdX * s.speed * dt;
  s.z += s.fwdZ * s.speed * dt;
}

export interface Box { minX: number; maxX: number; minZ: number; maxZ: number; }

export const Collide = {
  clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; },
  /** Clamp position into an axis-aligned bound (X then Z, the games' order). */
  clampBox(s: KinematicState, minX: number, maxX: number, minZ: number, maxZ: number): void {
    s.x = Collide.clamp(s.x, minX, maxX);
    s.z = Collide.clamp(s.z, minZ, maxZ);
  },
  /** Block movement into boxes by reverting X then Z from the prior position. */
  slideAabb(s: KinematicState, px: number, pz: number, r: number, boxes: Box[]): void {
    const free = (nx: number, nz: number): boolean => {
      for (const b of boxes) if (nx + r > b.minX && nx - r < b.maxX && nz + r > b.minZ && nz - r < b.maxZ) return false;
      return true;
    };
    if (!free(s.x, pz)) s.x = px;
    if (!free(s.x, s.z)) s.z = pz;
  },
  /** Ray vs AABB; returns hit distance along (dx,dy,dz) or -1 (from fps3d). */
  rayAabb(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    cx: number, cy: number, cz: number, hx: number, hy: number, hz: number,
  ): number {
    let tmin = -Infinity, tmax = Infinity;
    const slab = (o: number, d: number, c: number, h: number): boolean => {
      if (Math.abs(d) < 1e-9) return o >= c - h && o <= c + h;
      let t1 = (c - h - o) / d, t2 = (c + h - o) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      return true;
    };
    if (!slab(ox, dx, cx, hx) || !slab(oy, dy, cy, hy) || !slab(oz, dz, cz, hz)) return -1;
    if (tmax < tmin || tmax < 0) return -1;
    return tmin > 0 ? tmin : tmax;
  },
};

export type CamMode = 'chase' | 'fps' | 'freefly';
export interface CamRig {
  mode: CamMode;
  // chase: distance behind + ABSOLUTE eye/look heights (NOT focusY+height — each
  // game's eye/look Y are independent constants, e.g. racing eyeY 3.2 lookY 0.9).
  dist?: number; lookahead?: number; eyeY?: number; lookY?: number;
  focusLocalX?: number; focusLocalZ?: number; // chase focus offset in the body's rotated local frame
  eyeHeight?: number; // fps
}
const UP = new Vec3(0, 1, 0);

/** Position `cam` for this rig + state, writing into the scratch eye/center vecs. */
export function camApply(cam: Camera, rig: CamRig, s: KinematicState, eye: Vec3, center: Vec3): void {
  if (rig.mode === 'fps') {
    const h = rig.eyeHeight ?? 1.6;
    eye.set(s.x, h, s.z);
    center.set(s.x + s.fwdX, h, s.z + s.fwdZ);
  } else if (rig.mode === 'freefly') {
    eye.set(s.x, s.y, s.z);
    center.set(s.x + s.fwdX * 6, s.y + s.pitch * 6, s.z + s.fwdZ * 6);
  } else {
    const lcx = rig.focusLocalX ?? 0, lcz = rig.focusLocalZ ?? 0;
    const ccx = s.x + lcx * s.fwdZ + lcz * s.fwdX;
    const ccz = s.z - lcx * s.fwdX + lcz * s.fwdZ;
    const d = rig.dist ?? 7, la = rig.lookahead ?? 6;
    eye.set(ccx - s.fwdX * d, rig.eyeY ?? 3.2, ccz - s.fwdZ * d);
    center.set(ccx + s.fwdX * la, rig.lookY ?? 0.9, ccz + s.fwdZ * la);
  }
  cam.lookAt(eye, center, UP);
}

export interface InputSample { throttle: number; steer: number; pitch: number; run: boolean; }

/** Bundles a state + config + rig with reusable camera scratch vectors. Games
 *  build their own per-frame InputSample (throttle/steer/pitch/run) — usually via
 *  an ActionMap (framework/src/action.ts) — and pass it to step(). */
export class CharController {
  s: KinematicState;
  private _eye = new Vec3();
  private _center = new Vec3();
  constructor(public cfg: MoveConfig, public rig: CamRig, start?: Partial<KinematicState>) {
    this.s = Object.assign(newState(), start);
  }
  step(sm: InputSample, dt: number): void {
    kinematicStep(this.s, sm.throttle, sm.steer, sm.pitch, sm.run, this.cfg, dt);
  }
  applyCam(cam: Camera): void {
    camApply(cam, this.rig, this.s, this._eye, this._center);
  }
}

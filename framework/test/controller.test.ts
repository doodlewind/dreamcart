// Unit tests for the shared controller + the analog input contract.
//   bun framework/test/controller.test.ts
// The PRIMARY zero-regression gate is still golden.ts (the migrated games stay
// byte-identical); these cover the pieces goldens can't reach: the analog
// pack/unpack round-trip (mirrors runtime/src/main.rs), kinematicStep numerics,
// and the Collide helpers.
import { Input, Btn } from "../src/input";
import { newState, kinematicStep, Collide, type MoveConfig } from "../src/controller";

let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) console.log("PASS ", msg);
  else { console.log("FAIL ", msg); fail++; }
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

// Mirror runtime/src/main.rs: pack lx/ly (0..255, centre 128) into the high 16
// bits of the frame() word alongside the digital buttons in the low 16.
function pack(buttons: number, lx: number, ly: number): number {
  const bx = Math.max(-127, Math.min(127, lx - 128));
  const by = Math.max(-127, Math.min(127, ly - 128));
  return (buttons & 0xffff) | ((bx & 0xff) << 16) | ((by & 0xff) << 24);
}

// (a) analog pack/unpack round-trip
{
  const inp = new Input();
  inp.update(pack(0, 255, 128));
  ok(near(inp.analogX, 127 / 127, 1e-6) && inp.analogX > 0.99, "lx=255 -> analogX ~ +1");
  ok(inp.analogY === 0, "ly=128 -> analogY 0 (deadzone)");

  inp.update(pack(0, 0, 0));
  ok(inp.analogX < -0.99, "lx=0 -> analogX ~ -1 (signed, no sign-extend bug)");
  ok(inp.analogY < -0.99, "ly=0 -> analogY ~ -1");

  inp.update(pack(0, 128, 128));
  ok(inp.analogX === 0 && inp.analogY === 0, "lx=ly=128 -> 0 after deadzone");

  // small nudge inside the deadzone is squelched; buttons unaffected by analog
  inp.update(pack(Btn.Square, 135, 128));
  ok(inp.held(Btn.Square), "Square (0x8000) survives in the low 16 bits with analog packed");
  ok(inp.analogX === 0, "small lx nudge (135) inside deadzone -> 0");

  // a real steer past the deadzone
  inp.update(pack(Btn.Square, 220, 128));
  ok(inp.analogX > 0.5 && inp.held(Btn.Square), "lx=220 -> analogX>0.5 AND Square still held");

  // axis() falls back to the d-pad when there is no analog (digital-only host)
  inp.update(Btn.Left);
  ok(inp.axis().x === -1 && inp.analogX === 0, "no analog -> axis() falls back to dir() (Left = -1)");
}

// (b) kinematicStep numerics
{
  const dt = 1 / 60;
  // continuous accel + clamp at maxSpeed
  const cont: MoveConfig = { speed: "continuous", accel: 10, decel: 20, maxSpeed: 5, fwdSignZ: -1 };
  const s = newState();
  for (let i = 0; i < 600; i++) kinematicStep(s, 1, 0, 0, false, cont, dt);
  ok(near(s.speed, 5), "continuous accel clamps at maxSpeed");
  for (let i = 0; i < 600; i++) kinematicStep(s, -1, 0, 0, false, cont, dt);
  ok(s.speed === 0, "continuous decel clamps at 0 (no negative)");

  // gated walk/run/back selection
  const gated: MoveConfig = { speed: "gated", walkSpeed: 2, runSpeed: 4.5, backSpeed: 1, fwdSignZ: 1 };
  const g = newState();
  kinematicStep(g, 1, 0, 0, false, gated, dt); ok(g.speed === 2, "gated throttle>0 -> walkSpeed");
  kinematicStep(g, 1, 0, 0, true, gated, dt); ok(g.speed === 4.5, "gated run -> runSpeed");
  kinematicStep(g, -1, 0, 0, false, gated, dt); ok(g.speed === -1, "gated throttle<0 -> -backSpeed");
  kinematicStep(g, 0, 0, 0, false, gated, dt); ok(g.speed === 0, "gated throttle 0 -> stop");

  // bicycle steer authority scales with speed
  const bike: MoveConfig = { speed: "continuous", accel: 10, decel: 10, maxSpeed: 20, steerScalesWithSpeed: 0.12, steerSpeedCap: 10, fwdSignZ: -1 };
  const slow = newState(); slow.speed = 1;
  const fast = newState(); fast.speed = 8;
  const h0s = slow.heading, h0f = fast.heading;
  kinematicStep(slow, 0, 1, 0, false, bike, dt);
  kinematicStep(fast, 0, 1, 0, false, bike, dt);
  ok((fast.heading - h0f) > (slow.heading - h0s), "bicycle: steer authority grows with speed");

  // fwdSignZ flips forward Z
  const a = newState(); const b = newState();
  kinematicStep(a, 0, 0, 0, false, { speed: "gated", walkSpeed: 1, fwdSignZ: 1 }, dt);
  kinematicStep(b, 0, 0, 0, false, { speed: "gated", walkSpeed: 1, fwdSignZ: -1 }, dt);
  ok(near(a.fwdZ, -b.fwdZ), "fwdSignZ +1 vs -1 yields opposite fwdZ");
}

// (c) Collide
{
  const s = newState(); s.x = 10; s.z = 10;
  Collide.clampBox(s, -5, 5, -5, 5);
  ok(s.x === 5 && s.z === 5, "clampBox clamps X and Z");

  // slideAabb: head-on into a box ahead reverts Z (forward) but not X.
  const ahead = [{ minX: -1, maxX: 1, minZ: 1, maxZ: 3 }];
  const m = newState(); m.x = 0; m.z = 1.5; // moved forward into the box
  Collide.slideAabb(m, 0, 0, 0.1, ahead); // prior (0,0) was free
  ok(m.x === 0 && m.z === 0, "slideAabb reverts a head-on forward move");

  // slideAabb: pushed into a wall on the right while moving forward -> slide
  // (X reverted into the wall, Z kept).
  const wall = [{ minX: 1, maxX: 3, minZ: -5, maxZ: 5 }];
  const w = newState(); w.x = 1.5; w.z = 2; // moved right (into wall) + forward
  Collide.slideAabb(w, 0, 0, 0.1, wall); // prior (0,0) was free
  ok(w.x === 0 && w.z === 2, "slideAabb slides along a wall (revert X, keep Z)");

  // rayAabb hits a box straight ahead, misses to the side
  const hit = Collide.rayAabb(0, 0, 0, 0, 0, 1, 0, 0, 5, 1, 1, 1);
  ok(hit > 0 && near(hit, 4, 1e-6), "rayAabb forward hit distance ~4");
  const miss = Collide.rayAabb(0, 0, 0, 0, 0, 1, 10, 0, 5, 1, 1, 1);
  ok(miss === -1, "rayAabb misses a box off to the side");
}

console.log(`\n${fail === 0 ? "OK" : fail + " FAILED"}`);
process.exit(fail ? 1 : 0);

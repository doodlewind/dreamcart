// Unit tests for the ActionMap subsystem (framework/src/action.ts).
//   bun framework/test/action.test.ts
// Goldens (golden.ts) prove racing3d stays byte-identical on the DIGITAL path
// after the ActionMap migration; these cover what goldens can't reach: the
// digital-vs-analog fallback semantics of axis(), held/pressed across multiple
// bound buttons, live rebinding, and — the headline — that a real analog stick
// value flows through ActionMap into the SAME steering math the game uses, so
// the heading delta scales with the stick (analog actually reaches steering).
import { Input, Btn } from "../src/input";
import { ActionMap } from "../src/action";
import { newState, kinematicStep, type MoveConfig } from "../src/controller";

let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) console.log("PASS ", msg);
  else { console.log("FAIL ", msg); fail++; }
}
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

// Mirror runtime/src/main.rs (and controller.test.ts): pack lx/ly (0..255,
// centre 128) into the high 16 bits alongside the digital buttons in the low 16.
function pack(buttons: number, lx: number, ly: number): number {
  const bx = Math.max(-127, Math.min(127, lx - 128));
  const by = Math.max(-127, Math.min(127, ly - 128));
  return (buttons & 0xffff) | ((bx & 0xff) << 16) | ((by & 0xff) << 24);
}

// racing3d's exact action config.
const CFG = {
  ACCEL: { buttons: [Btn.Cross] },
  STEER: { axis: "lx" as const, axisButtons: [Btn.Left, Btn.Right] as [number, number] },
  RESET: { buttons: [Btn.Start] },
};

// (a) held / pressed across bound buttons
{
  const inp = new Input();
  const map = new ActionMap(inp, {
    JUMP: { buttons: [Btn.Cross, Btn.Circle] }, // multi-button OR
    PAUSE: { buttons: [Btn.Start] },
  });
  inp.update(Btn.Circle);
  ok(map.held("JUMP"), "held() true when ANY bound button down (Circle of [Cross,Circle])");
  ok(map.pressed("JUMP"), "pressed() true on the frame Circle goes down");
  inp.update(Btn.Circle);
  ok(map.held("JUMP") && !map.pressed("JUMP"), "pressed() false while still held");
  inp.update(0);
  ok(!map.held("JUMP"), "held() false when released");
  let threw = false;
  try { map.held("NOPE"); } catch { threw = true; }
  ok(threw, "unknown action throws");
}

// (b) axis(): analog past deadzone, else the digital axisButtons pair —
//     byte-identical to the old inp.axis().x that racing3d used.
{
  const inp = new Input();
  const map = new ActionMap(inp, CFG);

  inp.update(Btn.Left);
  ok(map.axis("STEER") === -1, "digital Left -> STEER -1 (== old inp.axis().x)");
  inp.update(Btn.Right);
  ok(map.axis("STEER") === 1, "digital Right -> STEER +1");
  inp.update(Btn.Left | Btn.Right);
  ok(map.axis("STEER") === 0, "Left+Right cancel -> 0");
  inp.update(0);
  ok(map.axis("STEER") === 0, "nothing -> 0");

  // analog overrides the digital pair when active
  inp.update(pack(0, 255, 128));
  ok(near(map.axis("STEER"), 1, 1e-6), "analog lx=+full -> STEER ~ +1");
  inp.update(pack(Btn.Left, 255, 128));
  ok(near(map.axis("STEER"), 1, 1e-6), "analog active takes priority over the Left fallback");
  // inside the stick deadzone (Input.update squelches it) -> digital fallback
  inp.update(pack(Btn.Left, 135, 128));
  ok(map.axis("STEER") === -1, "lx inside deadzone -> falls back to Left (-1)");

  // invert
  const inv = new ActionMap(inp, { S: { axis: "lx", axisButtons: [Btn.Left, Btn.Right], invert: true } });
  inp.update(Btn.Right);
  ok(inv.axis("S") === -1, "invert flips the digital pair");
  inp.update(pack(0, 255, 128));
  ok(near(inv.axis("S"), -1, 1e-6), "invert flips the analog value");
}

// (c) zero-code rebind: mutate the config, behavior follows with no new code.
{
  const inp = new Input();
  const cfg = { RESET: { buttons: [Btn.Start] } };
  const map = new ActionMap(inp, cfg);
  inp.update(Btn.Select);
  ok(!map.pressed("RESET"), "before rebind: SELECT does not trigger RESET");
  cfg.RESET.buttons = [Btn.Select]; // <- the one line a rebind costs
  // pressed needs an edge: prev had Select already, so cycle it off then on.
  inp.update(0);
  inp.update(Btn.Select);
  ok(map.pressed("RESET"), "after one-line rebind: SELECT now triggers RESET");
}

// (d) HEADLINE: analog reaches steering. Drive racing3d's exact steer math with
//     a full digital steer vs LX=+0.5 and assert the heading delta scales ~half.
//     This proves the analog stick value flows ActionMap.axis('STEER') -> the
//     same kinematicStep the game calls, not just the digital fallback.
{
  const dt = 1 / 60;
  // racing3d's MoveConfig (see framework/games/racing3d.js onEnter).
  const cfg: MoveConfig = {
    speed: "continuous", accel: 14, decel: 7, maxSpeed: 26,
    steerScalesWithSpeed: 0.12, steerSpeedCap: 10, fwdSignZ: -1,
  };
  const inp = new Input();
  const map = new ActionMap(inp, CFG);

  // One step of the game's update at a fixed speed, returning heading delta for
  // a given packed input word — exactly the call racing3d.update() makes.
  const headingDelta = (packed: number, startSpeed: number): number => {
    inp.update(packed);
    const s = newState();
    s.speed = startSpeed;
    const h0 = s.heading;
    kinematicStep(s, map.held("ACCEL") ? 1 : 0, map.axis("STEER"), 0, false, cfg, dt);
    return s.heading - h0;
  };

  const SPEED = 8; // under the steerSpeedCap of 10, so authority is linear in steer
  const full = headingDelta(Btn.Right, SPEED);        // digital full steer (+1)
  const half = headingDelta(pack(0, 192, 128), SPEED); // LX = (192-128)/127 ~ +0.504
  ok(full > 0, "digital full steer turns the heading");
  ok(half > 0 && half < full, "analog half steer turns LESS than full");
  // (192-128)/127 = 0.5039; heading delta is linear in steer, so ratio ~ that.
  const ratio = half / full;
  ok(near(ratio, 64 / 127, 1e-6), "analog LX=+0.5 yields ~half the digital steer delta (ratio " + ratio.toFixed(4) + ")");
}

console.log(`\n${fail === 0 ? "OK" : fail + " FAILED"}`);
process.exit(fail ? 1 : 0);

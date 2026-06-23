import { Graphics } from './graphics';
import { CommandEncoder } from './g3d';
import { hasG3d } from './host3d';
import { Input } from './input';
import { Rng } from './rng';
import { Scene } from './scene';
import type { Scene3D } from './scene3d';
import type { SoundBank } from './audio';

export interface UpdateContext {
  input: Input;
  rng: Rng;
  dt: number; // fixed timestep, seconds (1/60)
  t: number; // seconds since start
  frame: number;
  engine: Engine;
}

export interface EngineOpts {
  seed?: number;
}

// Owns the loop, input, rng, graphics and a scene stack. `run()` installs the
// host's globalThis.frame; every platform then drives it ~60Hz.
export class Engine {
  input = new Input();
  rng: Rng;
  g = new Graphics();
  frameCount = 0;
  /** Optional 3D scene; when set (and the host provides g3d) it is rendered
   * each frame BEFORE the 2D tree, so 2D draws form a HUD over the 3D pass. */
  scene3d?: Scene3D;
  /** Optional shared sound bank; when set, the engine flushes it once per frame
   * (after the 3D render, before/with the 2D HUD) so the game's play()/loop()
   * calls cross to the host in one batched FFI call. Settable like scene3d. */
  audio?: SoundBank;
  private enc?: CommandEncoder;
  private stack: Scene[] = [];

  constructor(opts: EngineOpts = {}) {
    this.rng = new Rng(opts.seed ?? 12345);
  }

  get scene(): Scene | undefined {
    return this.stack[this.stack.length - 1];
  }

  private ctx(): UpdateContext {
    return {
      input: this.input,
      rng: this.rng,
      dt: 1 / 60,
      t: this.frameCount / 60,
      frame: this.frameCount,
      engine: this,
    };
  }

  push(s: Scene): void {
    this.stack.push(s);
    s.onEnter(this.ctx());
  }
  pop(): void {
    const s = this.stack.pop();
    if (s) s.onExit();
  }
  replace(s: Scene): void {
    this.pop();
    this.push(s);
  }

  run(initial: Scene): void {
    this.stack = [initial];
    initial.onEnter(this.ctx());
    globalThis.frame = (mask: number) => this.tick(mask);
  }

  /**
   * Average µs/frame for [updateTree, 3D render, 2D draw], smoothed over ~1 s.
   * Populated only on hosts exposing `now()` (PSP); a game can render it to
   * profile on-device (the 3D clear erases the dprintln overlay, so it must be
   * drawn as 2D). Zeroes elsewhere — costs nothing without `now()`.
   */
  prof = [0, 0, 0];
  private _pAcc = [0, 0, 0];
  private _pN = 0;

  /** Advance one frame. Public so the golden-test harness can drive it directly. */
  tick(mask: number): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nowF = (globalThis as any).now as undefined | (() => number);
    this.input.update(mask);
    this.frameCount++;
    const ctx = this.ctx();
    const sc = this.scene;
    if (sc) {
      const ta = nowF ? nowF() : 0;
      sc.updateTree(ctx);
      const tb = nowF ? nowF() : 0;
      // 3D pass first (render() submits the command buffer, or natively renders a
      // retained all-static scene), then the 2D HUD on top.
      if (this.scene3d && hasG3d()) {
        if (!this.enc) this.enc = new CommandEncoder();
        this.enc.reset();
        this.scene3d.render(this.enc);
      }
      // Audio: flush this frame's accumulated play()/loop() commands in ONE FFI
      // crossing, AFTER the 3D render and BEFORE the 2D HUD draw (the HUD reads
      // audio.active/lastEvent/vu, which flush() updates deterministically).
      this.audio?.flush();
      const tc = nowF ? nowF() : 0;
      sc.drawTree(this.g);
      if (nowF) {
        const td = nowF();
        this._pAcc[0] += tb - ta;
        this._pAcc[1] += tc - tb;
        this._pAcc[2] += td - tc;
        if ((this._pN += 1) >= 60) {
          for (let i = 0; i < 3; i++) {
            this.prof[i] = (this._pAcc[i] / this._pN) | 0;
            this._pAcc[i] = 0;
          }
          this._pN = 0;
        }
      }
    }
  }
}

/** Convenience entry point used by games: `start(() => new MyScene())`. */
export function start(scene: Scene | (() => Scene), opts: EngineOpts = {}): Engine {
  const e = new Engine(opts);
  e.run(typeof scene === 'function' ? scene() : scene);
  return e;
}

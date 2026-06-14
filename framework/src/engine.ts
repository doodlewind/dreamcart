import { Graphics } from './graphics';
import { Input } from './input';
import { Rng } from './rng';
import { Scene } from './scene';

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

  /** Advance one frame. Public so the golden-test harness can drive it directly. */
  tick(mask: number): void {
    this.input.update(mask);
    this.frameCount++;
    const ctx = this.ctx();
    const sc = this.scene;
    if (sc) {
      sc.updateTree(ctx);
      sc.drawTree(this.g);
    }
  }
}

/** Convenience entry point used by games: `start(() => new MyScene())`. */
export function start(scene: Scene | (() => Scene), opts: EngineOpts = {}): Engine {
  const e = new Engine(opts);
  e.run(typeof scene === 'function' ? scene() : scene);
  return e;
}

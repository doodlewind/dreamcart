// Wall-clock FPS counter for on-device profiling. Uses the host `now()` (µs on
// PSP via sceKernelGetSystemTimeWide; absent on Web/golden -> value stays 0). The
// engine's dt is a FIXED timestep, so it can't measure real frame time. Smoothed
// over ~1 second. Render `fps.value` with g.text to read it in a screenshot.
export class Fps {
  value = 0;
  private last = 0;
  private acc = 0;
  private frames = 0;

  /** Call once per frame (e.g. in update). */
  sample(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const host = globalThis as any;
    if (typeof host.now !== 'function') return;
    const t = host.now();
    if (this.last) {
      this.acc += t - this.last;
      this.frames++;
      if (this.acc >= 1e6) {
        this.value = Math.round((this.frames * 1e6) / this.acc);
        this.acc = 0;
        this.frames = 0;
      }
    }
    this.last = t;
  }
}

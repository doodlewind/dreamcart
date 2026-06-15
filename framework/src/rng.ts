// Deterministic, seedable RNG (mulberry32). Games use this instead of
// Math.random so golden tests are reproducible across platforms.
export class Rng {
  private s: number;

  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }

  /** float in [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** integer in [0, n) */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** float in [a, b) */
  range(a: number, b: number): number {
    return a + this.next() * (b - a);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

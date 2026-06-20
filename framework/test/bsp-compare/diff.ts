// Compares two 480x272 frames (a = reference, b = under test) of the SAME static pose
// and reports how much they agree, structurally and per-pixel. Used by the BSP
// ground-truth harness: WebGL (reference) vs PPSSPP (under test), or WebGL vs the
// software oracle (structure-only). Writes a localizing heatmap + a side-by-side.
//
//   bun framework/test/bsp-compare/diff.ts a.png b.png [--structural] [--out PREFIX]
//
// Metrics: a pixel is "surface" if it differs from the host clear colour (0x10,0x14,
// 0x1e) by >ε. IoU = surface∩ / surface∪ (structure). coverageXor = surface in ONE
// host only (missing/extra face, wrong cull, near-plane drop). meanRGB = mean |Δrgb|
// over the intersection (texture/shading/fog). Heatmap: RED = structural XOR, GREEN→
// YELLOW = RGB-diff intensity inside the intersection, BLACK = agree.
import UPNG from 'upng-js';
import { readFileSync, writeFileSync } from 'node:fs';

const W = 480, H = 272, N = W * H;
const CLEAR = [0x10, 0x14, 0x1e];
const EPS = 18; // sum-of-channel threshold for "this pixel is surface, not background"

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
if (files.length < 2) { console.error('usage: diff.ts a.png b.png [--structural] [--out PREFIX]'); process.exit(2); }
const structural = args.includes('--structural'); // gate on IoU only (oracle has no textures)
const outPrefix = (args[args.indexOf('--out') + 1] && args.includes('--out')) ? args[args.indexOf('--out') + 1] : files[1].replace(/\.png$/, '');

function load(path: string): Uint8Array {
  const dec = UPNG.decode(readFileSync(path));
  const rgba = new Uint8Array(UPNG.toRGBA8(dec)[0]);
  if (dec.width !== W || dec.height !== H) throw new Error(`${path} is ${dec.width}x${dec.height}, expected ${W}x${H}`);
  return rgba;
}
const a = load(files[0]);
const b = load(files[1]);
const surface = (px: Uint8Array, i: number) => (Math.abs(px[i] - CLEAR[0]) + Math.abs(px[i + 1] - CLEAR[1]) + Math.abs(px[i + 2] - CLEAR[2])) > EPS;

let inter = 0, uni = 0, xor = 0, rgbSum = 0, rgbN = 0;
const rgbVals: number[] = [];
const heat = new Uint8Array(N * 4);
for (let p = 0; p < N; p++) {
  const i = p * 4;
  const sa = surface(a, i), sb = surface(b, i);
  if (sa || sb) uni++;
  if (sa && sb) {
    inter++;
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    rgbSum += d; rgbN++; rgbVals.push(d);
    const g = Math.min(255, d); // green→yellow by RGB delta
    heat[i] = g; heat[i + 1] = g; heat[i + 2] = 0; heat[i + 3] = 255;
  } else if (sa !== sb) {
    xor++;
    heat[i] = 230; heat[i + 1] = 20; heat[i + 2] = 20; heat[i + 3] = 255; // RED = structural disagreement
  } else {
    heat[i] = 0; heat[i + 1] = 0; heat[i + 2] = 0; heat[i + 3] = 255;
  }
}
const IoU = uni ? inter / uni : 1;
const xorFrac = xor / N;
const meanRGB = rgbN ? rgbSum / rgbN : 0;
rgbVals.sort((x, y) => x - y);
const p95 = rgbVals.length ? rgbVals[Math.floor(rgbVals.length * 0.95)] : 0;
const score = 0.8 * (1 - IoU) + 0.2 * (meanRGB / 765);

// heatmap + side-by-side (a | b | heatmap)
writeFileSync(outPrefix + '.heatmap.png', Buffer.from(UPNG.encode([heat.buffer], W, H, 0) as ArrayBuffer));
const SB = new Uint8Array(W * 3 * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const s = (y * W + x) * 4, d = (y * (W * 3) + x) * 4;
    SB.set(a.subarray(s, s + 4), d);
    SB.set(b.subarray(s, s + 4), d + W * 4);
    SB.set(heat.subarray(s, s + 4), d + W * 8);
  }
}
writeFileSync(outPrefix + '.sidebyside.png', Buffer.from(UPNG.encode([SB.buffer], W * 3, H, 0) as ArrayBuffer));

// gates: structure (IoU) always; textured agreement (meanRGB) unless --structural
const iouGate = structural ? 0.98 : 0.995;
const rgbGate = structural ? Infinity : 8;
const passIoU = IoU >= iouGate;
const passRGB = meanRGB <= rgbGate;
const pass = passIoU && passRGB;
const report = {
  a: files[0], b: files[1], IoU: +IoU.toFixed(4), coverageXor: +xorFrac.toFixed(4),
  meanRGB: +meanRGB.toFixed(2), p95RGB: p95, score: +score.toFixed(4),
  gate: structural ? 'structural (IoU>=0.98)' : 'textured (IoU>=0.995 & meanRGB<=8)', pass,
};
writeFileSync(outPrefix + '.score.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`heatmap: ${outPrefix}.heatmap.png   side-by-side: ${outPrefix}.sidebyside.png`);
process.exit(pass ? 0 : 1);

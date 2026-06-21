// Software-rasterizer render of the static bsp-compare scene -> a 480x272 PNG. This is
// the deterministic, no-GPU/no-network STRUCTURE oracle for the ground-truth harness:
// framework/test/raster3d.ts shades by per-vertex COLOR only (no texture sampling), so
// it validates GEOMETRY/COVERAGE (which pixels are surface) — not texture correctness.
// Run:  BSP_MAP=box bun framework/test/bsp-compare/oracle.ts
import UPNG from 'upng-js';
import { writeFileSync, existsSync } from 'node:fs';
import { Raster3D } from '../raster3d';

const W = 480, H = 272;
const here = new URL('.', import.meta.url).pathname;
const map = process.env.BSP_MAP || 'box';
(globalThis as any).__BSP_MAP = map;

const bundle = await Bun.file(here + '../../../runtime/src/game/bsp-compare.js').text();
const buf = new Uint8Array(W * H * 4);
const raster = new Raster3D(buf, W, H);
(globalThis as any).gfx = { clear() {}, fillRect() {}, fillRects() {} };
(globalThis as any).g3d = raster;
(globalThis as any).log = () => {};
(globalThis as any).frame = undefined;
// The baked map module pulls its blobs from __dcpak at eval time; load the per-game pack
// (mirrors the host contract + golden.ts). Absent pack => undefined (asset-free games).
const pakPath = here + '../../../runtime/src/game/bsp-compare.dcpak';
(globalThis as any).__dcpak = existsSync(pakPath) ? await Bun.file(pakPath).arrayBuffer() : undefined;
(0, eval)(bundle);
const fr = (globalThis as any).frame;
if (typeof fr !== 'function') throw new Error('bsp-compare did not define frame');
fr(0); // one static frame

const png = UPNG.encode([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)], W, H, 0);
writeFileSync(here + `${map}.oracle.png`, Buffer.from(png as ArrayBuffer));
let fg = 0;
for (let i = 0; i < buf.length; i += 4) if (!(buf[i] === 0x10 && buf[i + 1] === 0x14 && buf[i + 2] === 0x1e)) fg++;
console.log(`wrote ${map}.oracle.png  (${(100 * fg / (W * H)).toFixed(0)}% surface coverage)`);

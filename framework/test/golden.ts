// Golden / no-crash tests. Renders each game's bundle headlessly via a gfx mock
// (-> RGBA buffer), runs a deterministic seeded+scripted sequence, and byte-
// compares the framebuffer to a committed golden. The same bundle runs on
// PSP/Web/3DS, so this validates the shared cross-platform code.
//   bun framework/test/golden.ts           # compare
//   UPDATE=1 bun framework/test/golden.ts  # (re)write goldens
import { existsSync, mkdirSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const gameDir = here + "../../runtime/src/game/";
const goldenDir = here + "goldens/";
mkdirSync(goldenDir, { recursive: true });

const W = 480;
const H = 272;
const UPDATE = !!process.env.UPDATE;

function makeGfx(buf: Uint8Array) {
  const put = (x: number, y: number, w: number, h: number, r: number, g: number, b: number) => {
    x |= 0; y |= 0; w |= 0; h |= 0;
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
    for (let yy = y0; yy < y1; yy++) {
      let o = (yy * W + x0) * 4;
      for (let xx = x0; xx < x1; xx++) { buf[o++] = r; buf[o++] = g; buf[o++] = b; buf[o++] = 255; }
    }
  };
  return {
    clear: (r: number, g: number, b: number) => put(0, 0, W, H, r, g, b),
    fillRect: (x: number, y: number, w: number, h: number, r: number, g: number, b: number) => put(x, y, w, h, r, g, b),
  };
}

// minimal PNG encoder (for human-viewable goldens)
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgba: Uint8Array): Buffer {
  const stride = W * 4;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (stride + 1)] = 0; Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", Buffer.from(Bun.deflateSync(raw))), chunk("IEND", Buffer.alloc(0))]);
}

async function runGame(file: string, frames: number, inputAt?: (f: number) => number): Promise<Uint8Array> {
  const buf = new Uint8Array(W * H * 4);
  (globalThis as any).gfx = makeGfx(buf);
  (globalThis as any).log = () => {};
  (globalThis as any).frame = undefined;
  const src = await Bun.file(file).text();
  (0, eval)(src); // run the IIFE; it sets globalThis.frame
  const fr = (globalThis as any).frame;
  if (typeof fr !== "function") throw new Error("no globalThis.frame after load");
  for (let f = 0; f < frames; f++) fr(inputAt ? inputAt(f) : 0);
  return buf;
}

const SPECS: { name: string; frames: number; input?: (f: number) => number }[] = [
  { name: "fw-snake", frames: 200 },
  { name: "fw-shooter", frames: 200, input: (f) => (f % 40 < 20 ? 0x20 : 0x80) | (f % 7 === 0 ? 0x4000 : 0) },
  { name: "fw-flappy", frames: 160, input: (f) => (f % 18 === 0 ? 0x4000 : 0) },
  { name: "fw-maze", frames: 200, input: (f) => [0x20, 0x40, 0x80, 0x10][(f >> 4) & 3] },
  { name: "fw-dodge", frames: 200, input: (f) => (f % 50 < 25 ? 0x20 : 0x80) },
  { name: "fw-rpg", frames: 260, input: (f) => (f < 45 ? 0x80 : f < 170 ? 0x40 : 0x20 | (f % 40 === 0 ? 0x4000 : 0)) },
];

let pass = 0, fail = 0, skipped = 0;
for (const spec of SPECS) {
  const file = gameDir + spec.name + ".js";
  if (!existsSync(file)) { console.log("SKIP", spec.name, "(no bundle)"); skipped++; continue; }
  let buf: Uint8Array;
  try {
    buf = await runGame(file, spec.frames, spec.input);
  } catch (e: any) {
    console.log("FAIL", spec.name, "- threw:", e?.message ?? e); fail++; continue;
  }
  const goldRaw = goldenDir + spec.name + ".rgbz";
  if (UPDATE || !existsSync(goldRaw)) {
    await Bun.write(goldRaw, Bun.gzipSync(buf));
    await Bun.write(goldenDir + spec.name + ".png", encodePNG(buf));
    console.log(UPDATE ? "WROTE" : "NEW  ", spec.name); pass++; continue;
  }
  const golden = Bun.gunzipSync(new Uint8Array(await Bun.file(goldRaw).arrayBuffer()));
  let diff = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== golden[i]) diff++;
  if (diff === 0) { console.log("PASS ", spec.name); pass++; }
  else { await Bun.write(goldenDir + spec.name + ".actual.png", encodePNG(buf)); console.log("FAIL ", spec.name, "- " + diff + " byte diffs"); fail++; }
}

console.log("\n" + pass + " passed, " + fail + " failed, " + skipped + " skipped");
process.exit(fail ? 1 : 0);

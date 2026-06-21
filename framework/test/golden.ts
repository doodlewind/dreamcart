// Golden / no-crash tests. Renders each game's bundle headlessly via a gfx mock
// (-> RGBA buffer), runs a deterministic seeded+scripted sequence, and byte-
// compares the framebuffer to a committed golden. The same bundle runs on
// PSP/Web/3DS, so this validates the shared cross-platform code.
//   bun framework/test/golden.ts           # compare
//   UPDATE=1 bun framework/test/golden.ts  # (re)write goldens
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { Raster3D } from "./raster3d";

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
    // Batched path (gfx.fillRects): same pixels as N fillRect calls, so the
    // golden image is identical whether a host batches text or not.
    fillRects: (buffer: ArrayBuffer, count: number) => {
      const v = new Int32Array(buffer);
      for (let i = 0; i < count; i++) {
        const o = i * 5;
        const rgb = v[o + 4] >>> 0;
        put(v[o], v[o + 1], v[o + 2], v[o + 3], (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
      }
    },
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

// mulberry32 — used to make raw games (which call Math.random directly)
// deterministic during the smoke pass.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runGame(
  file: string,
  frames: number,
  inputAt?: (f: number) => number,
  seedRandom?: number,
): Promise<{ buf: Uint8Array; raster: Raster3D }> {
  const buf = new Uint8Array(W * H * 4);
  // The 3D host is the software reference rasterizer: it renders the same submit
  // buffer the native hosts get, into the same RGBA buffer (3D first), and the
  // 2D gfx HUD draws on top. 2D-only games never touch it (no scene3d -> no submit).
  const raster = new Raster3D(buf, W, H);
  (globalThis as any).gfx = makeGfx(buf);
  (globalThis as any).g3d = raster;
  (globalThis as any).log = () => {};
  (globalThis as any).frame = undefined;
  // Expose the game's binary asset pack as __dcpak before eval (the host contract:
  // baked asset modules read it synchronously at module-eval time). Mirrors what
  // the PSP/3DS/Web hosts do; here we read the <name>.dcpak next to the bundle.
  const pakPath = file.replace(/\.js$/, ".dcpak");
  (globalThis as any).__dcpak = existsSync(pakPath)
    ? (await Bun.file(pakPath).arrayBuffer())
    : undefined;
  const realRandom = Math.random;
  if (seedRandom !== undefined) Math.random = mulberry32(seedRandom);
  try {
    const src = await Bun.file(file).text();
    (0, eval)(src); // run the IIFE; it sets globalThis.frame
    const fr = (globalThis as any).frame;
    if (typeof fr !== "function") throw new Error("no globalThis.frame after load");
    for (let f = 0; f < frames; f++) fr(inputAt ? inputAt(f) : 0);
  } finally {
    Math.random = realRandom;
    delete (globalThis as any).g3d;
    delete (globalThis as any).__dcpak;
  }
  return { buf, raster };
}

const SPECS: { name: string; frames: number; input?: (f: number) => number }[] = [
  { name: "snake", frames: 200 },
  { name: "shooter", frames: 200, input: (f) => (f % 40 < 20 ? 0x20 : 0x80) | (f % 7 === 0 ? 0x4000 : 0) },
  { name: "flappy", frames: 160, input: (f) => (f % 18 === 0 ? 0x4000 : 0) },
  { name: "maze", frames: 200, input: (f) => [0x20, 0x40, 0x80, 0x10][(f >> 4) & 3] },
  { name: "dodge", frames: 200, input: (f) => (f % 50 < 25 ? 0x20 : 0x80) },
  { name: "rpg", frames: 260, input: (f) => (f < 45 ? 0x80 : f < 170 ? 0x40 : 0x20 | (f % 40 === 0 ? 0x4000 : 0)) },
  { name: "cube3d", frames: 120, input: (f) => (f < 30 ? 0x20 : f < 60 ? 0x10 : f < 90 ? 0x80 : 0x40) },
  // lit3d (M1): textured + hardware-lit static cube; tilt it through all axes.
  { name: "lit3d", frames: 120, input: (f) => (f < 30 ? 0x20 : f < 60 ? 0x10 : f < 90 ? 0x80 : 0x40) },
  // racing: hold accelerate (CROSS) the whole time, steer right then left.
  { name: "racing3d", frames: 180, input: (f) => 0x4000 | (f > 60 && f < 110 ? 0x20 : f >= 110 ? 0x80 : 0) },
  // car (M3): baked glTF car; accelerate, steer right then left (wheels roll/steer).
  { name: "car3d", frames: 180, input: (f) => 0x4000 | (f > 60 && f < 110 ? 0x20 : f >= 110 ? 0x80 : 0) },
  // skin (M4): static-pose HW-skinned Fox, auto-orbit camera (no input).
  { name: "skin3d", frames: 90 },
  // walk (M5): walking Fox; turn, walk, run (clip phase tied to motion).
  { name: "walk3d", frames: 160, input: (f) => (f < 40 ? 0x4000 : f < 70 ? 0x4000 | 0x80 : f < 120 ? 0x8000 : 0x4000) },
  // outdoor (M6): fly-through; auto-forward, steer + boost (fog + frustum cull).
  { name: "outdoor3d", frames: 160, input: (f) => (f < 50 ? 0x20 : f < 100 ? 0x80 : 0) | (f % 3 === 0 ? 0x4000 : 0) },
  // adventure: skinned human-scale character walking through the richer outdoor scene.
  { name: "adventure3d", frames: 180, input: (f) => (f < 70 ? 0x10 : f < 120 ? 0x10 | 0x80 : 0x8000) | (f > 30 && f < 115 ? 0x4000 : 0) },
  // fps: turn right, walk forward, shoot a few times.
  { name: "fps3d", frames: 180, input: (f) => (f < 40 ? 0x20 : f < 110 ? 0x10 : 0x80) | (f % 24 === 0 ? 0x4000 : 0) },
  // controller3d: cycle CAR->WALK->FLY->FPS via single-frame SELECT (0x01) pulses
  // at 60/120/180, while pulsing CROSS (go/fire) and steering + pitching, so the
  // golden exercises all four config/rig paths through the one kinematicStep.
  {
    name: "controller3d", frames: 240,
    input: (f) =>
      ((f === 60 || f === 120 || f === 180) ? 0x01 : 0) | // SELECT pulse -> next mode
      (f % 20 < 14 ? 0x4000 : 0) |                        // CROSS go/fire (pulsed so FPS fires)
      (f % 80 < 40 ? 0x20 : 0x80) |                       // steer Right then Left
      (f % 30 < 15 ? 0x10 : 0x40),                        // UP/DOWN (fly pitch / fps move)
  },
  // bsp: walk the BSP-imported box room (D-pad UP, then strafe, then run).
  { name: "bsp3d", frames: 90, input: (f) => (f < 30 ? 0x10 : f < 60 ? 0x10 | 0x20 : 0x8000 | 0x10) },
  // bsp-compare: static ground-truth pose (no input) — the committable structure golden
  // that the WebGL/PPSSPP ground-truth harness (framework/test/bsp-compare/) compares to.
  { name: "bsp-compare", frames: 2 },
];

let pass = 0, fail = 0, skipped = 0;
for (const spec of SPECS) {
  const file = gameDir + spec.name + ".js";
  if (!existsSync(file)) { console.log("SKIP", spec.name, "(no bundle)"); skipped++; continue; }
  let buf: Uint8Array;
  let raster: Raster3D;
  try {
    ({ buf, raster } = await runGame(file, spec.frames, spec.input));
  } catch (e: any) {
    console.log("FAIL", spec.name, "- threw:", e?.message ?? e); fail++; continue;
  }
  const goldRaw = goldenDir + spec.name + ".rgbz";
  if (UPDATE || !existsSync(goldRaw)) {
    await Bun.write(goldRaw, Bun.gzipSync(buf));
    await Bun.write(goldenDir + spec.name + ".png", encodePNG(buf));
    console.log(UPDATE ? "WROTE" : "NEW  ", spec.name); pass++;
  } else {
    const golden = Bun.gunzipSync(new Uint8Array(await Bun.file(goldRaw).arrayBuffer()));
    let diff = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] !== golden[i]) diff++;
    if (diff === 0) { console.log("PASS ", spec.name); pass++; }
    else { await Bun.write(goldenDir + spec.name + ".actual.png", encodePNG(buf)); console.log("FAIL ", spec.name, "- " + diff + " byte diffs"); fail++; }
  }

  // 3D games also get a byte-exact draw-list (.dc3d) golden: the uploadMesh +
  // submit wire bytes, which are deterministic across hosts (shared math).
  if (raster.used) {
    const dc3d = goldenDir + spec.name + ".dc3d";
    const rec = raster.recorded();
    if (UPDATE || !existsSync(dc3d)) {
      await Bun.write(dc3d, Bun.gzipSync(rec));
      console.log(UPDATE ? "WROTE" : "NEW  ", spec.name + ".dc3d");
    } else {
      const gold = Bun.gunzipSync(new Uint8Array(await Bun.file(dc3d).arrayBuffer()));
      let d = rec.length !== gold.length ? 1 : 0;
      for (let i = 0; i < rec.length && d === 0; i++) if (rec[i] !== gold[i]) d++;
      if (d === 0) console.log("PASS ", spec.name + ".dc3d");
      else { console.log("FAIL ", spec.name + ".dc3d - draw-list mismatch"); fail++; }
    }
  }
}

// --- Raw low-level demos (runtime/src/game/raw-*.js) ---
// These call Math.random directly, so pixel goldens aren't reproducible; instead
// run a deterministic (seeded Math.random) scripted sequence and assert frame()
// never throws — a no-crash smoke test of the bare gfx/frame contract.
const RAW_INPUT = (f: number) =>
  [0x20, 0x40, 0x80, 0x10][(f >> 4) & 3] | (f % 30 === 0 ? 0x4000 : 0) | (f % 90 === 0 ? 0x08 : 0);
const rawFiles = readdirSync(gameDir)
  .filter((f) => f.startsWith("raw-") && f.endsWith(".js"))
  .sort();
for (const f of rawFiles) {
  const name = f.slice(0, -3);
  try {
    await runGame(gameDir + f, 200, RAW_INPUT, 0x1234);
    console.log("SMOKE", name, "- ok"); pass++;
  } catch (e: any) {
    console.log("FAIL ", name, "- threw:", e?.message ?? e); fail++;
  }
}

console.log("\n" + pass + " passed, " + fail + " failed, " + skipped + " skipped");
process.exit(fail ? 1 : 0);

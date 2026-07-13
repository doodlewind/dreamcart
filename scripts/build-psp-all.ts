// Build every DreamCart game into a PSP memory-stick layout:
//   dist/psp/PSP/GAME/<game>/EBOOT.PBP
import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  PSP_TOOLCHAIN,
  pspToolchainPaths,
  resolvePspSdk,
} from "./psp-toolchain.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtimeGameDir = join(root, "runtime/src/game");
const frameworkGameDir = join(root, "framework/games");
const outRoot = join(root, "dist/psp");
const pspGameRoot = join(outRoot, "PSP/GAME");
const workRoot = join(outRoot, ".work");
const cargoArgs = Bun.argv.slice(2);
const profile = outputProfile(cargoArgs);
const eboot = join(root, "runtime/target/mipsel-sony-psp", profile, "EBOOT.PBP");
const home = process.env.HOME ?? "";
const W = 480;
const H = 272;
const ICON_W = 144;
const ICON_H = 80;

function usage(): void {
  console.log("Usage: bun run psp:all [cargo-psp args]\n");
  console.log("Builds every raw and framework game as PSP homebrew:");
  console.log("  dist/psp/PSP/GAME/<game>/EBOOT.PBP\n");
  console.log("Copy dist/psp/PSP to the root of a PSP memory stick.");
  console.log("Example: bun run psp:all -- --release");
}

function listJsNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.slice(0, -3));
}

function listGames(): string[] {
  const runtimeGames = listJsNames(runtimeGameDir);
  const frameworkGames = listJsNames(frameworkGameDir);
  return Array.from(new Set([...runtimeGames, ...frameworkGames])).sort();
}

function outputProfile(args: string[]): string {
  const inlineProfile = args.find((arg) => arg.startsWith("--profile="));
  if (inlineProfile) return inlineProfile.slice("--profile=".length);
  const profileFlag = args.indexOf("--profile");
  if (profileFlag !== -1 && args[profileFlag + 1]) return args[profileFlag + 1];
  return args.includes("--release") || args.includes("-r") ? "release" : "debug";
}

function folderName(game: string): string {
  return game.replace(/[^A-Za-z0-9_-]/g, "_");
}

function commandPath(name: string): string | null {
  const cached = join(pspToolchainPaths().toolsBin, name);
  if (PSP_TOOLCHAIN.cargoPsp.tools.includes(name)) return existsSync(cached) ? cached : null;
  return Bun.which(name) ?? (home !== "" && existsSync(join(home, ".cargo/bin", name)) ? join(home, ".cargo/bin", name) : null);
}

function parseMeta(src: string): { title?: string; order?: number; controls?: string } {
  const tag = (name: string) => src.match(new RegExp(`^//\\s*@${name}\\s+(.+)$`, "m"))?.[1].trim();
  const order = tag("order");
  return { title: tag("title"), order: order === undefined ? undefined : parseInt(order, 10), controls: tag("controls") };
}

async function gameTitle(game: string): Promise<string> {
  const source = existsSync(join(frameworkGameDir, `${game}.js`))
    ? join(frameworkGameDir, `${game}.js`)
    : join(runtimeGameDir, `${game}.js`);
  const meta = parseMeta(await Bun.file(source).text());
  return (meta.title ?? game).slice(0, 127);
}

function checkPspSetup(): void {
  const missing: string[] = [];
  if (!existsSync(join(root, "quickjs-rs/libquickjs-sys/Cargo.toml"))) missing.push("quickjs-rs submodule");
  if (!existsSync(join(root, "rust-psp/psp/Cargo.toml"))) missing.push("rust-psp submodule");
  try {
    resolvePspSdk();
  } catch (error) {
    missing.push(error instanceof Error ? error.message : "PSPSDK");
  }
  if (!commandPath("rustup")) missing.push("rustup");
  if (!commandPath("cargo-psp")) missing.push("cargo-psp");
  if (!commandPath("mksfo")) missing.push("mksfo");
  if (!commandPath("pack-pbp")) missing.push("pack-pbp");

  const hasLlvm =
    existsSync("/opt/homebrew/opt/llvm/bin/clang") || existsSync("/usr/local/opt/llvm/bin/clang");
  if (!hasLlvm) missing.push("Homebrew LLVM");

  if (missing.length > 0) {
    console.error("PSP toolchain is not ready: " + missing.join(", "));
    console.error("run `bun run bootstrap` and then retry `bun run psp:all`");
    process.exit(1);
  }
}

const FONT: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "(": ["00110", "01100", "11000", "11000", "11000", "01100", "00110"],
  ")": ["01100", "00110", "00011", "00011", "00011", "00110", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "11100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00001", "00001", "00001", "00001", "10001", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function putRect(buf: Uint8Array, w: number, h: number, x: number, y: number, rw: number, rh: number, color: [number, number, number, number]): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(w, Math.ceil(x + rw));
  const y1 = Math.min(h, Math.ceil(y + rh));
  const alpha = color[3] / 255;
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const o = (yy * w + xx) * 4;
      buf[o] = mix(buf[o], color[0], alpha);
      buf[o + 1] = mix(buf[o + 1], color[1], alpha);
      buf[o + 2] = mix(buf[o + 2], color[2], alpha);
      buf[o + 3] = 255;
    }
  }
}

function textWidth(text: string, scale: number): number {
  return Math.max(0, text.length * 6 * scale - scale);
}

function drawText(buf: Uint8Array, w: number, h: number, text: string, x: number, y: number, scale: number, color: [number, number, number, number]): void {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch] ?? FONT[" "];
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (glyph[gy][gx] === "1") putRect(buf, w, h, cx + gx * scale, y + gy * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars || line === "") line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [text.toUpperCase()];
}

function renderPlaceholder(title: string, w: number, h: number): Uint8Array {
  const hash = hashText(title);
  const a = [30 + (hash & 63), 42 + ((hash >> 6) & 63), 78 + ((hash >> 12) & 63)];
  const b = [122 + ((hash >> 4) & 79), 55 + ((hash >> 10) & 79), 78 + ((hash >> 16) & 79)];
  const c = [22 + ((hash >> 8) & 47), 90 + ((hash >> 14) & 63), 120 + ((hash >> 20) & 63)];
  const buf = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tx = x / Math.max(1, w - 1);
      const ty = y / Math.max(1, h - 1);
      const band = ((x + y * 2) % Math.max(12, Math.floor(w / 8))) < Math.max(3, Math.floor(w / 32)) ? 12 : 0;
      const o = (y * w + x) * 4;
      buf[o] = Math.min(255, mix(mix(a[0], b[0], tx), c[0], ty * 0.6) + band);
      buf[o + 1] = Math.min(255, mix(mix(a[1], b[1], tx), c[1], ty * 0.6) + band);
      buf[o + 2] = Math.min(255, mix(mix(a[2], b[2], tx), c[2], ty * 0.6) + band);
      buf[o + 3] = 255;
    }
  }

  const margin = Math.max(10, Math.floor(w * 0.07));
  const badgeScale = Math.max(1, Math.floor(w / 160));
  const titleScale = w < 200 ? 1 : Math.max(2, Math.floor(w / 120));
  putRect(buf, w, h, margin, Math.floor(h * 0.18), w - margin * 2, Math.floor(h * 0.58), [0, 0, 0, 96]);
  drawText(buf, w, h, "DREAMCART PSP", margin + 6, Math.floor(h * 0.22), badgeScale, [236, 242, 255, 230]);

  const lines = wrapText(title, Math.max(8, Math.floor((w - margin * 2) / (6 * titleScale))));
  const lineHeight = 8 * titleScale;
  const startY = Math.floor(h * 0.48 - ((lines.length - 1) * lineHeight) / 2);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const x = Math.floor((w - textWidth(line, titleScale)) / 2);
    drawText(buf, w, h, line, x + titleScale, startY + i * lineHeight + titleScale, titleScale, [0, 0, 0, 130]);
    drawText(buf, w, h, line, x, startY + i * lineHeight, titleScale, [255, 255, 255, 245]);
  }
  return buf;
}

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function extractPbpSection(pbpPath: string, section: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await Bun.file(pbpPath).arrayBuffer());
  if (bytes.length < 40 || bytes[0] !== 0 || bytes[1] !== 0x50 || bytes[2] !== 0x42 || bytes[3] !== 0x50) {
    throw new Error(`not a PBP file: ${pbpPath}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets: number[] = [];
  for (let i = 0; i < 8; i++) offsets.push(dv.getUint32(8 + i * 4, true));
  const start = offsets[section];
  const end = section === 7 ? bytes.length : offsets[section + 1];
  if (start < 40 || end < start || end > bytes.length) {
    throw new Error(`invalid PBP section ${section}: ${pbpPath}`);
  }
  return bytes.slice(start, end);
}

async function repackEboot(game: string, title: string, destDir: string): Promise<void> {
  const workDir = join(workRoot, folderName(game));
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const dataPsp = await extractPbpSection(eboot, 6);
  const dataPsar = await extractPbpSection(eboot, 7);
  const dataPspPath = join(workDir, "DATA.PSP");
  const dataPsarPath = join(workDir, "DATA.PSAR");
  const paramPath = join(workDir, "PARAM.SFO");
  const iconPath = join(workDir, "ICON0.PNG");
  const picPath = join(workDir, "PIC1.PNG");
  const destEboot = join(destDir, "EBOOT.PBP");

  const preview = renderPlaceholder(title, W, H);
  const icon = renderPlaceholder(title, ICON_W, ICON_H);
  await Bun.write(picPath, encodePng(preview, W, H));
  await Bun.write(iconPath, encodePng(icon, ICON_W, ICON_H));
  await Bun.write(dataPspPath, dataPsp);
  if (dataPsar.length > 0) await Bun.write(dataPsarPath, dataPsar);

  const mksfo = commandPath("mksfo");
  const packPbp = commandPath("pack-pbp");
  if (!mksfo || !packPbp) throw new Error("mksfo/pack-pbp not found");
  await $`${mksfo} ${title} ${paramPath}`;
  await $`${packPbp} ${destEboot} ${paramPath} ${iconPath} NULL NULL ${picPath} NULL ${dataPspPath} ${dataPsar.length > 0 ? dataPsarPath : "NULL"}`;
}

if (cargoArgs.includes("--help") || cargoArgs.includes("-h")) {
  usage();
  process.exit(0);
}

checkPspSetup();

console.log("Preparing PSP game bundles...");
await $`bun run build`.cwd(root);

const games = listGames();
if (games.length === 0) {
  console.error("no games found under runtime/src/game or framework/games");
  process.exit(1);
}

const missingBundles = games.filter((game) => !existsSync(join(runtimeGameDir, `${game}.js`)));
if (missingBundles.length > 0) {
  console.error("missing runtime game bundle(s): " + missingBundles.map((game) => `${game}.js`).join(", "));
  console.error("try running `bun run build` first");
  process.exit(1);
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(pspGameRoot, { recursive: true });
mkdirSync(workRoot, { recursive: true });

for (const [index, game] of games.entries()) {
  const title = await gameTitle(game);
  console.log(`[${index + 1}/${games.length}] building ${game} (${title})`);
  rmSync(eboot, { force: true });
  await $`bun ${join(root, "runtime/build.ts")} ${cargoArgs}`.cwd(root).env({
    ...process.env,
    PSPJS_GAME: `${game}.js`,
  });

  if (!existsSync(eboot)) {
    console.error(`expected PSP output was not created: ${eboot}`);
    process.exit(1);
  }

  const destDir = join(pspGameRoot, folderName(game));
  mkdirSync(destDir, { recursive: true });
  await repackEboot(game, title, destDir);
}

rmSync(workRoot, { recursive: true, force: true });

await Bun.write(
  join(outRoot, "README.txt"),
  [
    "DreamCart PSP bundle",
    "",
    "Copy the PSP directory in this folder to the root of a PSP memory stick.",
    "Each game is under PSP/GAME/<game>/EBOOT.PBP.",
    "Each EBOOT includes a generated PARAM.SFO title plus ICON0.PNG and PIC1.PNG previews.",
    "",
    "Games:",
    ...(await Promise.all(games.map(async (game) => `- ${game}: ${await gameTitle(game)}`))),
    "",
  ].join("\n"),
);

console.log(`\nBuilt ${games.length} PSP game(s): ${pspGameRoot}`);
console.log("Copy dist/psp/PSP to the root of the PSP memory stick.");

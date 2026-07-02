// Run a freshly compiled game on a REAL PSP over USB — no memory-stick copy.
//
//   bun run psp:hw               # build + run the default game on the PSP
//   bun run psp:hw walk3d        # build + run a specific game
//   bun run psp:hw walk3d -r     # release profile
//   bun run psp:hw --once        # build + load once, then exit (CI / scripts)
//   bun run psp:hw --no-build    # skip the build, just (re)load what's built
//
// It serves the cargo output directory to the PSP as `host0:` (usbhostfs_pc),
// then `ldstart`s the raw `.prx` through PSPLINK (pspsh). PSPLINK stays resident,
// so each reload is `reset` (clean memory) + `ldstart` (your latest build).
//
// One-time setup (host tools + PSPLINK on the stick): docs/psp-hardware-debugging.md
import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";

const root = new URL("..", import.meta.url).pathname;
const PRX = "host0:/pspjs-runtime.prx";

const argv = Bun.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const positional = argv.filter((a) => !a.startsWith("-"));
const release = flags.has("-r") || flags.has("--release");
const once = flags.has("--once");
const noBuild = flags.has("--no-build");
const profile = release ? "release" : "debug";

function listGames(): string[] {
  const raw = readdirSync(root + "runtime/src/game").filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
  const fw = readdirSync(root + "framework/games").filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
  return Array.from(new Set([...raw, ...fw])).sort();
}
function resolveGame(name?: string): string | null {
  if (!name) return null;
  const n = name.replace(/\.(js|ts)$/, "");
  return listGames().includes(n) ? n : null;
}
const isFw = (n: string) => existsSync(root + "framework/games/" + n + ".js");

function usage(): void {
  console.log("Usage: bun run psp:hw [game] [-r|--release] [--once] [--no-build]\n");
  console.log("Runs a freshly compiled game on a real PSP over USB (PSPLINK + usbhostfs).");
  console.log("Launch PSPLINK on the PSP from the XMB Game menu when prompted.\n");
  console.log("Games: " + listGames().join(", "));
}

if (flags.has("-h") || flags.has("--help")) {
  usage();
  process.exit(0);
}

const game = resolveGame(positional[0]) ?? "raw-snake";
if (positional[0] && !resolveGame(positional[0])) {
  console.error("unknown game: " + positional[0]);
  usage();
  process.exit(1);
}

const usbhostfs = Bun.which("usbhostfs_pc");
const pspsh = Bun.which("pspsh");
if (!usbhostfs || !pspsh) {
  console.error("PSPLINK host tools not found on PATH (need usbhostfs_pc and pspsh).");
  console.error("One-time setup: docs/psp-hardware-debugging.md");
  process.exit(1);
}

if (!noBuild && !existsSync(root + "mipsel-sony-psp/psp/lib/libc.a")) {
  console.error("PSP SDK not found — run `bun run bootstrap` once for this checkout.");
  process.exit(1);
}

const targetDir = root + `runtime/target/mipsel-sony-psp/${profile}`;
const prxPath = targetDir + "/pspjs-runtime.prx";

// usbhostfs_pc binds base..base+8; pspsh talks to base, base+2, base+3, base+8.
// Default base 10000 is the PSPLINK standard; auto-scan upward for a free block so
// a squatter on 10000 (e.g. Baidu Netdisk) doesn't break us. Override: PSP_HW_PORT.
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}
async function findBasePort(start: number): Promise<number> {
  for (let base = start; base <= start + 3000; base += 100) {
    let ok = true;
    for (let i = 0; i <= 8; i++) if (!(await portFree(base + i))) { ok = false; break; }
    if (ok) return base;
  }
  throw new Error("no free TCP port block found for the PSPLINK link");
}

async function build(): Promise<boolean> {
  if (noBuild) return existsSync(prxPath);
  if (isFw(game)) await $`bun ${root}framework/build.ts`.quiet().nothrow();
  console.log(`building ${game} (${profile})…`);
  const cargoArgs = release ? ["--release"] : [];
  const res = await $`bun ${root}runtime/build.ts ${cargoArgs}`
    .env({ ...process.env, PSPJS_GAME: game + ".js" })
    .nothrow();
  if (res.exitCode !== 0 || !existsSync(prxPath)) {
    console.error("build failed — not reloading");
    return false;
  }
  return true;
}

let connectCount = 0;
async function pump(stream: ReadableStream<Uint8Array>): Promise<void> {
  const dec = new TextDecoder();
  for await (const chunk of stream) {
    const text = dec.decode(chunk);
    for (const _ of text.matchAll(/Connected to device/g)) connectCount++;
  }
}
async function waitForConnect(prev: number, timeoutMs = 20000): Promise<boolean> {
  const t0 = Date.now();
  while (connectCount <= prev) {
    if (Date.now() - t0 > timeoutMs) return false;
    await Bun.sleep(200);
  }
  return true;
}

// reset PSPLINK (clears memory + auto-reconnects USB) then load the fresh .prx.
async function loadGame(): Promise<void> {
  const prev = connectCount;
  process.stdout.write("resetting PSPLINK, waiting for USB reconnect… ");
  await $`${pspsh} -p ${basePort} -e reset`.nothrow().quiet();
  if (!(await waitForConnect(prev))) {
    console.log("timeout.\n  → is the PSP awake and still in PSPLINK? (it sleeps when idle)");
    return;
  }
  console.log("connected.");
  const out = (await $`${pspsh} -p ${basePort} -e ${"ldstart " + PRX}`.nothrow().text()).trim();
  console.log("  " + (out || "(no output)"));
  if (/Failed|Error/i.test(out)) {
    console.log("  ⚠ load failed — see docs/psp-hardware-debugging.md (Troubleshooting)");
  }
}

const proc = { kill() {} } as { kill: () => void };
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  try { proc.kill(); } catch { /* already gone */ }
}
process.on("SIGINT", () => { cleanup(); process.exit(0); });

// ── main ──
if (!(await build())) process.exit(1);

if (existsSync(root + "runtime/target") === false) {
  console.error("no build output at " + targetDir);
  process.exit(1);
}

const basePort = await findBasePort(Number(process.env.PSP_HW_PORT ?? 10000));

const existing = (await $`pgrep -x usbhostfs_pc`.nothrow().text()).trim();
if (existing) {
  console.log(`note: another usbhostfs_pc is running (pid ${existing.split("\n").join(", ")}).`);
  console.log("      Only one can own the PSP's USB — kill it if the link fails to connect.");
}

console.log(`serving ${targetDir.replace(root, "")} as host0: on port ${basePort}`);
const child = Bun.spawn([usbhostfs, "-b", String(basePort), targetDir], { stdout: "pipe", stderr: "pipe" });
proc.kill = () => child.kill();
void pump(child.stdout);
void pump(child.stderr);

console.log("waiting for the PSP… launch PSPLINK on it (XMB → Game → PSPLINK).");
if (!(await waitForConnect(0, 120000))) {
  console.error("PSP never connected. Check the USB DATA cable and that PSPLINK is running.");
  console.error("(`ioreg -p IOUSB | grep -i PSP` should list `\"PSP\" Type B`.)");
  cleanup();
  process.exit(1);
}
console.log("PSP connected.");

await loadGame();

if (once) {
  cleanup();
  process.exit(0);
}

console.log("\n[psp:hw] press Enter to rebuild + reload  ·  q + Enter to quit\n");
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const cmd = line.trim().toLowerCase();
  if (cmd === "q" || cmd === "quit" || cmd === "exit") break;
  if (await build()) await loadGame();
  console.log("\n[psp:hw] press Enter to rebuild + reload  ·  q + Enter to quit\n");
}
rl.close();
cleanup();
process.exit(0);

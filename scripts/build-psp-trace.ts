// Build a trace-enabled Snake EBOOT for real-device PSP debugging:
//   dist/psp-trace/PSP/GAME/dreamcart-snake-trace/EBOOT.PBP
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cargoArgs = Bun.argv.slice(2);
const profile = outputProfile(cargoArgs);
const game = process.env.PSPJS_GAME ?? "raw-snake.js";
const gameSlug = game.replace(/\.js$/i, "").replace(/[^A-Za-z0-9_-]/g, "_");
const builtEboot = join(root, "runtime/target/mipsel-sony-psp", profile, "EBOOT.PBP");
const outRoot = join(root, "dist/psp-trace");
const outDir = join(outRoot, `PSP/GAME/dreamcart-${gameSlug}-trace`);
const outEboot = join(outDir, "EBOOT.PBP");

function usage(): void {
  console.log("Usage: bun run psp:trace [cargo-psp args]\n");
  console.log("Builds a trace-enabled game EBOOT for real PSP/Vita debugging:");
  console.log("  dist/psp-trace/PSP/GAME/dreamcart-<game>-trace/EBOOT.PBP\n");
  console.log("Copy dist/psp-trace/PSP to the root of a PSP memory stick.");
  console.log("Example: bun run psp:trace -- --release");
}

function outputProfile(args: string[]): string {
  const inlineProfile = args.find((arg) => arg.startsWith("--profile="));
  if (inlineProfile) return inlineProfile.slice("--profile=".length);
  const profileFlag = args.indexOf("--profile");
  if (profileFlag !== -1 && args[profileFlag + 1]) return args[profileFlag + 1];
  return args.includes("--release") || args.includes("-r") ? "release" : "debug";
}

if (cargoArgs.includes("--help") || cargoArgs.includes("-h")) {
  usage();
  process.exit(0);
}

console.log(`Building PSP trace EBOOT for ${game}...`);
await $`bun ${join(root, "runtime/build.ts")} ${cargoArgs}`.env({
  ...process.env,
  PSPJS_DIAG_MODE: "trace",
  PSPJS_GAME: game,
});

if (!existsSync(builtEboot)) {
  console.error(`expected PSP output was not created: ${builtEboot}`);
  process.exit(1);
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(builtEboot, outEboot);

console.log(`output: ${outEboot}`);
console.log("Copy dist/psp-trace/PSP to the root of the PSP memory stick.");

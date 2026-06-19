// Build a minimal real-device PSP diagnostic EBOOT:
//   dist/psp-diag/PSP/GAME/dreamcart-diag/EBOOT.PBP
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cargoArgs = Bun.argv.slice(2);
const profile = outputProfile(cargoArgs);
const builtEboot = join(root, "runtime/target/mipsel-sony-psp", profile, "EBOOT.PBP");
const outRoot = join(root, "dist/psp-diag");
const outDir = join(outRoot, "PSP/GAME/dreamcart-diag");
const outEboot = join(outDir, "EBOOT.PBP");

function usage(): void {
  console.log("Usage: bun run psp:diag [cargo-psp args]\n");
  console.log("Builds a minimal real-device boot/GU diagnostic EBOOT:");
  console.log("  dist/psp-diag/PSP/GAME/dreamcart-diag/EBOOT.PBP\n");
  console.log("Copy dist/psp-diag/PSP to the root of a PSP memory stick.");
  console.log("Example: bun run psp:diag -- --release");
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

console.log("Building PSP real-device diagnostic EBOOT...");
await $`bun ${join(root, "runtime/build.ts")} ${cargoArgs}`.env({
  ...process.env,
  PSPJS_DIAG_MODE: "boot",
  PSPJS_GAME: process.env.PSPJS_GAME ?? "raw-snake.js",
});

if (!existsSync(builtEboot)) {
  console.error(`expected PSP output was not created: ${builtEboot}`);
  process.exit(1);
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(builtEboot, outEboot);

console.log(`output: ${outEboot}`);
console.log("Copy dist/psp-diag/PSP to the root of the PSP memory stick.");

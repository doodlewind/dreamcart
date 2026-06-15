// One-command launcher: build + run a game on the Web, PSP, or 3DS emulator.
//   bun run play web            # playground (pick a game from the list)
//   bun run play web fw-maze    # playground, jump straight to a game
//   bun run play psp tetris     # build EBOOT + launch PPSSPP
//   bun run play 3ds fw-rpg     # build .3dsx + launch a 3DS emulator
import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { startServer } from "../web/serve.ts";

const root = new URL("..", import.meta.url).pathname;
const [platform, gameArg] = Bun.argv.slice(2);

function listGames(): string[] {
  const raw = readdirSync(root + "runtime/src/game").filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
  const fw = readdirSync(root + "framework/games").filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3));
  return Array.from(new Set([...raw, ...fw])).sort();
}
function resolveGame(name?: string): string | null {
  if (!name) return null;
  const n = name.replace(/\.(js|ts)$/, "");
  return listGames().includes(n) ? n : null;
}
const isFw = (n: string) => existsSync(root + "framework/games/" + n + ".ts");

function usage(): void {
  console.log("Usage: bun run play <web|psp|3ds> [game]\n");
  console.log("  web        playground; pick a game from the list (optional [game] to jump to one)");
  console.log("  psp <game> build EBOOT.PBP and launch PPSSPP");
  console.log("  3ds <game> build .3dsx and launch a 3DS emulator (Azahar/Citra/...)");
  console.log("\nGames: " + listGames().join(", "));
}

if (!platform || !["web", "psp", "3ds"].includes(platform)) {
  usage();
  process.exit(platform ? 1 : 0);
}

// Make sure framework game bundles (runtime/src/game/fw-*.js) are current.
async function ensureBundles(): Promise<void> {
  await $`bun ${root}framework/build.ts`.quiet().nothrow();
}

if (gameArg && !resolveGame(gameArg)) {
  console.error("unknown game: " + gameArg);
  usage();
  process.exit(1);
}

if (platform === "web") {
  await ensureBundles();
  const game = resolveGame(gameArg);
  const port = Number(process.env.PORT ?? 8123);
  await startServer(port); // builds manifest + starts Bun.serve (keeps process alive)
  const url = `http://localhost:${port}/` + (game ? `?game=${game}.js` : "");
  console.log("opening " + url);
  await $`open ${url}`.nothrow();
  console.log("Press Ctrl-C to stop the server.");
} else if (platform === "psp") {
  const game = resolveGame(gameArg) ?? "snake";
  if (isFw(game)) await ensureBundles();
  if (!existsSync("/Applications/PPSSPPSDL.app")) {
    console.error("PPSSPP not found. Install it: brew install --cask ppsspp");
    process.exit(1);
  }
  console.log("building PSP EBOOT for " + game + " ...");
  await $`bun ${root}runtime/build.ts`.env({ ...process.env, PSPJS_GAME: game + ".js" });
  const eboot = root + "runtime/target/mipsel-sony-psp/debug/EBOOT.PBP";
  console.log("launching PPSSPP: " + game);
  await $`open -a PPSSPPSDL ${eboot}`.nothrow();
} else {
  // 3ds
  const game = resolveGame(gameArg) ?? "snake";
  if (isFw(game)) await ensureBundles();
  console.log("building 3DS .3dsx for " + game + " ...");
  await $`bun ${root}runtime-3ds/build.ts`.env({ ...process.env, PSPJS_GAME: game + ".js" });
  const dsx = root + "runtime-3ds/psp-js-3ds.3dsx";
  const dirs = ["/Applications", `${process.env.HOME}/Applications`];
  let emuApp = "";
  for (const e of ["Azahar", "Lime3DS", "Citra", "Panda3DS"]) {
    for (const d of dirs) if (existsSync(`${d}/${e}.app`)) { emuApp = `${d}/${e}.app`; break; }
    if (emuApp) break;
  }
  if (emuApp) {
    console.log("launching " + emuApp.split("/").pop() + ": " + game);
    await $`open -a ${emuApp} ${dsx}`.nothrow();
  } else {
    console.log("\nBuilt: " + dsx);
    console.log("No 3DS emulator found. Run `bun run bootstrap` to install Azahar, or grab it");
    console.log("from https://azahar-emu.org, then: open -a Azahar " + dsx);
  }
}

// Bundle each framework game (framework inlined) into a single IIFE the
// PSP/Web/3DS hosts embed and eval. Output -> runtime/src/game/<name>.js.
// Games are authored in plain JS (framework/games/*.js) and import the TS SDK
// from framework/src; Bun resolves the .ts SDK while bundling the .js entry.
// Run: bun framework/build.ts
import { readdirSync, mkdirSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const gamesDir = here + "games/";
const outDir = here + "../runtime/src/game/";
mkdirSync(outDir, { recursive: true });

const entrypoints = readdirSync(gamesDir)
  .filter((f) => f.endsWith(".js")) // authored game sources (not tsconfig.json etc.)
  .map((f) => gamesDir + f);

if (entrypoints.length === 0) {
  console.log("no framework games (framework/games/*.js)");
  process.exit(0);
}

const result = await Bun.build({
  entrypoints,
  outdir: outDir,
  format: "iife", // self-contained, sets globalThis.frame at run time
  target: "browser", // leaves bare globals (gfx/log) as global refs
  naming: "[name].js",
  minify: false,
});

if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}
console.log("bundled", entrypoints.length, "framework game(s) -> runtime/src/game/");

// Bundle each framework game (framework inlined) into a single IIFE the
// PSP/Web/3DS hosts embed and eval. Output -> runtime/src/game/<name>.js.
// Games are authored in plain JS (framework/games/*.js) and import the TS SDK
// from framework/src; Bun resolves the .ts SDK while bundling the .js entry.
// Run: bun framework/build.ts
import { readdirSync, mkdirSync, existsSync } from "node:fs";
import { unpack, subset } from "./bake/dcpak";

const here = new URL(".", import.meta.url).pathname;
const gamesDir = here + "games/";
const outDir = here + "../runtime/src/game/";
const storePath = here + "src/assets.dcstore";
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

// Per-game asset pack: subset the binary master store (assets.dcstore) into a
// <name>.dcpak holding only the blobs whose key string survives into the bundle.
// Bun (minify:false) keeps the dc*('module:path') key literals verbatim, so an
// includes() check tree-shakes the assets exactly like the old base64 modules did.
// Every game gets a pack (empty when it imports no baked assets) so each host has
// a uniform artifact to load next to <name>.js.
// Merge the committed master store (assets.dcstore: gltf + CC0 box) with the gitignored
// private store (assets-private.dcstore: copyrighted BSP maps baked locally) so a per-game
// pack can pull blobs from either. The private store is simply absent in clean checkouts/CI.
const privateStorePath = here + "src/assets-private.dcstore";
const loadStore = async (p: string) => (existsSync(p) ? unpack(new Uint8Array(await Bun.file(p).arrayBuffer())) : []);
const store = [...(await loadStore(storePath)), ...(await loadStore(privateStorePath))];
// Match the QUOTED literal form (dc*("module:key") / '...') rather than the bare
// key, so a key can never be a substring of another key and over-include its blob.
// Keys never contain quotes, so the bounded match has no false positives or
// negatives under Bun's non-minified output (which preserves the literals verbatim).
const presentIn = (bundle: string, key: string): boolean =>
  bundle.includes(`"${key}"`) || bundle.includes(`'${key}'`);
for (const entry of entrypoints) {
  const name = entry.slice(gamesDir.length, -3); // strip dir + ".js"
  const bundle = await Bun.file(outDir + name + ".js").text();
  const pak = subset(store, (key) => presentIn(bundle, key));
  await Bun.write(outDir + name + ".dcpak", pak);
  const used = store.filter((b) => presentIn(bundle, b.key)).length;
  if (used > 0) console.log(`  ${name}.dcpak: ${used} blob(s), ${(pak.length / 1024).toFixed(1)} KB`);
}

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
const store = existsSync(storePath) ? unpack(new Uint8Array(await Bun.file(storePath).arrayBuffer())) : [];
// Match the QUOTED literal form (dc*("module:key") / '...') rather than the bare
// key, so a key can never be a substring of another key and over-include its blob.
// Keys never contain quotes, so the bounded match has no false positives or
// negatives under Bun's non-minified output (which preserves the literals verbatim).
const quoted = (bundle: string, lit: string): boolean =>
  bundle.includes(`"${lit}"`) || bundle.includes(`'${lit}'`);
// A baked scene is loaded by its BASE key — loadScene("racing3d") — and the three
// blob keys ("racing3d:scene.meta"/".xforms"/".colliders") are built by runtime
// concatenation, so they never appear as literals in the bundle. Treat a scene
// blob as present when this bundle contains the LITERAL loadScene() call for its
// base key. Matching the full call shape (not base-quoted + a bare "loadScene"
// substring anywhere) means a game that merely quotes a string equal to a scene
// base key while importing loadScene for an unrelated scene can never pull in
// foreign scene blobs. Both quote styles are matched (Bun emits "..."; source may
// be '...'). (Asset blobs keep the exact-literal rule below; only the ":scene.*"
// family is base-matched.)
const SCENE_SUFFIX = /:scene\.(meta|xforms|colliders)$/;
const loadsScene = (bundle: string, base: string): boolean =>
  bundle.includes(`loadScene("${base}"`) || bundle.includes(`loadScene('${base}'`);
const presentIn = (bundle: string, key: string): boolean => {
  const m = key.match(SCENE_SUFFIX);
  if (m) {
    const base = key.slice(0, key.length - m[0].length);
    return loadsScene(bundle, base);
  }
  return quoted(bundle, key);
};
for (const entry of entrypoints) {
  const name = entry.slice(gamesDir.length, -3); // strip dir + ".js"
  const bundle = await Bun.file(outDir + name + ".js").text();
  const pak = subset(store, (key) => presentIn(bundle, key));
  await Bun.write(outDir + name + ".dcpak", pak);
  const used = store.filter((b) => presentIn(bundle, b.key)).length;
  if (used > 0) console.log(`  ${name}.dcpak: ${used} blob(s), ${(pak.length / 1024).toFixed(1)} KB`);
}

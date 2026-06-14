// Build the 3DS .3dsx via the devkitpro/devkitarm Docker image (no host
// toolchain / sudo). Select the game with PSPJS_GAME. Run: bun runtime-3ds/build.ts
import { $ } from "bun";

const here = new URL(".", import.meta.url).pathname; // .../runtime-3ds/
const root = new URL("..", import.meta.url).pathname; // repo root
const game = process.env.PSPJS_GAME ?? "snake.js";
const IMG = "devkitpro/devkitarm:latest";

console.log("3DS build: " + game);
await $`bun ${here}gen-game.ts ${game}`;
await $`docker run --rm -v ${root.replace(/\/$/, "")}:/work -w /work/runtime-3ds ${IMG} bash -lc ${"make -j8"}`;
console.log("output: runtime-3ds/psp-js-3ds.3dsx");
await $`file ${here}psp-js-3ds.3dsx`;

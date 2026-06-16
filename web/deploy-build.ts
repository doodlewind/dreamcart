// Assembles web/site/ — the directory deployed to Cloudflare Pages (dreamcart.games).
//   /            -> WIP landing page (web/landing.html), reveals nothing.
//   /play/       -> the DreamCart Playground (the simulator), fully functional.
// Run: bun web/deploy-build.ts
import { rm, mkdir, copyFile } from "node:fs/promises";
import { buildGames } from "./build-games.ts";

const here = new URL(".", import.meta.url).pathname; // the web/ dir
const out = here + "site/";
const play = out + "play/";

// Always refresh the game manifest so the deployed simulator is current.
const n = await buildGames();

await rm(out, { recursive: true, force: true });
await mkdir(play, { recursive: true });

// Landing (WIP) at the root.
await copyFile(here + "landing.html", out + "index.html");

// Simulator + its assets under /play/.
for (const f of ["index.html", "engine.js", "games.generated.js"]) {
  await copyFile(here + f, play + f);
}

console.log(`web/site assembled: WIP landing at /, simulator at /play/ (${n} games)`);

// Syncs the DreamCart engine + game manifest into the Android app's assets.
//   bun android/sync-assets.ts
//
// The Android runtime reuses the *exact* isomorphic Web engine (web/engine.js):
// the top screen is a WebView that runs that engine, so the same JS games run
// unchanged here as on Web / PSP / 3DS. This copies the engine and a freshly
// built games manifest into android/app/src/main/assets/.
//
// Framework games must be bundled first (`bun framework/build.ts`); raw games
// need no build. buildGames() reads whatever is in runtime/src/game/.
import { cpSync, mkdirSync } from "node:fs";
import { buildGames } from "../web/build-games.ts";

const here = new URL(".", import.meta.url).pathname; // android/
const web = here + "../web/";
const assets = here + "app/src/main/assets/";

mkdirSync(assets, { recursive: true });

const n = await buildGames(); // writes web/games.generated.js
cpSync(web + "games.generated.js", assets + "games.generated.js");
cpSync(web + "engine.js", assets + "engine.js");

console.log(`synced engine.js + ${n} games -> ${assets}`);

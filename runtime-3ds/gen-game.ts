// Embeds the selected game .js into source/game_js.h as a NUL-terminated byte
// array (JS_Eval needs input[len] == '\0'). Usage: bun runtime-3ds/gen-game.ts [game.js]
const here = new URL(".", import.meta.url).pathname;
const game = Bun.argv[2] || process.env.PSPJS_GAME || "raw-snake.js";
const src = await Bun.file(here + "../runtime/src/game/" + game).text();
const bytes = new TextEncoder().encode(src);

let body = "";
for (let i = 0; i < bytes.length; i++) {
  body += bytes[i] + ",";
  if ((i & 31) === 31) body += "\n";
}
const out =
  "// AUTO-GENERATED from runtime/src/game/" + game + " by gen-game.ts\n" +
  "static const unsigned char GAME_JS[] = {\n" + body + "0\n};\n" +
  "static const unsigned GAME_JS_LEN = " + bytes.length + ";\n";
await Bun.write(here + "source/game_js.h", out);
console.log("embedded", game, "(" + bytes.length + " bytes) -> source/game_js.h");

// Also embed the game's binary asset pack (see docs/dcpak-format.md). main.c
// exposes it to JS as the global ArrayBuffer __dcpak before eval; empty for games
// with no baked assets (and raw demos).
const pakPath = here + "../runtime/src/game/" + game.replace(/\.js$/, ".dcpak");
const pakBytes = (await Bun.file(pakPath).exists())
  ? new Uint8Array(await Bun.file(pakPath).arrayBuffer())
  : new Uint8Array(0);
let pbody = "";
for (let i = 0; i < pakBytes.length; i++) {
  pbody += pakBytes[i] + ",";
  if ((i & 31) === 31) pbody += "\n";
}
const pout =
  "// AUTO-GENERATED from runtime/src/game/" + game.replace(/\.js$/, ".dcpak") + " by gen-game.ts\n" +
  "static const unsigned char GAME_DCPAK[] = {\n" + pbody + "0\n};\n" +
  "static const unsigned GAME_DCPAK_LEN = " + pakBytes.length + ";\n";
await Bun.write(here + "source/game_dcpak.h", pout);
console.log("embedded dcpak (" + pakBytes.length + " bytes) -> source/game_dcpak.h");

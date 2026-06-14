// Embeds the selected game .js into source/game_js.h as a NUL-terminated byte
// array (JS_Eval needs input[len] == '\0'). Usage: bun runtime-3ds/gen-game.ts [game.js]
const here = new URL(".", import.meta.url).pathname;
const game = Bun.argv[2] || process.env.PSPJS_GAME || "snake.js";
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

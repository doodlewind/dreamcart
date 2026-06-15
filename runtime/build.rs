//! Selects which JS game gets embedded into the EBOOT at build time.
//!
//! Set `PSPJS_GAME` to a filename in `src/game/` (default `raw-snake.js`):
//!   PSPJS_GAME=raw-pong.js bun runtime/build.ts
//!
//! The chosen file is copied to `$OUT_DIR/game.js` with a trailing NUL byte so
//! `JS_Eval` (which requires `input[len] == '\0'`) can use it directly.

use std::path::Path;
use std::{env, fs};

fn main() {
    // Default to the raw low-level Snake demo (a tracked file; framework game
    // bundles are gitignored and require `bun framework/build.ts` first).
    let game = env::var("PSPJS_GAME").unwrap_or_else(|_| "raw-snake.js".to_string());

    let game_dir = Path::new("src/game");
    let src = game_dir.join(&game);
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("game.js");

    let mut code = fs::read_to_string(&src)
        .unwrap_or_else(|e| panic!("could not read game src/game/{}: {}", game, e));
    code.push('\0'); // NUL-terminate for JS_Eval
    fs::write(&out, code).unwrap();

    // Rebuild when the selection changes or any game file is edited.
    println!("cargo:rustc-env=PSPJS_GAME={}", game);
    println!("cargo:rerun-if-env-changed=PSPJS_GAME");
    if let Ok(entries) = fs::read_dir(game_dir) {
        for e in entries.flatten() {
            println!("cargo:rerun-if-changed={}", e.path().display());
        }
    }
}

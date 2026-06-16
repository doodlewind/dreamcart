// Cross-host contract test: the controller button bitmask MUST be identical on
// every platform, because the SAME game source runs unchanged on Web, PSP and
// 3DS. The canonical definition is `Btn` in framework/src/input.ts; this test
// asserts the independent host copies that cannot import it (the Web engine's
// plain-script literal and the 3DS C host's key map) never drift from it.
//   bun framework/test/contract.ts
import { readdirSync } from "node:fs";
import { Btn } from "../src/input";

const here = new URL(".", import.meta.url).pathname;
const root = here + "../../";

// Canonical, normalized to UPPERCASE names (input.ts uses Capitalized keys).
const canonical: Record<string, number> = {};
for (const [k, v] of Object.entries(Btn)) canonical[k.toUpperCase()] = v as number;

function parsePairs(text: string, re: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(re)) out[m[1].toUpperCase()] = parseInt(m[2], 16);
  return out;
}

// web/engine.js: `var BTN = { SELECT: 0x01, START: 0x08, ... }`
const engineSrc = await Bun.file(root + "web/engine.js").text();
const engineBlock = engineSrc.slice(engineSrc.indexOf("var BTN"), engineSrc.indexOf("};", engineSrc.indexOf("var BTN")));
const engine = parsePairs(engineBlock, /(\w+)\s*:\s*(0x[0-9a-fA-F]+)/g);

// runtime-3ds/source/main.c: `if (k & KEY_UP) mask |= 0x10; // UP` (value, then name)
const cSrc = await Bun.file(root + "runtime-3ds/source/main.c").text();
const cHost: Record<string, number> = {};
for (const m of cSrc.matchAll(/mask\s*\|=\s*(0x[0-9a-fA-F]+);\s*\/\/\s*(\w+)/g)) cHost[m[2].toUpperCase()] = parseInt(m[1], 16);

// android Kotlin host: `object Btn { const val SELECT = 0x01, ... }` in Runtime.kt
const ktSrc = await Bun.file(root + "android/app/src/main/java/games/dreamcart/Runtime.kt").text();
const ktBlock = ktSrc.slice(ktSrc.indexOf("object Btn"), ktSrc.indexOf("}", ktSrc.indexOf("object Btn")));
const kotlin = parsePairs(ktBlock, /const val (\w+)\s*=\s*(0x[0-9a-fA-F]+)/g);

const hosts: { name: string; map: Record<string, number> }[] = [
  { name: "web/engine.js", map: engine },
  { name: "runtime-3ds/source/main.c", map: cHost },
  { name: "android/.../Runtime.kt", map: kotlin },
];

let problems = 0;
const names = Object.keys(canonical);
for (const host of hosts) {
  for (const n of names) {
    if (!(n in host.map)) { console.log(`FAIL  ${host.name}: missing ${n}`); problems++; continue; }
    if (host.map[n] !== canonical[n]) {
      console.log(`FAIL  ${host.name}: ${n} = 0x${host.map[n].toString(16)} != canonical 0x${canonical[n].toString(16)}`);
      problems++;
    }
  }
  // any host button that the canonical set doesn't define is also drift
  for (const n of Object.keys(host.map)) if (!(n in canonical)) { console.log(`FAIL  ${host.name}: extra ${n}`); problems++; }
}

if (problems === 0) console.log(`PASS  button bitmask consistent across canonical + ${hosts.length} host(s) (${names.length} buttons)`);
else console.log(`\n${problems} button-contract mismatch(es)`);

// --- Raw low-level demos ---
// Raw games are eval'd as a single string by the hosts, so they can't `import`
// the canonical Btn — instead they declare their own button constants. The
// convention is `BTN_<NAME> = 0x<hex>` (anchored on `= 0x` so prose like
// "UP/DOWN to move" never matches). Assert every declared constant matches Btn.
const gameDir = root + "runtime/src/game/";
const rawFiles = readdirSync(gameDir).filter((f) => f.startsWith("raw-") && f.endsWith(".js")).sort();
let rawConstants = 0;
for (const f of rawFiles) {
  const src = await Bun.file(gameDir + f).text();
  let found = 0;
  for (const m of src.matchAll(/\bBTN_([A-Z]+)\s*=\s*(0x[0-9a-fA-F]+)/g)) {
    const name = m[1];
    const val = parseInt(m[2], 16);
    found++;
    rawConstants++;
    if (!(name in canonical)) { console.log(`FAIL  ${f}: BTN_${name} is not a canonical button`); problems++; }
    else if (canonical[name] !== val) {
      console.log(`FAIL  ${f}: BTN_${name} = 0x${val.toString(16)} != canonical 0x${canonical[name].toString(16)}`);
      problems++;
    }
  }
  // A raw game that uses input but declares no recognized constants is likely
  // using an unchecked convention — surface it rather than silently skipping.
  if (found === 0 && /\bbuttons\b/.test(src)) console.log(`NOTE  ${f}: reads buttons but declares no BTN_* constants (not enforced)`);
}
if (problems === 0) console.log(`PASS  ${rawConstants} raw-game button constant(s) across ${rawFiles.length} demo(s) match canonical`);

// --- 3D layer: determinism + wire-format parity ---
// (1) The shared 3D math/SDK must use NO non-deterministic transcendentals: those
// differ in the last ULP between QuickJS (PSP/3DS) and the browser engine, which
// would break the byte-exact draw-list goldens. math.ts ships its own dsin/dcos.
const TRIG = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|hypot)\b/;
const detFiles = ["math", "g3d", "scene3d", "mesh"];
let trigProblems = 0;
for (const f of detFiles) {
  const p = root + `framework/src/${f}.ts`;
  const file = Bun.file(p);
  if (!(await file.exists())) continue;
  const src = await file.text();
  const m = src.match(TRIG);
  if (m) { console.log(`FAIL  framework/src/${f}.ts uses non-deterministic ${m[0]} (use math.ts dsin/dcos)`); trigProblems++; problems++; }
}
if (trigProblems === 0) console.log(`PASS  3D SDK uses only deterministic math (no Math.sin/cos/tan/atan across ${detFiles.length} files)`);

// (2) The 3D wire constants (opcodes / format bits / magic) are defined in
// framework/src/g3d.ts and must be byte-identical in every host that implements
// `g3d`. Hosts are parsed only once they've been wired (contain DC3D_MAGIC).
const NAMES = ["DC3D_MAGIC", "DC3D_VERSION", "OP_SET_CAMERA", "OP_DRAW", "OP_IMM_TRIS", "OP_BIND_TEXTURE", "OP_SET_LIGHTS", "OP_DRAW_SKINNED", "FMT_POS", "FMT_COLOR", "FMT_NORMAL", "FMT_UV", "FMT_WEIGHTS"];
// Match NAME then the next 0x-literal on the SAME line, across all three host
// syntaxes: JS `var NAME = 0x..`, C `#define NAME 0x..`, Rust `const NAME: u32 =
// 0x4443_3344;`. `[^\n]*?` (not `[^0-9xX]`) is needed so the digits in Rust's
// `: u32 =` don't block the match — otherwise the regex falls back to the prose
// comment and validates a comment against itself instead of the real const.
// Underscores in the literal (Rust digit separators) are stripped before parse.
const constRe = new RegExp(`\\b(${NAMES.join("|")})\\b[^\\n]*?(0x[0-9a-fA-F_]+)`, "g");
const parse3d = (text: string): Record<string, number> => {
  const out: Record<string, number> = {};
  // last occurrence wins, so the real Rust `const` (which follows its doc comment)
  // is what gets validated, not the comment.
  for (const m of text.matchAll(new RegExp(constRe.source, "g"))) out[m[1]] = parseInt(m[2].replace(/_/g, ""), 16);
  return out;
};
const g3dSrc = await Bun.file(root + "framework/src/g3d.ts").text();
const canonical3d = parse3d(g3dSrc);
const host3dFiles = ["web/engine.js", "runtime-3ds/source/main.c", "runtime/src/gfx3d.rs"];
let wired = 0;
for (const rel of host3dFiles) {
  const file = Bun.file(root + rel);
  if (!(await file.exists())) continue;
  const src = await file.text();
  if (!src.includes("DC3D_MAGIC")) { console.log(`NOTE  ${rel}: 3D wire constants not yet wired (skipped)`); continue; }
  wired++;
  const map = parse3d(src);
  for (const n of NAMES) {
    if (canonical3d[n] === undefined) continue;
    if (map[n] === undefined) { console.log(`FAIL  ${rel}: missing 3D const ${n}`); problems++; }
    else if (map[n] !== canonical3d[n]) { console.log(`FAIL  ${rel}: ${n} = 0x${map[n].toString(16)} != g3d.ts 0x${canonical3d[n].toString(16)}`); problems++; }
  }
}
console.log(`PASS  3D wire constants defined in g3d.ts (${Object.keys(canonical3d).length}) — ${wired} host(s) wired so far`);

process.exit(problems ? 1 : 0);

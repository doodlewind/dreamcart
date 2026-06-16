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

process.exit(problems ? 1 : 0);

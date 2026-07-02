// Spec drift guard — run with `bun run contract` (exit 0 = green).
//
//  (a) Regenerates core/src/spec.rs IN-MEMORY from spec/spec.ts and
//      byte-compares against the committed file: TS and Rust constants can
//      never drift. Fix = `bun spec/gen-rust.ts` + commit.
//  (b) Round-trips the styles.bin encoder/decoder over a table exercising
//      every feature (variants, transition, all three value kinds).
//  (c) While psp-ui lives inside the dreamcart repo: greps the dreamcart
//      sources our constants were copied from (BTN masks, dcpak magic) so an
//      upstream change is caught. Skipped silently after extraction.

import { generateRust } from "../spec/gen-rust.ts";
import {
  abgr,
  animBit,
  BTN,
  DCPAK_MAGIC,
  decodeStyleTable,
  encodeStyleTable,
  ENUMS,
  f32Bits,
  PROP,
  TRANSITION_MASK_ALL,
  type StyleRecord,
} from "../spec/spec.ts";

let failed = false;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failed = true;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- (a) generated spec.rs is in sync ---------------------------------------

const specRsPath = new URL("../core/src/spec.rs", import.meta.url).pathname;
const committed = await Bun.file(specRsPath).text().catch(() => null);
const expected = generateRust();
check(
  committed !== null && committed === expected,
  "core/src/spec.rs matches spec.ts",
  "run `bun spec/gen-rust.ts` and commit the result",
);

// ---- (b) style table encoder/decoder round-trip ------------------------------

const table: StyleRecord[] = [
  // full-feature record: all variants + transition + all three value kinds
  {
    base: [
      { prop: PROP.width, value: f32Bits(120) },
      { prop: PROP.bgColor, value: abgr(30, 41, 59) },
      { prop: PROP.flexDir, value: ENUMS.FlexDir.Col },
    ],
    focus: [{ prop: PROP.bgColor, value: abgr(129, 140, 248) }],
    active: [{ prop: PROP.scale, value: f32Bits(0.95) }],
    transition: {
      mask: (1 << animBit("bgColor")) | (1 << animBit("scale")),
      durMs: 150,
      delayMs: 16,
      easing: ENUMS.Easing.EaseOut,
    },
  },
  // base-only record
  { base: [{ prop: PROP.opacity, value: f32Bits(0.5) }] },
  // transition-all, no base (focus-only)
  {
    focus: [{ prop: PROP.translateX, value: f32Bits(8) }],
    transition: { mask: TRANSITION_MASK_ALL, durMs: 300, delayMs: 0, easing: ENUMS.Easing.Spring },
  },
  // empty record (valid: flags = 0)
  {},
];

// Key order differs between literal input and decoder output; compare a
// canonical projection instead of raw JSON.
function canon(t: StyleRecord[]) {
  return JSON.stringify(
    t.map((s) => ({
      base: s.base ?? null,
      focus: s.focus ?? null,
      active: s.active ?? null,
      transition: s.transition ?? null,
    })),
  );
}

try {
  const bytes = encodeStyleTable(table);
  const back = decodeStyleTable(bytes);
  check(
    canon(back) === canon(table),
    "styles.bin encode/decode round-trip",
    "decoded table differs from input",
  );
  // spot-check the pinned header bytes
  const dv = new DataView(bytes.buffer);
  check(dv.getUint32(0, true) === 0x54534344, "styles.bin magic bytes 'DCST'");
  check(dv.getUint16(6, true) === table.length, "styles.bin styleCount");
} catch (e) {
  check(false, "styles.bin encode/decode round-trip", String(e));
}

// ---- (c) upstream constant greps (dreamcart repo only) -----------------------

const engineJs = await Bun.file(
  new URL("../../web/engine.js", import.meta.url).pathname,
).text().catch(() => null);
if (engineJs !== null) {
  for (const [name, mask] of Object.entries(BTN)) {
    if (name === "LTRIGGER" || name === "RTRIGGER") continue; // engine.js maps no triggers
    const re = new RegExp(`${name}: 0x0*${mask.toString(16)}`, "i");
    check(re.test(engineJs), `BTN.${name} matches web/engine.js`);
  }
}
const dcpakTs = await Bun.file(
  new URL("../../framework/bake/dcpak.ts", import.meta.url).pathname,
).text().catch(() => null);
if (dcpakTs !== null) {
  check(dcpakTs.includes("0x4b504344") && DCPAK_MAGIC === 0x4b504344, "DCPAK magic matches framework/bake/dcpak.ts");
}

if (failed) {
  console.error("\ncontract: FAILED");
  process.exit(1);
}
console.log("\ncontract: all green");

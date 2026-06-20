// Packs White Album 2 raw game-script files (the airport flashback + classroom
// prologue) into a compact, typed VN script module: framework/src/wa2-script.ts.
//
// Source: the WA2 text dataset (raw/*.txt). Each raw file is ONE physical line =
// comma-separated fields. Furigana (<R base|reading>) survives ONLY in raw/, so
// we parse raw/ directly (the processed/ copy strips ruby). See the format notes
// inline below. Run: bun framework/bake/bake-wa2.ts
//
// Output drives both the VN game (framework/games/wa2.js) and the font baker
// (bake-wa2-font.ts), which subsets a Japanese glyph atlas to exactly the
// codepoints this script uses.
import { readFileSync } from "node:fs";

const DATASET = process.env.WA2_DATASET ?? "/Users/evan/code/wa2_dataset_script";
const RAW = DATASET + "/raw/";
const OUT = new URL("../src/wa2-script.ts", import.meta.url).pathname;

// The scene files to pack, in story order, with a short display title.
// 1001 airport cold-open -> 1002 rooftop / WHITE ALBUM -> 1003 overheard singing
// -> 1004 classroom: Setsuna joins the music club. A self-contained opening.
const SCENES: { id: string; title: string }[] = [
  { id: "1001", title: "雪の空港" },
  { id: "1002", title: "WHITE ALBUM" },
  { id: "1003", title: "屋上の歌声" },
  { id: "1004", title: "放課後の教室" },
];

type Kind = 0 | 1 | 2; // 0 narration, 1 speech 「」, 2 special 『』
interface Seg {
  t: string;
  r?: string;
}
interface Line {
  sp: string;
  k: Kind;
  segs: Seg[];
}
interface Scene {
  id: string;
  title: string;
  lines: Line[];
}

// --- Field classification --------------------------------------------------
const isCommand = (f: string): boolean =>
  f === "" ||
  /^[A-Za-z0-9_.]+$/.test(f) || // mv01, CATCH, sepia.AMP, v100200_chr.tga, 1002, ...
  /\.(tga|ani|amp|bmp|png|gif)$/i.test(f) || // ギター.tga, スポットライト.ani (asset refs)
  f === "grp" ||
  f === "bak";

const BAD_NAME_PUNCT = /[。、，！…‥・「」『』（）()\n　 ]/u;
// A "speaker name" is the short, punctuation-free field right before a dialogue
// field (春希 / 雪菜 / かずさ / 武也 / 軽音部員 / 男子生徒１ ...). ？？？ is the
// canonical "speaker not yet revealed" placeholder and is kept as-is.
function isName(f: string): boolean {
  if (f === "？？？") return true;
  const len = [...f].length;
  return len >= 1 && len <= 6 && !BAD_NAME_PUNCT.test(f) && /\S/.test(f);
}

const isDialogue = (f: string): Kind | null =>
  f.startsWith("「") ? 1 : f.startsWith("『") ? 2 : null;

// Strip leftover engine control tags, KEEPING any inner text: style `<S0…>`,
// size `<F16…>`, and standalone waits `<W120>` (these are NOT ruby). Ruby
// `<R base|reading>` is parsed out first, so it never reaches this.
const stripTags = (s: string): string => s.replace(/<[A-Za-z][A-Za-z0-9]*/g, "").replace(/>/g, "");

// Split a text field into ruby/plain segments. `<R空港|ここ>` => {t:"空港", r:"ここ"}.
// In-field hard breaks are the literal 2-char "\n"; keep them as real newlines.
function parseSegs(field: string): Seg[] {
  const text = field.replace(/\\n/g, "\n");
  const segs: Seg[] = [];
  const re = /<R([^|>]*)\|([^>]*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ t: stripTags(text.slice(last, m.index)) });
    segs.push({ t: stripTags(m[1]), r: stripTags(m[2]) });
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ t: stripTags(text.slice(last)) });
  return segs.filter((s) => s.t.length > 0);
}

// --- Parse one scene file --------------------------------------------------
function parseScene(id: string, title: string): Scene {
  const path = RAW + id + ".txt";
  const raw = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  const fields = raw.split(",");

  // First pass: drop command/resource tokens and consume grp/bak payloads, to a
  // flat token stream of {text} fields (dialogue + narration + name candidates).
  const toks: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f === "grp" || f === "bak") {
      i++; // swallow the directive's argument field
      continue;
    }
    if (isCommand(f)) continue;
    toks.push(f);
  }

  // Second pass: pair speaker names with the dialogue they precede.
  const lines: Line[] = [];
  for (let i = 0; i < toks.length; i++) {
    const f = toks[i];
    const kind = isDialogue(f);
    if (kind != null) {
      // speaker = previous token if it looks like a name (and wasn't already a
      // line we emitted). We peek back at lines: if the immediately previous
      // emitted line was a 1-seg narration that is name-like, lift it to speaker.
      let sp = "";
      const prev = lines[lines.length - 1];
      if (prev && prev.k === 0 && prev.segs.length === 1 && !prev.segs[0].r && isName(prev.segs[0].t)) {
        sp = prev.segs[0].t;
        lines.pop();
      }
      lines.push({ sp, k: kind, segs: parseSegs(f) });
    } else {
      lines.push({ sp: "", k: 0, segs: parseSegs(f) });
    }
  }
  return { id, title, lines };
}

// --- Drive ----------------------------------------------------------------
const scenes = SCENES.map((s) => parseScene(s.id, s.title));

// Collect the glyph subsets. Base = every char that renders at full size (all
// segment base text + speaker names). Ruby = chars used only as small readings.
const baseSet = new Set<string>();
const rubySet = new Set<string>();
for (const sc of scenes) {
  for (const ln of sc.lines) {
    for (const ch of ln.sp) baseSet.add(ch);
    for (const seg of ln.segs) {
      for (const ch of seg.t) if (ch !== "\n") baseSet.add(ch);
      if (seg.r) for (const ch of seg.r) if (ch !== "\n") rubySet.add(ch);
    }
  }
}
// Ruby readings should always be renderable at base size too (a few use kanji),
// so fold the ruby set into the base set; the ruby atlas is the kana-heavy subset.
for (const ch of rubySet) baseSet.add(ch);

const sortCp = (a: string, b: string) => a.codePointAt(0)! - b.codePointAt(0)!;
const baseChars = [...baseSet].sort(sortCp).join("");
const rubyChars = [...rubySet].sort(sortCp).join("");

// --- Emit the typed module -------------------------------------------------
const json = JSON.stringify(scenes);
const totalLines = scenes.reduce((n, s) => n + s.lines.length, 0);
let out = `// AUTO-GENERATED by framework/bake/bake-wa2.ts — do not edit by hand.
// White Album 2 prologue (airport flashback + classroom) packed from raw/*.txt.
// k: 0 = narration, 1 = speech 「」, 2 = special 『』. seg.r = furigana reading.
export type VnKind = 0 | 1 | 2;
export interface VnSeg { t: string; r?: string }
export interface VnLine { sp: string; k: VnKind; segs: VnSeg[] }
export interface VnScene { id: string; title: string; lines: VnLine[] }

export const WA2_SCENES: VnScene[] = ${json};

// The exact glyph subsets this script uses (drives bake-wa2-font.ts).
export const WA2_BASE_CHARS = ${JSON.stringify(baseChars)};
export const WA2_RUBY_CHARS = ${JSON.stringify(rubyChars)};
`;
await Bun.write(OUT, out);

console.log(`bake-wa2: ${scenes.length} scenes, ${totalLines} lines`);
console.log(`  base glyphs: ${[...baseChars].length}, ruby glyphs: ${[...rubyChars].length}`);
console.log(`  module bytes: ${out.length}`);
for (const s of scenes) console.log(`  ${s.id} ${s.title}: ${s.lines.length} lines`);

// Fetches GoldSrc / CS 1.6 BSP v30 maps (and the WAD texture files they reference) at
// BUILD time and vendors them under assets/vendor/bsp/ for bake-bsp.ts. Pure Bun.
//
// The committed E2E uses the CC0 box.bsp fixture, so NO network is needed for tests.
// These classic maps + WADs are Valve/CS-copyright, so neither the fetched files nor
// their baked modules are committed (all gitignored) — fetched for a local build/demo
// only, like the PSP SDK and the OSM data.
//
// Run:  bun framework/bake/fetch-bsp.ts cs          # the classic CS map batch + WADs
//       bun framework/bake/fetch-bsp.ts de_dust2    # one map (+ deps if a WAD)
//       bun framework/bake/fetch-bsp.ts c1a0        # a self-contained Half-Life map
import { write } from 'bun';

// BSP v30 maps (raw GitHub). de_* / cs_* are WAD-stripped stock maps -> need WADs below.
const MAPS: Record<string, string> = {
  c1a0: 'https://raw.githubusercontent.com/sbuggay/bspview/master/docs/bsp/halflife_c1a0.bsp',
  de_dust2: 'https://raw.githubusercontent.com/hoolzeo/Counter-Strike-1.6/main/cstrike/maps/de_dust2.bsp',
  de_dust: 'https://raw.githubusercontent.com/hoolzeo/Counter-Strike-1.6/main/cstrike/maps/de_dust.bsp',
  cs_assault: 'https://raw.githubusercontent.com/hoolzeo/Counter-Strike-1.6/main/cstrike/maps/cs_assault.bsp',
  de_aztec: 'https://raw.githubusercontent.com/hoolzeo/Counter-Strike-1.6/main/cstrike/maps/de_aztec.bsp',
  cs_office: 'https://raw.githubusercontent.com/hoolzeo/Counter-Strike-1.6/main/cstrike/maps/cs_office.bsp',
  de_inferno: 'https://raw.githubusercontent.com/hoolzeo/Counter-Strike-1.6/main/cstrike/maps/de_inferno.bsp',
  de_nuke: 'https://raw.githubusercontent.com/hoolzeo/Counter-Strike-1.6/main/cstrike/maps/de_nuke.bsp',
  de_train: 'https://raw.githubusercontent.com/hoolzeo/Counter-Strike-1.6/main/cstrike/maps/de_train.bsp',
};

// WAD3 texture archives (GitHub LFS media endpoint — the plain raw path returns a
// 130-byte LFS pointer for these). halflife.wad + cs_dust.wad fully texture de_dust2/de_dust.
const WADS: Record<string, string> = {
  'halflife.wad': 'https://media.githubusercontent.com/media/JJL772/usource-content/master/valve/halflife.wad',
  'cs_dust.wad': 'https://media.githubusercontent.com/media/stevefan1999-personal/svencoop_fastdl/master/cs_dust.wad',
  'decals.wad': 'https://media.githubusercontent.com/media/JJL772/usource-content/master/valve/decals.wad',
  'liquids.wad': 'https://media.githubusercontent.com/media/JJL772/usource-content/master/valve/liquids.wad',
};

// The classic-CS batch the systematic import test runs over.
const CS_BATCH = ['de_dust2', 'de_dust', 'cs_assault', 'de_aztec', 'cs_office', 'de_inferno', 'de_nuke', 'de_train',
  'halflife.wad', 'cs_dust.wad', 'decals.wad', 'liquids.wad'];

const here = new URL('.', import.meta.url).pathname;
const outDir = here + '../../assets/vendor/bsp/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<Uint8Array | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'dreamcart-bsp-import/1.0' }, redirect: 'follow', signal: AbortSignal.timeout(180_000) });
      if (!res.ok) { console.log(`   HTTP ${res.status}`); await sleep(4000); continue; }
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) { console.log(`   ${(err as Error).message}`); await sleep(4000); }
  }
  return null;
}

async function fetchOne(name: string): Promise<boolean> {
  const isWad = name.toLowerCase().endsWith('.wad');
  const url = isWad ? WADS[name] : MAPS[name];
  if (!url) { console.error(`!! unknown ${name}`); return false; }
  console.log(`>> ${name}: ${url}`);
  const buf = await get(url);
  if (!buf || buf.length < 16) { console.error(`   !! download failed`); return false; }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (isWad) {
    const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
    if (magic !== 'WAD3') { console.error(`   !! not a WAD3 (got "${magic}", ${buf.length} B — LFS pointer?)`); return false; }
    await write(outDir + name, buf);
    console.log(`   OK ${name}  (${(buf.length / 1024 / 1024).toFixed(2)} MB, WAD3)`);
  } else {
    if (dv.getInt32(0, true) !== 30) { console.error(`   !! not BSP v30 (version ${dv.getInt32(0, true)})`); return false; }
    await write(outDir + name + '.bsp', buf);
    console.log(`   OK ${name}.bsp  (${(buf.length / 1024 / 1024).toFixed(2)} MB, v30) — Valve/CS map, gitignored`);
  }
  return true;
}

const args = process.argv.slice(2);
const targets = !args.length ? ['c1a0'] : args.includes('cs') ? CS_BATCH : args;
let ok = true;
for (const t of targets) ok = (await fetchOne(t)) && ok;
process.exit(ok ? 0 : 1);

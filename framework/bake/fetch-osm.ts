// Fetches OpenStreetMap data (buildings + roads + parks/water) for a streetscape
// location via the Overpass API and vendors the raw JSON under assets/vendor/osm/.
// This is the provenance / reproducibility step for bake-osm.ts (and retains the
// ODbL source extract, satisfying ODbL §4.6 for redistributed Produced Works).
//
// Pure Bun — no shell, no curl. Run:
//   bun framework/bake/fetch-osm.ts                       # all built-in locations
//   bun framework/bake/fetch-osm.ts etoile                # one built-in location
//   bun framework/bake/fetch-osm.ts myplace 48.87 2.29 48.88 2.30   # custom bbox
//
// Map data © OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright
import { write } from 'bun';

// Public Overpass mirrors, tried in order until one returns JSON. overpass-api.de
// works but rate-limits under load; the others are fallbacks.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Built-in candidate locations: [south, west, north, east] (~250-300 m spans).
const LOCATIONS: Record<string, [number, number, number, number]> = {
  etoile: [48.8718, 2.2918, 48.8758, 2.2982],
  'times-square': [40.7566, -73.9871, 40.7594, -73.9839],
  shibuya: [35.6581, 139.6989, 35.6609, 139.7021],
  // Lujiazui, Shanghai — the supertall trio (Shanghai Tower / SWFC / Jin Mao).
  shanghai: [31.2321, 121.5010, 31.2369, 121.5066],
};

const here = new URL('.', import.meta.url).pathname;
const outDir = here + '../../assets/vendor/osm/';

function query([s, w, n, e]: [number, number, number, number]): string {
  return `[out:json][timeout:90];
(
  way["building"](${s},${w},${n},${e});
  relation["building"]["type"="multipolygon"](${s},${w},${n},${e});
  way["highway"](${s},${w},${n},${e});
  way["leisure"="park"](${s},${w},${n},${e});
  way["natural"="water"](${s},${w},${n},${e});
  way["landuse"~"grass|forest|meadow|recreation_ground"](${s},${w},${n},${e});
);
out geom;`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBbox(name: string, bbox: [number, number, number, number]): Promise<boolean> {
  const data = query(bbox);
  for (const ep of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`>> ${name}: ${ep} (attempt ${attempt})`);
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'dreamcart-osm-bake/1.0' },
          body: 'data=' + encodeURIComponent(data),
          signal: AbortSignal.timeout(120_000),
        });
        const text = await res.text();
        if (res.ok && text.includes('"elements"')) {
          await write(outDir + name + '.json', text);
          const elems = (text.match(/"type"/g) || []).length;
          console.log(`   OK ${name}.json  (${(text.length / 1024) | 0} KB, ~${elems} elements)`);
          return true;
        }
        console.log(`   busy/invalid (HTTP ${res.status})`);
      } catch (err) {
        console.log(`   failed: ${(err as Error).message}`);
      }
      await sleep(5000);
    }
  }
  console.error(`   !! all endpoints failed for ${name}`);
  return false;
}

const argv = process.argv.slice(2);
let ok = true;
if (argv.length >= 5) {
  const [name, s, w, n, e] = argv;
  ok = await fetchBbox(name, [+s, +w, +n, +e]);
} else if (argv.length === 1 && LOCATIONS[argv[0]]) {
  ok = await fetchBbox(argv[0], LOCATIONS[argv[0]]);
} else {
  for (const [name, bbox] of Object.entries(LOCATIONS)) ok = (await fetchBbox(name, bbox)) && ok;
}
process.exit(ok ? 0 : 1);

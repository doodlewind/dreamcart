// Bake the integer-quantized Voices table (framework/src/audio.ts via
// bake/sound-defs.ts) into the master asset store framework/src/assets.dcstore as
// a single DT_U8 blob keyed "audio:voices". The native synth (runtime/src/audio.rs)
// reads this blob through snd.defineVoices(); framework/build.ts subsets it into a
// per-game pack like any other asset (a game that imports audio.ts and references
// the "audio:voices" key gets the blob; others don't).
//
// MUST run AFTER bake-gltf.ts (which writes assets.dcstore wholesale): this script
// MERGES into the existing store (unpack -> upsert the audio blob -> repack) so it
// never clobbers the glTF/scene/BSP blobs already baked there.
//
// Run: bun framework/bake/bake-audio.ts
import { pack, unpack, DT_U8, type Blob } from './dcpak';
import { buildVoiceTable } from './sound-defs';
import { Voices } from '../src/audio';

const here = new URL('.', import.meta.url).pathname;
const storePath = here + '../src/assets.dcstore';

const VOICE_KEY = 'audio:voices';

const bytes = buildVoiceTable();

// Load the existing store (created by bake-gltf.ts), upsert our blob, repack.
const existing: Blob[] = await Bun.file(storePath)
  .exists()
  .then(async (e) =>
    e ? unpack(new Uint8Array(await Bun.file(storePath).arrayBuffer())) : [],
  );

const merged = existing.filter((b) => b.key !== VOICE_KEY);
merged.push({ key: VOICE_KEY, dtype: DT_U8, data: bytes });

await Bun.write(storePath, pack(merged));
console.log(
  `bake-audio: wrote ${VOICE_KEY} (${Object.keys(Voices).length} voices, ${bytes.length} bytes) into src/assets.dcstore`,
);

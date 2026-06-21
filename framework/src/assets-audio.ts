// The baked, integer-quantized voice table (framework/bake/bake-audio.ts ->
// "audio:voices" DT_U8 blob in the per-game .dcpak). A game that uses sound
// imports VOICE_TABLE and hands it to the host once via snd.defineVoices() —
// referencing the 'audio:voices' literal here is what makes framework/build.ts
// subset the blob INTO that game's pack (and only that game's pack).
//
// Like the glTF asset modules, this is NOT re-exported from index.ts: importing
// it pulls the blob, so only games that actually want audio carry it.
import { dcU8 } from './dcpak';

/**
 * Lazily fetch the baked voice table as an ArrayBuffer (a fresh copy; see
 * dcpak.ts). Pass straight to `snd.defineVoices(voiceTable())`.
 */
export function voiceTable(): ArrayBuffer {
  // dcU8 returns a fresh offset-0, length-exact Uint8Array, so .buffer is exactly
  // this blob (never shared); the cast narrows ArrayBufferLike -> ArrayBuffer.
  return dcU8('audio:voices').buffer as ArrayBuffer;
}

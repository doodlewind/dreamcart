// Build-side voice quantizer: turns the readable, float-authored Voices table
// (framework/src/audio.ts) into the integer-only byte layout the native synth
// (runtime/src/audio.rs) reads. NO float survives the bake — every field is
// quantized to an integer so the synth never touches libm or host floats.
//
// Run indirectly via bake-audio.ts (which packs the bytes into a .dcpak blob).
//
// ── Baked voice table layout (little-endian) ─────────────────────────────────
// Header (8 bytes):
//   u32 magic 'DCAV' (0x56414344)   — DreamCart Audio Voices
//   u16 version (1)
//   u16 voiceCount
// Then voiceCount × VOICE_BYTES (=24) records, each:
//   u8  wave              (WAVE_CODE: 0=square 1=saw 2=sine 3=noise)
//   u8  duty             (0..255, Q8 of the 0..1 duty; square only)
//   u16 freq             (Hz, integer)
//   i16 sweep            (Hz added across the whole voice; signed)
//   u16 durSamples       (total length in samples @ SAMPLE_RATE)
//   u16 attackSamples
//   u16 decaySamples
//   u16 releaseSamples
//   u16 sustainQ15       (0..32767 sustain level)
//   u16 gainQ15          (0..32767 per-voice gain)
//   u16 reserved (0)
//   u16 reserved (0)
// VOICE_BYTES is fixed so the synth indexes a voice by `8 + idx*24`.
//
// The synth's mixer SAMPLE_RATE MUST match the value here (audio.rs SAMPLE_RATE).
import { Voices, WAVE_CODE, type VoiceDesc, type Wave } from '../src/audio';

/** Output PCM sample rate. Must equal SAMPLE_RATE in runtime/src/audio.rs. */
export const SAMPLE_RATE = 44100;

export const DCAV_MAGIC = 0x56414344; // 'DCAV' little-endian
export const DCAV_VERSION = 1;
export const VOICE_BYTES = 24;
const HEADER_BYTES = 8;

function msToSamples(ms: number): number {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  return n < 0 ? 0 : n > 0xffff ? 0xffff : n;
}

function q15(v: number): number {
  const n = Math.round(v * 32767);
  return n < 0 ? 0 : n > 32767 ? 32767 : n;
}

function u16(v: number): number {
  const n = v | 0;
  return n < 0 ? 0 : n > 0xffff ? 0xffff : n;
}

function i16(v: number): number {
  let n = Math.round(v);
  if (n < -32768) n = -32768;
  if (n > 32767) n = 32767;
  return n;
}

function u8(v: number): number {
  const n = v | 0;
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/** Quantize ONE voice into a VOICE_BYTES record at `dv`+`off`. */
export function quantizeVoice(dv: DataView, off: number, d: VoiceDesc): void {
  dv.setUint8(off + 0, WAVE_CODE[d.wave as Wave] & 0xff);
  dv.setUint8(off + 1, u8(Math.round((d.duty ?? 0.5) * 255)));
  dv.setUint16(off + 2, u16(d.freq), true);
  dv.setInt16(off + 4, i16(d.sweep ?? 0), true);
  dv.setUint16(off + 6, msToSamples(d.durMs), true);
  dv.setUint16(off + 8, msToSamples(d.attackMs), true);
  dv.setUint16(off + 10, msToSamples(d.decayMs), true);
  dv.setUint16(off + 12, msToSamples(d.releaseMs), true);
  dv.setUint16(off + 14, q15(d.sustain), true);
  dv.setUint16(off + 16, q15(d.gain ?? 1), true);
  dv.setUint16(off + 18, 0, true);
  dv.setUint16(off + 20, 0, true);
  // off+22 .. off+23 already zero (record is VOICE_BYTES=24 wide).
}

/** Build the full baked voice table bytes for the Voices record (insertion order). */
export function buildVoiceTable(): Uint8Array {
  const names = Object.keys(Voices);
  const out = new Uint8Array(HEADER_BYTES + names.length * VOICE_BYTES);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, DCAV_MAGIC, true);
  dv.setUint16(4, DCAV_VERSION, true);
  dv.setUint16(6, names.length, true);
  for (let i = 0; i < names.length; i++) {
    quantizeVoice(dv, HEADER_BYTES + i * VOICE_BYTES, Voices[names[i]]);
  }
  return out;
}

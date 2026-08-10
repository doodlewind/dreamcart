// The DreamCart audio system — the ONLY module games import for sound.
//
//   import { SoundBank, Voices } from '../src/audio';
//
// Like controller/action/scene-desc, audio.ts is a 3D/optional subsystem imported
// DIRECTLY by games (NOT re-exported from index.ts), so a 2D bundle that doesn't
// use sound stays lean and the PSP EBOOT doesn't pay for it.
//
// ── DESIGN ────────────────────────────────────────────────────────────────────
// A game describes its sounds with a tiny event spec (which built-in Voice each
// game event maps to). At runtime SoundBank turns play()/loop() calls into a
// per-frame DCAU command buffer that crosses the FFI boundary ONCE per frame via
// the optional host `snd.submit()` (mirroring g3d's CommandEncoder discipline).
//
// The native synth (runtime/src/audio.rs) reads a baked, integer-quantized copy
// of the Voices table (bake-audio.ts) and renders the actual PCM on a dedicated
// audio thread. NO host float ever reaches the synth — everything on the wire is
// an integer (pitch is Q8.8 fixed point, gain is Q8 0..255).
//
// ── DETERMINISM ─────────────────────────────────────────────────────────────
// SoundBank's observable scalars — active / lastEvent / vu — update purely from
// the JS-side bookkeeping, with NO dependency on whether the host `snd` global is
// present. The flappy/shooter AUDIO HUD draws from those scalars, so the golden
// pixels are byte-exact on the headless harness (which installs a recording snd
// mock) and on a host with no audio at all. There is NO Math.random, no Date, no
// host-float feedback in the deterministic path.

// ── Wire format (DCAU) ───────────────────────────────────────────────────────
// One little-endian ArrayBuffer per frame, header + a list of fixed-size ops.
// framework/test/contract.ts asserts these constants match runtime/src/audio.rs
// byte-for-byte (the same DC3D_* parity check the 3D layer uses).
//
//   Header (8 bytes): u32 magic 'DCAU', u16 version, u16 opCount
//   Op (8 bytes): u16 op, u16 voiceIdx, u16 pitchQ8, u16 gainQ8
//     SND_OP_TRIGGER  — start a one-shot of voice `voiceIdx`
//     SND_OP_SET_LOOP — set loop slot `voiceIdx` playing (gain>0) / stopped (gain==0)
//     SND_OP_MASTER   — set master gain (gainQ8 in the gain field; voiceIdx ignored)
//
// Every op is a whole 8 bytes, so the header (8B) keeps everything aligned.

export const DCAU_MAGIC = 0x55414344; // 'DCAU' little-endian ('D','C','A','U')
export const DCAU_VERSION = 0x0001;

export const SND_OP_TRIGGER = 0x0001;
export const SND_OP_SET_LOOP = 0x0002;
export const SND_OP_MASTER = 0x0003;

/** Q8.8 fixed-point unit pitch (1.0 == no shift). */
export const PITCH_ONE = 0x0100;
/** Q8 unit gain (1.0). */
export const GAIN_ONE = 0xff;

// ── Voice synthesis model ─────────────────────────────────────────────────────

/** Oscillator waveform. The synth realizes all four with integer math only. */
export type Wave = 'square' | 'saw' | 'sine' | 'noise';

/**
 * A built-in voice: one oscillator + an integer ADSR envelope. All fields are
 * authored as plain numbers here (readable defs); bake-audio.ts quantizes them to
 * the integers the native synth consumes, so NO float crosses to the synth.
 */
export interface VoiceDesc {
  wave: Wave;
  /** Base frequency in Hz. */
  freq: number;
  /** Total voice duration in milliseconds (attack+decay+sustain+release fit in). */
  durMs: number;
  /** Attack time (ms): ramp 0 -> peak. */
  attackMs: number;
  /** Decay time (ms): ramp peak -> sustain. */
  decayMs: number;
  /** Sustain level 0..1 (quantized to q15 by the bake). */
  sustain: number;
  /** Release time (ms): ramp sustain -> 0. */
  releaseMs: number;
  /** Optional linear pitch sweep over the voice, in Hz (added across durMs). */
  sweep?: number;
  /** Optional square duty 0..1 (default 0.5); ignored for non-square waves. */
  duty?: number;
  /** Optional per-voice gain 0..1 (default 1). */
  gain?: number;
}

// Wave enum codes on the wire / in the baked table (must match audio.rs).
export const WAVE_CODE: Record<Wave, number> = {
  square: 0,
  saw: 1,
  sine: 2,
  noise: 3,
};

/**
 * The ~16 built-in voices covering the gameplay audit. Authored with musical/
 * readable numbers; the bake quantizes them. Keys are the canonical event names
 * a game's SoundBank spec maps its game events onto.
 *
 * Order is STABLE — the baked table and the wire `voiceIdx` index into this
 * record by insertion order, so DO NOT reorder existing entries (append only).
 */
export const Voices: Record<string, VoiceDesc> = {
  // 0 — UI confirm: short bright blip.
  'menu.select': { wave: 'square', freq: 880, durMs: 70, attackMs: 1, decayMs: 20, sustain: 0.5, releaseMs: 40, duty: 0.5 },
  // 1 — generic collision / thud: a falling noise burst.
  'collision.impact': { wave: 'noise', freq: 220, durMs: 140, attackMs: 1, decayMs: 60, sustain: 0.2, releaseMs: 70, sweep: -120 },
  // 2 — gunshot: sharp noise transient.
  'gunshot': { wave: 'noise', freq: 480, durMs: 90, attackMs: 0, decayMs: 30, sustain: 0.1, releaseMs: 50, sweep: -260 },
  // 3 — coin pickup: rising two-feel via sweep.
  'coin.pickup': { wave: 'square', freq: 988, durMs: 110, attackMs: 1, decayMs: 30, sustain: 0.6, releaseMs: 60, sweep: 320, duty: 0.5 },
  // 4 — footstep: low soft noise tap.
  'footstep': { wave: 'noise', freq: 130, durMs: 80, attackMs: 2, decayMs: 30, sustain: 0.15, releaseMs: 40, sweep: -40 },
  // 5 — flap (flappy): quick upward whoosh.
  'flap': { wave: 'sine', freq: 420, durMs: 90, attackMs: 1, decayMs: 25, sustain: 0.4, releaseMs: 50, sweep: 180 },
  // 6 — score: bright ascending chime.
  'score': { wave: 'sine', freq: 660, durMs: 160, attackMs: 2, decayMs: 40, sustain: 0.5, releaseMs: 90, sweep: 280 },
  // 7 — engine loop (racing): sustained saw, looped by the loop slots.
  'engine': { wave: 'saw', freq: 110, durMs: 200, attackMs: 10, decayMs: 20, sustain: 0.8, releaseMs: 20, duty: 0.5 },
  // 8 — victory: long bright rising sine.
  'victory': { wave: 'sine', freq: 523, durMs: 360, attackMs: 4, decayMs: 80, sustain: 0.7, releaseMs: 200, sweep: 400 },
  // 9 — jump: square chirp up.
  'jump': { wave: 'square', freq: 300, durMs: 120, attackMs: 1, decayMs: 30, sustain: 0.5, releaseMs: 60, sweep: 260, duty: 0.5 },
  // 10 — hit: harsh short square zap down.
  'hit': { wave: 'square', freq: 220, durMs: 120, attackMs: 0, decayMs: 40, sustain: 0.3, releaseMs: 70, sweep: -150, duty: 0.25 },
  // 11 — spawn: soft rising sine pop.
  'spawn': { wave: 'sine', freq: 360, durMs: 130, attackMs: 3, decayMs: 40, sustain: 0.5, releaseMs: 70, sweep: 140 },
  // 12 — damage: descending saw growl.
  'damage': { wave: 'saw', freq: 200, durMs: 200, attackMs: 1, decayMs: 70, sustain: 0.35, releaseMs: 110, sweep: -120 },
  // 13 — gameover: long descending sad sine.
  'gameover': { wave: 'sine', freq: 392, durMs: 500, attackMs: 6, decayMs: 120, sustain: 0.5, releaseMs: 300, sweep: -260 },
  // 14 — blip: tiny neutral tick (UI cursor move).
  'blip': { wave: 'square', freq: 660, durMs: 40, attackMs: 0, decayMs: 12, sustain: 0.4, releaseMs: 22, duty: 0.5 },
  // 15 — explosion: big noise boom.
  'explosion': { wave: 'noise', freq: 90, durMs: 320, attackMs: 1, decayMs: 120, sustain: 0.3, releaseMs: 190, sweep: -60 },
};

/** Ordered voice-name list — index == wire voiceIdx == baked table slot. */
export const VOICE_NAMES: string[] = Object.keys(Voices);

/** Resolve an event/voice name to its integer voice index (-1 if unknown). */
export function voiceIndex(name: string): number {
  return VOICE_NAMES.indexOf(name);
}

// ── AudioEncoder ──────────────────────────────────────────────────────────────
// EXACT g3d CommandEncoder discipline: a pre-allocated ArrayBuffer is filled each
// frame, grows on overflow, reset() rewinds it, and flush() does the ONE FFI
// crossing (snd.submit). Ops are fixed 8 bytes so growth is rarely needed.
export class AudioEncoder {
  private buf: ArrayBuffer;
  private view: DataView;
  private pos = 8; // past header
  private ops = 0;

  constructor(capacityBytes = 4 * 1024) {
    this.buf = new ArrayBuffer(capacityBytes);
    this.view = new DataView(this.buf);
  }

  reset(): void {
    this.pos = 8;
    this.ops = 0;
  }

  get opCount(): number {
    return this.ops;
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    while (cap < this.pos + extra) cap *= 2;
    const next = new ArrayBuffer(cap);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf);
  }

  private op(op: number, voiceIdx: number, pitchQ8: number, gainQ8: number): void {
    this.ensure(8);
    this.view.setUint16(this.pos, op & 0xffff, true);
    this.view.setUint16(this.pos + 2, voiceIdx & 0xffff, true);
    this.view.setUint16(this.pos + 4, pitchQ8 & 0xffff, true);
    this.view.setUint16(this.pos + 6, gainQ8 & 0xffff, true);
    this.pos += 8;
    this.ops++;
  }

  /** One-shot trigger of `voiceIdx` at `pitchQ8` (Q8.8) and `gainQ8` (Q8). */
  trigger(voiceIdx: number, pitchQ8: number, gainQ8: number): void {
    this.op(SND_OP_TRIGGER, voiceIdx, pitchQ8, gainQ8);
  }

  /** Set loop slot `voiceIdx` to playing (gainQ8>0) or stopped (gainQ8==0). */
  setLoop(voiceIdx: number, pitchQ8: number, gainQ8: number): void {
    this.op(SND_OP_SET_LOOP, voiceIdx, pitchQ8, gainQ8);
  }

  /** Set the master gain (Q8). */
  master(gainQ8: number): void {
    this.op(SND_OP_MASTER, 0, PITCH_ONE, gainQ8);
  }

  /** Write the header and submit via the host (no-op if `snd` absent). */
  flush(): void {
    this.view.setUint32(0, DCAU_MAGIC, true);
    this.view.setUint16(4, DCAU_VERSION, true);
    this.view.setUint16(6, this.ops, true);
    const snd = (globalThis as unknown as { snd?: RawSnd }).snd;
    if (snd && this.ops > 0) snd.submit(this.buf, this.pos);
  }

  /** The valid byte range of the current buffer (used by the recording mock). */
  packet(): { buffer: ArrayBuffer; byteLength: number; ops: number } {
    this.view.setUint32(0, DCAU_MAGIC, true);
    this.view.setUint16(4, DCAU_VERSION, true);
    this.view.setUint16(6, this.ops, true);
    return { buffer: this.buf, byteLength: this.pos, ops: this.ops };
  }
}

// ── SoundBank ────────────────────────────────────────────────────────────────

/**
 * Footstep-glue target: a SkinnedMesh-shaped object. The wrap hook is installed
 * on the MESH's persistent `onWrap` (which SkinnedMesh.play() copies onto every
 * fresh player), NOT on a single `player` instance — because play() replaces the
 * player on each clip switch, a player-only binding would be silently orphaned.
 * `player` is updated too so the CURRENT clip fires steps immediately. `clip` on
 * the current player lets bindSteps honor the optional clips filter at wrap time.
 */
export interface StepSource {
  /** Persistent per-mesh wrap hook; SkinnedMesh.play() copies it to new players. */
  onWrap?: (() => void) | null;
  /** The CURRENT clip player (also gets the hook so the active clip steps now). */
  player?: { onWrap?: (() => void) | null; clip?: object };
  /** The named clip table; used to resolve the current clip's name for filtering. */
  clips?: Record<string, object>;
}

export interface SoundSpec {
  /** event name -> Voice name (the built-in voice that plays for that event). */
  sfx?: Record<string, string>;
  /** loop id -> Voice name (sustained, started/stopped via loop()/stopLoop()). */
  loops?: Record<string, string>;
  /**
   * Footstep cadence config: the Voice to fire per step (default 'footstep'),
   * optional clip-name filter, and the clip phase fraction at which to step.
   */
  steps?: { voice?: string; clips?: string[]; phase?: number };
  /** Master gain 0..1 (default 1). */
  master?: number;
}

export interface PlayOpts {
  /** Pitch multiplier (1.0 == base); quantized to Q8.8. */
  pitch?: number;
  /** Gain multiplier 0..1; quantized to Q8. */
  gain?: number;
}

function clampU16(n: number): number {
  n = n | 0;
  return n < 0 ? 0 : n > 0xffff ? 0xffff : n;
}

function pitchToQ8(p: number | undefined): number {
  if (p === undefined) return PITCH_ONE;
  return clampU16(Math.round(p * 256));
}

function gainToQ8(g: number | undefined): number {
  if (g === undefined) return GAIN_ONE;
  const v = Math.round(g * 255);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * A game's sound interface. ONE instance is shared per game (engine.audio); the
 * engine calls flush() once per frame. play()/loop() are accumulated into the
 * AudioEncoder and crossed to the host in that single flush.
 */
export class SoundBank {
  private enc = new AudioEncoder();
  private sfxMap: Record<string, number> = {};
  private loopMap: Record<string, number> = {};
  // Per-loop desired state (idx + on/pitch/gain set by loop()/stopLoop()) PLUS
  // the last state actually written to the wire (sentOn/sentPitchQ8/sentGainQ8),
  // so flush() emits a SET_LOOP only on a real delta — see flush()'s comment.
  private loopState: Record<string, {
    idx: number; on: boolean; pitchQ8: number; gainQ8: number;
    sentOn: boolean; sentPitchQ8: number; sentGainQ8: number;
  }> = {};
  private stepVoice: number;
  private stepClips: string[] | null;
  private masterQ8: number;

  // One-shot triggers accumulated since the last flush (play() + footsteps). flush()
  // folds this into `active` and zeroes it, so `active` is a true per-frame count.
  private oneShots = 0;

  // Deterministic observable HUD scalars (host-independent — see header).
  /** Number of one-shot triggers + active loops issued THIS frame. */
  active = 0;
  /** Name of the most recent event (one-shot or loop start), '' if none yet. */
  lastEvent = '';
  /**
   * A 0..255 "VU" meter, host-independent: jumps toward the loudest event each
   * frame and decays otherwise, so the HUD bar animates deterministically.
   */
  vu = 0;

  private firstFlush = true;

  constructor(spec: SoundSpec = {}) {
    for (const [event, voice] of Object.entries(spec.sfx ?? {})) {
      this.sfxMap[event] = voiceIndex(voice);
    }
    for (const [id, voice] of Object.entries(spec.loops ?? {})) {
      const idx = voiceIndex(voice);
      this.loopMap[id] = idx;
      this.loopState[id] = {
        idx, on: false, pitchQ8: PITCH_ONE, gainQ8: GAIN_ONE,
        // sentOn:false / sentGainQ8:0 == "never started on the wire", so an
        // idle loop that is never started emits NOTHING (no gain==0 spam).
        sentOn: false, sentPitchQ8: PITCH_ONE, sentGainQ8: 0,
      };
    }
    this.stepVoice = voiceIndex(spec.steps?.voice ?? 'footstep');
    this.stepClips = spec.steps?.clips ?? null;
    this.masterQ8 = gainToQ8(spec.master ?? 1);
  }

  /**
   * Fire a one-shot for `event` (a key of the spec's sfx map, or a raw Voice
   * name). Unknown events are ignored. Updates the deterministic HUD scalars and
   * queues a TRIGGER op for this frame's flush.
   */
  play(event: string, opts?: PlayOpts): void {
    let idx = this.sfxMap[event];
    if (idx === undefined) idx = voiceIndex(event); // allow raw voice names
    if (idx < 0) return;
    const pitchQ8 = pitchToQ8(opts?.pitch);
    const gainQ8 = gainToQ8(opts?.gain);
    this.enc.trigger(idx, pitchQ8, gainQ8);
    this.oneShots++;
    this.lastEvent = event;
    // VU jumps to this event's gain (deterministic peak-hold this frame).
    if (gainQ8 > this.vu) this.vu = gainQ8;
  }

  /** Start (or re-parameterize) loop `id`. Idempotent: only re-sends on change. */
  loop(id: string, opts?: PlayOpts): void {
    const st = this.loopState[id];
    if (!st || st.idx < 0) return;
    const pitchQ8 = pitchToQ8(opts?.pitch);
    const gainQ8 = gainToQ8(opts?.gain ?? 1);
    st.on = true;
    st.pitchQ8 = pitchQ8;
    st.gainQ8 = gainQ8;
    this.lastEvent = id;
  }

  /** Stop loop `id` (queued at flush). */
  stopLoop(id: string): void {
    const st = this.loopState[id];
    if (!st) return;
    st.on = false;
  }

  /**
   * Bind shared footstep glue to a SkinnedMesh: each time the playing clip wraps
   * (anim.ts fires the player's onWrap), play the step voice. The hook is stored
   * on the MESH's persistent `onWrap`, which SkinnedMesh.play() copies onto every
   * fresh player — so the binding SURVIVES clip switches (play() replaces the
   * player object). The current player gets the hook too, so the already-playing
   * clip steps immediately without waiting for the next play().
   *
   * The optional `clips` filter (spec.steps.clips) is honored at wrap time: the
   * step only fires when the source's CURRENT clip is one of the named clips. The
   * filter is resolved by identity (the player's `clip` object vs. the entries of
   * `src.clips`) since baked clips carry no name field.
   *
   * Bind ONCE per mesh (e.g. right after SkinnedMesh.fromBaked()); the games keep
   * one shared SoundBank so footstep cadence is identical and dedup'd.
   */
  bindSteps(src: StepSource): void {
    if (!src) return;
    if (this.stepVoice < 0) return;
    const filter = this.stepClips;
    const hook = () => {
      // Clip filter: if a clips allow-list is set, only step when the current
      // clip's name (resolved from the named clip table by object identity) is in
      // it. No filter -> always step.
      if (filter) {
        const cur = src.player?.clip;
        let name: string | null = null;
        if (cur && src.clips) {
          for (const k in src.clips) {
            if (src.clips[k] === cur) { name = k; break; }
          }
        }
        if (name === null || filter.indexOf(name) < 0) return;
      }
      this.enc.trigger(this.stepVoice, PITCH_ONE, GAIN_ONE);
      this.oneShots++;
      this.lastEvent = 'footstep';
      if (GAIN_ONE > this.vu) this.vu = GAIN_ONE;
    };
    // Persistent (mesh-level) hook: play() copies this onto each new player.
    src.onWrap = hook;
    // Current player (the active clip) fires steps immediately.
    if (src.player) src.player.onWrap = hook;
  }

  /**
   * Emit this frame's command buffer in ONE FFI crossing (or update the
   * deterministic scalars only, if no host snd). Called by the engine each frame
   * AFTER the 3D render and BEFORE/with the 2D HUD. Resets the per-frame active
   * count and decays the VU meter.
   */
  flush(): void {
    // Emit loop state changes (always on the first flush so the host gets the
    // initial master gain + any auto-started loops, then only deltas thereafter).
    if (this.firstFlush) {
      this.enc.master(this.masterQ8);
      this.firstFlush = false;
    }
    // Emit a SET_LOOP only on a DELTA from what we last put on the wire. A held
    // throttle (same quantized pitch) emits nothing; a stopLoop emits exactly ONE
    // gain==0 op and then stays silent; an idle-from-boot loop emits nothing at
    // all. This keeps the native command ring frugal and the .snd.json stream
    // compact (no perpetual gain==0 spam). The deterministic HUD scalars (active/
    // vu) still track the DESIRED state every frame, independent of wire traffic.
    let activeLoops = 0;
    for (const id in this.loopState) {
      const st = this.loopState[id];
      if (st.on) {
        activeLoops++;
        if (st.gainQ8 > this.vu) this.vu = st.gainQ8;
      }
      // The wire op we WOULD send this frame: gain==0 means "stopped".
      const wantGainQ8 = st.on ? st.gainQ8 : 0;
      const wantPitchQ8 = st.on ? st.pitchQ8 : st.sentPitchQ8;
      const changed = st.on !== st.sentOn
        || wantGainQ8 !== st.sentGainQ8
        || (st.on && wantPitchQ8 !== st.sentPitchQ8);
      if (changed) {
        this.enc.setLoop(st.idx, wantPitchQ8, wantGainQ8);
        st.sentOn = st.on;
        st.sentPitchQ8 = wantPitchQ8;
        st.sentGainQ8 = wantGainQ8;
      }
    }
    // active = one-shots issued THIS frame + currently-playing loops. Resetting
    // the one-shot accumulator here makes `active` a true per-frame count (it was
    // previously a monotonically-growing running total — see review finding #3).
    this.active = this.oneShots + activeLoops;
    this.oneShots = 0;

    this.enc.flush();
    this.enc.reset();

    // VU decay (deterministic): fall by a fixed step each frame toward 0.
    this.vu = this.vu > 24 ? this.vu - 24 : 0;
  }
}

// ── Host contract ─────────────────────────────────────────────────────────────

/**
 * The raw native sound contract a host MAY install as the global `snd`. Mirrors
 * RawG3d: voices are defined once, then exactly one command buffer crosses the
 * boundary per frame via submit(). Optional everywhere — without it, SoundBank's
 * deterministic scalars still update so the AUDIO HUD is unchanged.
 */
export interface RawSnd {
  /**
   * Install the baked, integer-quantized Voices table ONCE (returns the voice
   * count). `buffer` is the bake-audio.ts DT_U8 blob (see sound-defs.ts).
   */
  defineVoices(buffer: ArrayBuffer): number;
  /** THE per-frame call: one little-endian DCAU command buffer. */
  submit(buffer: ArrayBuffer, byteLength: number): void;
  /** Optional: current active-voice count from the native mixer (diagnostics). */
  poll?(): number;
}

declare global {
  // eslint-disable-next-line no-var
  var snd: RawSnd | undefined;
}

/** True when the host provides the native sound contract. */
export function hasSnd(): boolean {
  return typeof globalThis.snd !== 'undefined' && globalThis.snd !== null;
}

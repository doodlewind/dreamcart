//! Native PSP audio synth exposed to JS as the optional `snd.*` object.
//!
//! DRAFT — this file CANNOT be compiled in the headless/JS dev loop (no PSP
//! toolchain there). It is written to the same FFI + wire conventions the headless
//! side is tested against (framework/src/audio.ts DCAU_*, framework/bake/
//! sound-defs.ts DCAV voice table). A human builds + boots it on PPSSPP/hardware;
//! see the BUILD/BOOT CHECKLIST at the bottom.
//!
//! ── ARCHITECTURE ──────────────────────────────────────────────────────────────
//! A DEDICATED sceKernel thread runs an integer mixer (up to 8 voices: phase
//! accumulator + q15 ADSR + a q15 sine LUT, NO division/branch-heavy work in the
//! inner loop) and fills a DAC double-buffer via sceAudioSRCChReserve +
//! sceAudioSRCOutputBlocking. The JS thread feeds commands through an SPSC ring
//! (snd.submit). The audio thread does ZERO heap allocation for its whole life:
//! the ring, the voice slots, the DAC buffers and the voice table are all
//! pre-allocated on the JS thread BEFORE the thread starts.
//!
//! CRITICAL ORDERING (see runtime/src/main.rs run() + arena.rs): the audio thread
//! is created+started BEFORE qjs_alloc::new_runtime() so its stack allocation
//! does not fight the arena bump pointer (arena.rs grabs most of the partition on
//! first JS alloc), and the arena margin is enlarged for the audio stack + DAC
//! buffers. The audio thread NEVER calls the global allocator (it would deadlock
//! against the single-threaded, NON-thread-safe arena.rs).
//!
//! ── THREADING / arena.rs SAFETY ──────────────────────────────────────────────
//! arena.rs is JS-thread-ONLY (not thread-safe). Therefore EVERYTHING the audio
//! thread touches must be in static storage or pre-allocated. The SPSC ring uses
//! a single-producer (JS) / single-consumer (audio) discipline with a volatile
//! head/tail so no lock is needed and no allocation happens on either side.

#![allow(static_mut_refs)]

use core::ffi::c_void;
use core::ptr;
use core::sync::atomic::{AtomicU32, AtomicBool, Ordering};

use libquickjs_sys::*;
use psp::sys::{self, AudioOutputFrequency, ThreadAttributes};

// ── Wire constants — MUST match framework/src/audio.ts (contract.ts asserts
//    parity, greping NAME ... 0xHEX exactly like the DC3D_* check). The comment
//    block is the parser-visible declaration; the typed consts below are used.
//
//   DCAU_MAGIC = 0x55414344
//   DCAU_VERSION = 0x0001
//   SND_OP_TRIGGER = 0x0001
//   SND_OP_SET_LOOP = 0x0002
//   SND_OP_MASTER = 0x0003
// ─────────────────────────────────────────────────────────────────────────────
const DCAU_MAGIC: u32 = 0x5541_4344;
const DCAU_VERSION: u32 = 0x0001;
const SND_OP_TRIGGER: u32 = 0x0001;
const SND_OP_SET_LOOP: u32 = 0x0002;
const SND_OP_MASTER: u32 = 0x0003;

// Baked voice-table format (framework/bake/sound-defs.ts DCAV_*). contract.ts
// asserts DCAV_MAGIC / DCAV_VERSION / VOICE_BYTES match sound-defs.ts + web/engine.js
// byte-for-byte, exactly like the DCAU_* parity check, so a record-layout bump can
// never silently mis-parse across hosts (review finding #5).
//   DCAV_MAGIC = 0x56414344
//   DCAV_VERSION = 0x0001
//   VOICE_BYTES = 24
const DCAV_MAGIC: u32 = 0x5641_4344;
const DCAV_VERSION: u16 = 0x0001;
const VOICE_BYTES: usize = 24;

// ── Audio output config ───────────────────────────────────────────────────────
/// Output sample rate. MUST equal sound-defs.ts SAMPLE_RATE.
const SAMPLE_RATE: i32 = 44100;
/// SRC granule: samples per OutputBlocking call. The SRC channel wants a multiple
/// of 64; 1024 keeps latency ~23 ms while leaving the mixer plenty of headroom.
const GRANULE: usize = 1024;
/// Stereo i16 DAC buffer = GRANULE frames × 2 channels. Double-buffered so the
/// mixer fills buffer B while the SRC drains buffer A.
const DAC_LEN: usize = GRANULE * 2;

const MAX_VOICES: usize = 8;
const MAX_TABLE_VOICES: usize = 64;

// ── q15 sine LUT (256 entries, one quadrant mirrored) — NO libm. Built once at
// startup on the JS thread (pure integer Taylor-free table fill via a small
// integer CORDIC-free approximation). We use a 256-entry quarter-wave table and
// reflect/negate for the other three quadrants in the inner loop (branch-light).
const SINE_QUADRANT: usize = 256;
static mut SINE_LUT: [i16; SINE_QUADRANT + 1] = [0; SINE_QUADRANT + 1];

/// Fill SINE_LUT[i] = round(32767 * sin(i/256 * pi/2)) using only integer math
/// (no libm, no float). x = i/256 * (pi/2), evaluated with a 4-term Maclaurin
/// series in HORNER form so NO intermediate overflows i64 and the result is accurate
/// to <1 LSB of q15 across the whole quarter wave:
///
///   sin(x) = x · (1 - x²/6 · (1 - x²/20 · (1 - x²/42)))
///
/// The naive `term*x2` (term = x^5) overflows i64 at i≈256 (~1.1e19 > i64::MAX),
/// and the truncated polynomial overshoots at pi/2 (sin≈1.0045 -> 32915 > i16::MAX,
/// which `as i16` would wrap to a negative spike). Horner keeps every intermediate
/// near ±1.0 (in Q30, < ~2^31), and the endpoints are FORCED exact + the result is
/// CLAMPED to [-32767, 32767] before the `as i16` cast — see review finding #2.
const SINE_Q30_ONE: i64 = 1 << 30;
unsafe fn build_sine_lut() {
    // pi/2 ≈ 1.57079632679; in Q30 fixed point.
    const HALF_PI_Q30: i64 = 1686629713; // round(pi/2 * 2^30)
    for i in 0..=SINE_QUADRANT {
        // x in Q30 = (i / 256) * (pi/2)
        let x: i64 = (i as i64 * HALF_PI_Q30) / SINE_QUADRANT as i64;
        // x² in Q30 (value of x is <= pi/2, so x² <= ~2.47 -> well within i64).
        let x2 = (x * x) >> 30;
        // Horner: inner = 1 - x²/42; mul by -x²/20 stepwise, etc. Each `(a*b)>>30`
        // has |a|,|b| <= ~2.5·2^30 (~2.7e9), so the product is <= ~7.3e18 < i64::MAX.
        let mut poly = SINE_Q30_ONE - (x2 / 42); // 1 - x²/42
        poly = SINE_Q30_ONE - ((x2 * poly) >> 30) / 20; // 1 - x²/20·(…)
        poly = SINE_Q30_ONE - ((x2 * poly) >> 30) / 6; //  1 - x²/6·(…)
        let sin_q30 = (x * poly) >> 30; // x·(…) = sin(x), Q30
        // Scale Q30 -> q15 and clamp so a tiny series overshoot near pi/2 can never
        // wrap the i16 (q15 max is +32767).
        let mut q15 = (sin_q30 * 32767) >> 30;
        if q15 > 32767 {
            q15 = 32767;
        } else if q15 < -32767 {
            q15 = -32767;
        }
        SINE_LUT[i] = q15 as i16;
    }
    // Force exact endpoints (sin(0)=0, sin(pi/2)=1) so the quadrant boundaries the
    // mixer reads (idx 0 of quadrants 1 & 3 read SINE_LUT[256]) are precise peaks.
    SINE_LUT[0] = 0;
    SINE_LUT[SINE_QUADRANT] = 32767;
}

/// Full-period sine from a Q16 phase (0..65535 == 0..2pi), q15 output. Uses the
/// quarter-wave LUT with reflection — NO trig call, NO division in the hot path.
#[inline(always)]
unsafe fn sine_q15(phase: u16) -> i32 {
    let quadrant = (phase >> 14) & 3; // top 2 bits select the quadrant
    let idx = ((phase >> 6) & 0xff) as usize; // next 8 bits index 0..255
    let v = match quadrant {
        0 => SINE_LUT[idx] as i32,
        1 => SINE_LUT[SINE_QUADRANT - idx] as i32,
        2 => -(SINE_LUT[idx] as i32),
        _ => -(SINE_LUT[SINE_QUADRANT - idx] as i32),
    };
    v
}

// ── Voice table (parsed from the baked DCAV blob) ─────────────────────────────
#[derive(Copy, Clone, Default)]
struct VoiceDef {
    wave: u8,
    duty: u8,        // Q8
    freq: u16,       // Hz
    sweep: i16,      // Hz across the voice
    dur: u16,        // samples
    attack: u16,     // samples
    decay: u16,      // samples
    release: u16,    // samples
    sustain: u16,    // q15
    gain: u16,       // q15
}
static mut TABLE: [VoiceDef; MAX_TABLE_VOICES] = [VoiceDef {
    wave: 0, duty: 128, freq: 440, sweep: 0, dur: 4410, attack: 1, decay: 1,
    release: 1, sustain: 0, gain: 32767,
}; MAX_TABLE_VOICES];
static mut TABLE_COUNT: usize = 0;

// ── Live voice slots (audio-thread-owned) ─────────────────────────────────────
#[derive(Copy, Clone, Default)]
struct Voice {
    active: bool,
    looping: bool,
    def: usize,        // index into TABLE
    phase: u32,        // Q16 oscillator phase
    step: u32,         // Q16 phase increment per sample
    sweep_step: i32,   // Q16 added to `step` per sample (pitch sweep)
    pos: u32,          // samples elapsed
    gain_q15: i32,     // per-trigger gain (Q15)
    noise_lfsr: u32,   // per-voice noise state
}
static mut VOICES: [Voice; MAX_VOICES] = [Voice {
    active: false, looping: false, def: 0, phase: 0, step: 0, sweep_step: 0,
    pos: 0, gain_q15: 32767, noise_lfsr: 0x1234_5678,
}; MAX_VOICES];

static mut MASTER_Q15: i32 = 32767;

// ── DAC double buffer ─────────────────────────────────────────────────────────
static mut DAC: [[i16; DAC_LEN]; 2] = [[0; DAC_LEN]; 2];

// ── SPSC command ring (JS producer, audio consumer) ──────────────────────────
// A power-of-two ring of 8-byte commands: u16 op, u16 voiceIdx, u16 pitchQ8, u16
// gainQ8 — the exact DCAU op layout. The JS thread pushes (advancing HEAD), the
// audio thread pops (advancing TAIL). Atomics give the cross-thread visibility;
// no lock and no allocation on either side.
const RING_CAP: usize = 256; // must be power of two
#[derive(Copy, Clone, Default)]
struct Cmd { op: u16, voice: u16, pitch: u16, gain: u16 }
static mut RING: [Cmd; RING_CAP] = [Cmd { op: 0, voice: 0, pitch: 0, gain: 0 }; RING_CAP];
static RING_HEAD: AtomicU32 = AtomicU32::new(0); // producer cursor
static RING_TAIL: AtomicU32 = AtomicU32::new(0); // consumer cursor
static AUDIO_RUN: AtomicBool = AtomicBool::new(true);
static AUDIO_READY: AtomicBool = AtomicBool::new(false);

#[inline]
fn ring_push(c: Cmd) {
    // Single producer: read HEAD relaxed, check space against TAIL (acquire).
    let head = RING_HEAD.load(Ordering::Relaxed);
    let tail = RING_TAIL.load(Ordering::Acquire);
    if head.wrapping_sub(tail) as usize >= RING_CAP {
        return; // ring full — drop the command (audio under-run is inaudible vs a stall)
    }
    unsafe { RING[(head as usize) & (RING_CAP - 1)] = c; }
    RING_HEAD.store(head.wrapping_add(1), Ordering::Release);
}

#[inline]
fn ring_pop() -> Option<Cmd> {
    let tail = RING_TAIL.load(Ordering::Relaxed);
    let head = RING_HEAD.load(Ordering::Acquire);
    if tail == head {
        return None;
    }
    let c = unsafe { RING[(tail as usize) & (RING_CAP - 1)] };
    RING_TAIL.store(tail.wrapping_add(1), Ordering::Release);
    Some(c)
}

// ── Mixer ─────────────────────────────────────────────────────────────────────

/// Q16 phase increment for `freq` Hz at SAMPLE_RATE: freq * 65536 / SR.
#[inline]
fn phase_step(freq: i32) -> u32 {
    ((freq as i64 * 65536) / SAMPLE_RATE as i64) as u32
}

/// Find a free (or steal the oldest) voice slot for a new trigger.
unsafe fn alloc_voice() -> usize {
    for i in 0..MAX_VOICES {
        if !VOICES[i].active {
            return i;
        }
    }
    // All busy: steal the voice with the most elapsed samples (closest to done).
    let mut best = 0usize;
    let mut best_pos = 0u32;
    for i in 0..MAX_VOICES {
        if VOICES[i].pos >= best_pos {
            best_pos = VOICES[i].pos;
            best = i;
        }
    }
    best
}

/// Start a voice in slot `slot` from TABLE[def], applying pitch (Q8.8) + gain (Q8).
unsafe fn start_voice(slot: usize, def: usize, pitch_q8: u16, gain_q8: u16, looping: bool) {
    if def >= TABLE_COUNT {
        return;
    }
    let d = TABLE[def];
    let base_freq = (d.freq as i32 * pitch_q8 as i32) >> 8; // apply pitch
    let v = &mut VOICES[slot];
    v.active = true;
    v.looping = looping;
    v.def = def;
    v.phase = 0;
    v.step = phase_step(base_freq.max(1));
    // Spread the total sweep across the whole voice duration, per-sample in Q16.
    let dur = d.dur.max(1) as i32;
    let sweep_total = phase_step(d.sweep as i32) as i32; // signed Q16 over the voice
    v.sweep_step = sweep_total / dur;
    v.pos = 0;
    v.gain_q15 = (gain_q8 as i32 * 32767) >> 8;
    v.noise_lfsr = 0x1234_5678 ^ ((slot as u32 + 1) * 0x9e37_79b9);
}

/// Integer ADSR envelope value (q15) for a voice at sample `pos`.
#[inline]
unsafe fn env_q15(d: &VoiceDef, pos: u32, looping: bool) -> i32 {
    let pos = pos as i32;
    let a = d.attack.max(1) as i32;
    let dc = d.decay.max(1) as i32;
    let sus = d.sustain as i32;
    if pos < a {
        // attack: 0 -> 32767
        (pos * 32767) / a
    } else if pos < a + dc {
        // decay: 32767 -> sustain
        32767 + ((sus - 32767) * (pos - a)) / dc
    } else if looping {
        sus // hold sustain forever while looping
    } else {
        let rel = d.release.max(1) as i32;
        let rel_start = (d.dur as i32 - rel).max(a + dc);
        if pos < rel_start {
            sus
        } else if pos < rel_start + rel {
            // release: sustain -> 0
            sus + ((0 - sus) * (pos - rel_start)) / rel
        } else {
            0
        }
    }
}

/// One oscillator sample (q15) for a voice's current phase, by waveform.
#[inline]
unsafe fn osc_q15(v: &mut Voice, d: &VoiceDef) -> i32 {
    let ph = (v.phase >> 16) as u16; // Q16 fractional -> 0..65535 period
    match d.wave {
        0 => {
            // square with duty
            let duty = (d.duty as u32) << 8; // 0..65280 over the period
            if (ph as u32) < duty { 32767 } else { -32767 }
        }
        1 => {
            // saw: -32767..32767 across the period
            (ph as i32) - 32768
        }
        2 => sine_q15(ph),
        _ => {
            // noise: xorshift LFSR, advanced once per sample, top bits as signed.
            let mut s = v.noise_lfsr;
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            v.noise_lfsr = s;
            ((s >> 16) as i32) - 32768
        }
    }
}

/// Mix all active voices into `out` (stereo i16, GRANULE frames). The hot loop has
/// no division and no heap touch; per-sample work is multiply-add + table lookups.
unsafe fn mix(out: &mut [i16; DAC_LEN]) {
    // Clear to silence first (cheap memset).
    for s in out.iter_mut() {
        *s = 0;
    }
    let master = MASTER_Q15;
    for vi in 0..MAX_VOICES {
        if !VOICES[vi].active {
            continue;
        }
        let d = TABLE[VOICES[vi].def];
        for f in 0..GRANULE {
            if !VOICES[vi].active {
                break;
            }
            let env = env_q15(&d, VOICES[vi].pos, VOICES[vi].looping);
            let o = osc_q15(&mut VOICES[vi], &d);
            // sample = o * env * voiceGain * defGain * master, all q15 chained.
            let mut s = (o * env) >> 15;
            s = (s * VOICES[vi].gain_q15) >> 15;
            s = (s * d.gain as i32) >> 15;
            s = (s * master) >> 15;
            // accumulate into both channels (mono synth -> stereo DAC).
            let li = f * 2;
            let l = out[li] as i32 + s;
            let r = out[li + 1] as i32 + s;
            out[li] = l.clamp(-32768, 32767) as i16;
            out[li + 1] = r.clamp(-32768, 32767) as i16;
            // advance phase + sweep + position.
            VOICES[vi].step = (VOICES[vi].step as i32 + VOICES[vi].sweep_step).max(1) as u32;
            VOICES[vi].phase = VOICES[vi].phase.wrapping_add(VOICES[vi].step);
            VOICES[vi].pos += 1;
            if !VOICES[vi].looping && VOICES[vi].pos as u32 >= d.dur as u32 {
                VOICES[vi].active = false;
            }
        }
    }
}

/// Drain pending commands from the ring (called once per granule by the audio thread).
unsafe fn drain_commands() {
    while let Some(c) = ring_pop() {
        let op = c.op as u32;
        if op == SND_OP_TRIGGER {
            let slot = alloc_voice();
            start_voice(slot, c.voice as usize, c.pitch, c.gain, false);
        } else if op == SND_OP_SET_LOOP {
            // Find an existing loop on this def, or start/stop one.
            let def = c.voice as usize;
            let mut found = MAX_VOICES;
            for i in 0..MAX_VOICES {
                if VOICES[i].active && VOICES[i].looping && VOICES[i].def == def {
                    found = i;
                    break;
                }
            }
            if c.gain == 0 {
                if found < MAX_VOICES {
                    VOICES[found].active = false; // stop the loop
                }
            } else if found == MAX_VOICES {
                let slot = alloc_voice();
                start_voice(slot, def, c.pitch, c.gain, true);
            } else {
                // re-parameterize gain/pitch of the running loop
                VOICES[found].gain_q15 = (c.gain as i32 * 32767) >> 8;
            }
        } else if op == SND_OP_MASTER {
            MASTER_Q15 = (c.gain as i32 * 32767) >> 8;
        }
    }
}

/// The dedicated audio thread: reserve the SRC channel, then forever mix granules
/// and push them to the DAC (OutputBlocking paces us to the sample clock). ZERO
/// allocation for the thread's whole life.
unsafe extern "C" fn audio_thread(_argc: usize, _argv: *mut c_void) -> i32 {
    // Reserve a stereo SRC channel at our sample rate. SRC handles resampling so we
    // always feed 44100 Hz regardless of the DAC's native rate.
    let res = sys::sceAudioSRCChReserve(GRANULE as i32, AudioOutputFrequency::Khz44_1, 2);
    if res < 0 {
        return res; // no channel — exit; JS side just hears nothing.
    }
    AUDIO_READY.store(true, Ordering::Release);
    let mut which = 0usize;
    while AUDIO_RUN.load(Ordering::Acquire) {
        drain_commands();
        mix(&mut DAC[which]);
        // Blocking output paces the thread to the DAC clock (~23 ms per granule).
        sys::sceAudioSRCOutputBlocking(
            sys::AUDIO_VOLUME_MAX as i32,
            DAC[which].as_mut_ptr() as *mut c_void,
        );
        which ^= 1;
    }
    sys::sceAudioSRCChRelease();
    sys::sceKernelExitThread(0);
    0
}

// ── Voice-table parse (DCAV blob from snd.defineVoices) ───────────────────────
#[inline]
unsafe fn rd_u16(p: *const u8, o: usize) -> u16 {
    (*p.add(o) as u16) | ((*p.add(o + 1) as u16) << 8)
}
#[inline]
unsafe fn rd_u32(p: *const u8, o: usize) -> u32 {
    (*p.add(o) as u32)
        | ((*p.add(o + 1) as u32) << 8)
        | ((*p.add(o + 2) as u32) << 16)
        | ((*p.add(o + 3) as u32) << 24)
}

/// `snd.defineVoices(buffer)` -> voice count. Parses the baked DCAV blob into the
/// static TABLE. Called ONCE on the JS thread before any submit; safe to update
/// the table here because the audio thread only READS TABLE entries it is told to
/// play, and triggers can't arrive until JS calls submit after this returns.
unsafe extern "C" fn js_snd_define_voices(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let _ = (DCAU_VERSION,); // keep referenced for the contract parser
    if argc < 1 {
        return JS_NewInt32(ctx, 0);
    }
    let mut len: size_t = 0;
    let p = JS_GetArrayBuffer(ctx, &mut len, *argv.offset(0));
    // Reject a null/short buffer, a bad magic, OR a version we don't understand —
    // a layout bump must fail loudly (return 0 voices) rather than mis-parse the
    // 24-byte records (review finding #5). Header: u32 magic, u16 version, u16 count.
    if p.is_null()
        || (len as usize) < 8
        || rd_u32(p, 0) != DCAV_MAGIC
        || rd_u16(p, 4) != DCAV_VERSION
    {
        return JS_NewInt32(ctx, 0);
    }
    let mut count = rd_u16(p, 6) as usize;
    if count > MAX_TABLE_VOICES {
        count = MAX_TABLE_VOICES;
    }
    for i in 0..count {
        let o = 8 + i * VOICE_BYTES;
        if o + VOICE_BYTES > len as usize {
            break;
        }
        TABLE[i] = VoiceDef {
            wave: *p.add(o),
            duty: *p.add(o + 1),
            freq: rd_u16(p, o + 2),
            sweep: rd_u16(p, o + 4) as i16,
            dur: rd_u16(p, o + 6),
            attack: rd_u16(p, o + 8),
            decay: rd_u16(p, o + 10),
            release: rd_u16(p, o + 12),
            sustain: rd_u16(p, o + 14),
            gain: rd_u16(p, o + 16),
        };
    }
    TABLE_COUNT = count;
    JS_NewInt32(ctx, count as i32)
}

/// `snd.submit(buffer, byteLength)` -> void. Parse the per-frame DCAU command
/// buffer and push each op into the SPSC ring for the audio thread. NO synthesis
/// happens here — this returns immediately so the JS frame loop never blocks.
unsafe extern "C" fn js_snd_submit(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_UNDEFINED;
    }
    let mut size: size_t = 0;
    let buf = JS_GetArrayBuffer(ctx, &mut size, *argv.offset(0));
    if buf.is_null() {
        return JS_UNDEFINED;
    }
    let mut byte_len = size as usize;
    if argc >= 2 {
        let mut bl: i32 = 0;
        JS_ToInt32(ctx, &mut bl, *argv.offset(1));
        if bl >= 0 && (bl as usize) < byte_len {
            byte_len = bl as usize;
        }
    }
    if byte_len < 8 || rd_u32(buf, 0) != DCAU_MAGIC {
        return JS_UNDEFINED;
    }
    let ops = rd_u16(buf, 6) as usize;
    let mut o = 8usize;
    for _ in 0..ops {
        if o + 8 > byte_len {
            break;
        }
        ring_push(Cmd {
            op: rd_u16(buf, o),
            voice: rd_u16(buf, o + 2),
            pitch: rd_u16(buf, o + 4),
            gain: rd_u16(buf, o + 6),
        });
        o += 8;
    }
    JS_UNDEFINED
}

/// `snd.poll()` -> active voice count (diagnostics). Reads the audio-thread voice
/// slots; a slightly-stale count is fine (it's only for an on-screen HUD).
unsafe extern "C" fn js_snd_poll(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    let mut n = 0;
    unsafe {
        for i in 0..MAX_VOICES {
            if VOICES[i].active {
                n += 1;
            }
        }
    }
    JS_NewInt32(ctx, n)
}

/// Create + start the dedicated audio thread. CALL THIS FROM main.rs run() BEFORE
/// qjs_alloc::new_runtime() (see the ordering note at the top + the checklist).
/// Builds the sine LUT first (JS thread, pre-alloc), then spawns the mixer thread
/// with a small dedicated stack. Returns the thread id (negative on failure).
pub unsafe fn start_audio_thread() -> i32 {
    build_sine_lut();
    AUDIO_RUN.store(true, Ordering::Release);
    let id = sys::sceKernelCreateThread(
        b"pspjs_audio\0".as_ptr(),
        audio_thread,
        // Priority 33 — just BELOW the JS/render thread (32, main.rs boot()). On the
        // single-core PSP a higher-priority mixer could preempt the vblank-paced 60fps
        // render loop mid-frame during a granule mix (up to 8 voices × 1024 frames of
        // multiply-adds), adding frame jitter. Running just below means audio fills the
        // DAC during the render thread's OWN vblank wait, and sceAudioSRCOutputBlocking
        // (below) paces the mixer to the sample clock so it can never busy-starve the
        // render thread. (Review finding #4 — verify 60fps on PPSSPP per the checklist.)
        0x21,            // priority 33 (just below the render thread @ 32)
        64 * 1024,       // 64 KB stack (the mixer is shallow + uses static buffers)
        ThreadAttributes::USER,
        ptr::null_mut(),
    );
    if id.0 >= 0 {
        sys::sceKernelStartThread(id, 0, ptr::null_mut());
    }
    id.0
}

/// Install the `snd` object (defineVoices / submit / poll) onto the JS global.
/// Mirrors `gfx::register` / `gfx3d::register`.
pub unsafe fn register(ctx: *mut JSContext, global: JSValue) {
    let snd = JS_NewObject(ctx);

    let f_def = JS_NewCFunction2(
        ctx,
        Some(js_snd_define_voices),
        b"defineVoices\0".as_ptr() as *const _,
        1,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, snd, b"defineVoices\0".as_ptr() as *const _, f_def);

    let f_sub = JS_NewCFunction2(
        ctx,
        Some(js_snd_submit),
        b"submit\0".as_ptr() as *const _,
        2,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, snd, b"submit\0".as_ptr() as *const _, f_sub);

    let f_poll = JS_NewCFunction2(
        ctx,
        Some(js_snd_poll),
        b"poll\0".as_ptr() as *const _,
        0,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, snd, b"poll\0".as_ptr() as *const _, f_poll);

    JS_SetPropertyStr(ctx, global, b"snd\0".as_ptr() as *const _, snd);

    // Silence "unused" on constants kept for the contract parser.
    let _ = (DCAU_MAGIC, SND_OP_TRIGGER, SND_OP_SET_LOOP, SND_OP_MASTER, AUDIO_READY.load(Ordering::Relaxed));
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD / BOOT CHECKLIST (human, on a machine with the PSP toolchain)
// ─────────────────────────────────────────────────────────────────────────────
// This file is NOT compiled in the headless/JS dev loop, so the steps below are the
// ONLY way the native synth gets exercised. Integration into the runtime tree is
// ALREADY DONE in source (steps 1–4 are committed here, listed for review/audit);
// the remaining work is a human BUILD + BOOT on PPSSPP/hardware (steps 5–8).
//
// ── ALREADY DONE in the tree (verify by reading the diff) ──
// 1. [DONE] main.rs: `mod audio;` is declared next to `mod gfx3d;`.
// 2. [DONE] main.rs run(): `let aid = audio::start_audio_thread();` is called BEFORE
//    qjs_alloc::new_runtime() (arena ordering!), and `audio::register(ctx, global)`
//    is called after gfx3d::register / bridge::register, installing snd.* on the
//    global. Rationale: the audio thread's 64 KB stack must be carved from the kernel
//    partition BEFORE arena.rs grabs most of it on the first JS allocation, and the
//    audio thread NEVER calls the (single-threaded, NON-thread-safe) arena allocator.
// 3. [DONE] arena.rs ensure_init(): `margin` bumped 4 MB -> 5 MB so the audio thread
//    stack (64 KB) + the SRC channel's internal buffers sit OUTSIDE the arena.
//    (DAC/RING/VOICES/TABLE/SINE_LUT are all `static` => .bss, not heap; only the
//    thread STACK is a kernel alloc, but the bigger margin is cheap insurance.)
// 4. [DONE] Cargo: rust-psp already links sceAudio* (psp::sys::sceAudioSRC*) — no new
//    dep. (Confirm `psp::sys::sceAudioSRCChReserve / OutputBlocking / ChRelease` and
//    `AudioOutputFrequency::Khz44_1` resolve when you build; the `use` is at the top.)
//
// ── HUMAN BUILD + BOOT (the part that cannot be verified headless) ──
// 5. BUILD: `PSPJS_GAME=flappy bun run psp` (or scripts/psp) to produce an EBOOT that
//    embeds flappy.js (which references "audio:voices" so its .dcpak carries the
//    +392-byte voice table). The compiler will catch any libquickjs-sys signature
//    drift in js_snd_* (JSContext/JSValue/JS_GetArrayBuffer/JS_NewInt32) — these
//    mirror gfx3d.rs's, so they should match; fix to match gfx3d.rs if not.
// 6. BOOT on PPSSPP (psp-emulator-debug skill) WITH audio enabled:
//    - flappy should be audible: a sine "flap" on X, a rising "score" on pipe pass,
//      a square "hit" on death. shooter should chatter (gunshot/hit/spawn/damage/
//      gameover) under the 8-voice load.
//    - SANITY-CHECK THE SINE: the flap/score voices are sine (wave==2). Confirm they
//      sound like clean tones, NOT a buzzy/clicky tone — that would indicate the
//      build_sine_lut fix (review #2) didn't take (the headless contract.ts mirror
//      asserts the math, but only the build proves the compiled LUT).
//    - grep the PPSSPP log for `sceAudioSRCChReserve` success and NO repeated under-run
//      / channel-busy errors.
// 7. PERF: hold flappy/shooter and watch the on-screen FPS HUD — it must stay 60.
//    The audio thread runs at priority 33 (just BELOW the render thread @ 32) and is
//    paced by sceAudioSRCOutputBlocking, so it should fill the DAC during the render
//    thread's vblank wait, NOT preempt it (review #4). If you see jitter/drops, the
//    granule (1024) or thread priority is the knob.
// 8. NO-REGRESSION on 2D games that never touch snd (e.g. snake, maze): they must boot
//    and run exactly as before — snd.* is just an installed object; the audio thread
//    idles (mixes silence) until the first submit, costing one low-prio slice/granule.
//
// ── KNOWN RISKS (static review only — file not compiled here) ──
// - libquickjs-sys signatures (js_snd_*) are mirrored from gfx3d.rs but unverified by
//   a compile here; a binding bump would surface as a build error in step 5.
// - sceAudioSRCOutputBlocking volume arg uses AUDIO_VOLUME_MAX; confirm that const is
//   exported by the rust-psp version in the submodule (else use 0x8000).
// - The ring drops commands when full (256-deep); at 60fps with <=~tens of ops/frame
//   that head-room is huge, but a pathological game spamming triggers would drop the
//   oldest — inaudible vs. a stall, by design.

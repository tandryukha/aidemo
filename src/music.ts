import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "./util.js";

/**
 * Synthesizes a background-music bed from scratch — pure math, no samples — so
 * the track is **license-free by construction** (the repo ships no bundled bed,
 * and "grab something off YouTube" isn't safe for a submission video). Soft
 * ambient-corporate: warm detuned pad, gentle pluck arpeggio, round bass pulse.
 * C–G–Am–F at 92 BPM, ~106 s, 44.1 kHz stereo WAV.
 *
 * Feed the result to a storyboard's `music.track`; it ducks under narration
 * (sidechain) and swells in the gaps automatically.
 */

const SR = 44100;
const BPM = 92;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const CYCLES = 10; // 4-bar progression x10 = ~104 s
const BARS = CYCLES * 4;
const TAIL = 2.0;

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
// C – G – Am – F, close voicings around C3–C4; bass roots an octave-ish down.
const PROG = [
  { pad: [48, 52, 55, 60], bass: 36 }, // C
  { pad: [47, 50, 55, 59], bass: 43 }, // G
  { pad: [45, 52, 57, 60], bass: 45 }, // Am
  { pad: [45, 53, 57, 60], bass: 41 }, // F
];

// Deterministic per-oscillator phase so voices don't all start phase-aligned.
const phase0 = (a: number, b: number, c: number) =>
  ((a * 12.9898 + b * 78.233 + c * 37.719) % 1) * 2 * Math.PI;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

interface Tone {
  ch: Float64Array;
  f: number;
  t0: number;
  dur: number;
  amp: number;
  attack: number;
  release: number;
  partials: number[];
  tau?: number;
}

/** Render a single enveloped additive tone into a channel buffer. */
function addTone(N: number, { ch, f, t0, dur, amp, attack, release, partials, tau }: Tone): void {
  const s0 = Math.max(0, Math.round(t0 * SR));
  const s1 = Math.min(N, Math.round((t0 + dur + release) * SR));
  const ph = partials.map((_, k) => phase0(f, k, t0));
  for (let s = s0; s < s1; s++) {
    const t = s / SR - t0;
    let env = smooth(t / attack);
    if (t > dur) env *= 1 - smooth((t - dur) / release);
    if (tau) env *= Math.exp(-t / tau);
    if (env <= 0) continue;
    let v = 0;
    for (let k = 0; k < partials.length; k++) {
      v += partials[k] * Math.sin(2 * Math.PI * f * (k + 1) * (s / SR) + ph[k]);
    }
    ch[s] += v * amp * env;
  }
}

const PAD_PARTIALS = [1, 0.38, 0.14, 0.05];

/** Build the stereo PCM and write a 16-bit WAV to `outPath`. */
export async function synthesizeMusicBed(
  outPath: string
): Promise<{ durationSec: number }> {
  const DUR = BARS * BAR + TAIL;
  const N = Math.round(DUR * SR);
  const L = new Float64Array(N);
  const R = new Float64Array(N);

  for (let b = 0; b < BARS; b++) {
    const t0 = b * BAR;
    const { pad, bass } = PROG[b % 4];

    // Pad: two detuned voices per note, split wide L/R for chorus width.
    for (const m of pad) {
      const f = midiHz(m);
      addTone(N, { ch: L, f: f * 0.9982, t0, dur: BAR, amp: 0.055, attack: 0.9, release: 1.6, partials: PAD_PARTIALS });
      addTone(N, { ch: R, f: f * 1.0018, t0, dur: BAR, amp: 0.055, attack: 0.9, release: 1.6, partials: PAD_PARTIALS });
      addTone(N, { ch: L, f: f * 1.0009, t0, dur: BAR, amp: 0.030, attack: 1.1, release: 1.6, partials: PAD_PARTIALS });
      addTone(N, { ch: R, f: f * 0.9991, t0, dur: BAR, amp: 0.030, attack: 1.1, release: 1.6, partials: PAD_PARTIALS });
    }

    // Bass: round sine pulse on beats 1 and 3 (softer echo on 3).
    const fb = midiHz(bass);
    addTone(N, { ch: L, f: fb, t0, dur: BEAT * 1.7, amp: 0.16, attack: 0.05, release: 0.35, partials: [1, 0.25] });
    addTone(N, { ch: R, f: fb, t0, dur: BEAT * 1.7, amp: 0.16, attack: 0.05, release: 0.35, partials: [1, 0.25] });
    addTone(N, { ch: L, f: fb, t0: t0 + 2 * BEAT, dur: BEAT * 1.5, amp: 0.11, attack: 0.05, release: 0.35, partials: [1, 0.25] });
    addTone(N, { ch: R, f: fb, t0: t0 + 2 * BEAT, dur: BEAT * 1.5, amp: 0.11, attack: 0.05, release: 0.35, partials: [1, 0.25] });

    // Pluck arpeggio: eighth notes over chord tones one octave up, ping-pong pan.
    const order = [0, 2, 1, 3, 2, 0, 3, 1];
    for (let i = 0; i < 8; i++) {
      if (i === 5) continue; // leave one eighth of air per bar
      const m = pad[order[i]] + 12;
      const f = midiHz(m);
      const tN = t0 + i * (BEAT / 2);
      const even = i % 2 === 0;
      addTone(N, { ch: even ? L : R, f, t0: tN, dur: 0.9, amp: 0.055, attack: 0.004, release: 0.1, partials: [1, 0.3], tau: 0.17 });
      addTone(N, { ch: even ? R : L, f, t0: tN, dur: 0.9, amp: 0.028, attack: 0.004, release: 0.1, partials: [1, 0.3], tau: 0.17 });
    }
  }

  // Slow movement LFO on the whole bed + master fades.
  for (let s = 0; s < N; s++) {
    const t = s / SR;
    const lfo = 1 + 0.07 * Math.sin(2 * Math.PI * 0.045 * t + 1.3);
    let g = lfo * smooth(t / 1.5); // 1.5 s fade-in
    const left = DUR - t;
    if (left < 4) g *= smooth(left / 4); // 4 s fade-out
    L[s] *= g;
    R[s] *= g;
  }

  // Normalize to a comfortable bed level.
  let peak = 0;
  for (let s = 0; s < N; s++) peak = Math.max(peak, Math.abs(L[s]), Math.abs(R[s]));
  const norm = 0.72 / (peak || 1);

  const pcm = Buffer.alloc(N * 4);
  for (let s = 0; s < N; s++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[s] * norm)) * 32767), s * 4);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[s] * norm)) * 32767), s * 4 + 2);
  }

  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); // PCM
  hdr.writeUInt16LE(2, 22); // stereo
  hdr.writeUInt32LE(SR, 24);
  hdr.writeUInt32LE(SR * 4, 28);
  hdr.writeUInt16LE(4, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(pcm.length, 40);

  await ensureDir(dirname(outPath));
  await fs.writeFile(outPath, Buffer.concat([hdr, pcm]));
  return { durationSec: DUR };
}

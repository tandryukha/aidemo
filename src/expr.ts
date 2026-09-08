/**
 * Shared helpers for building ffmpeg filter *expressions* from keyframes.
 *
 * ffmpeg's expression evaluator has two independent cliffs, and both bite once
 * a demo gets long enough:
 *
 *  1. **Parser nesting.** A chain of nested `if(...)`s dies with
 *     `Missing ')' or too many args` about a hundred levels deep. A 13-scene
 *     take with ~40 focus points hit this in the zoom pass (issue #36).
 *  2. **AST size.** Past roughly a hundred flat terms the evaluator allocates
 *     until it fails (ENOMEM) — measured ~80 OK / 120 fail on a stock build.
 *
 * So every expression here is emitted as a FLAT sum of disjoint half-open
 * gated segments (depth ~3 regardless of key count), and every channel is
 * first simplified (Ramer–Douglas–Peucker) to a key budget that stays well
 * under cliff 2.
 */

export interface Key {
  /** Seconds. */
  t: number;
  v: number;
}

/** Format a number for an ffmpeg expression (no trailing zeros, no `NaN`). */
export function num(n: number): string {
  const s = n.toFixed(4).replace(/\.?0+$/, "");
  return s === "" || s === "-" ? "0" : s;
}

/** Linear-interpolation (vertical) error at `p` against the a→b chord. */
function chordError(a: Key, b: Key, p: Key): number {
  const dt = b.t - a.t;
  const vAt = dt < 1e-9 ? a.v : a.v + ((b.v - a.v) * (p.t - a.t)) / dt;
  return Math.abs(p.v - vAt);
}

/**
 * Ramer–Douglas–Peucker on a value-over-time polyline, using vertical error in
 * the value's own units — so `eps` is exactly "how far the drawn channel may
 * drift from the planned one". Keeps the points where the curve actually
 * bends; a straight or held stretch collapses to its endpoints. Iterative to
 * avoid deep recursion on long inputs.
 */
export function rdp(keys: Key[], eps: number): Key[] {
  const n = keys.length;
  if (n <= 2) return keys.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    let maxErr = -1;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const e = chordError(keys[lo], keys[hi], keys[i]);
      if (e > maxErr) {
        maxErr = e;
        idx = i;
      }
    }
    if (maxErr > eps && idx >= 0) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out: Key[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(keys[i]);
  return out;
}

/**
 * Simplify one channel to at most `budget` keys: start at `eps` and grow it
 * until the point count fits, so a busy channel just drifts slightly more
 * rather than blowing the expression budget.
 */
export function simplifyKeys(keys: Key[], budget: number, eps: number): Key[] {
  if (keys.length <= budget) {
    const r = rdp(keys, eps);
    if (r.length <= budget) return r;
  }
  let e = eps;
  for (let i = 0; i < 24; i++) {
    const r = rdp(keys, e);
    if (r.length <= budget) return r;
    e *= 1.6;
  }
  // Backstop: uniform thin (should never be reached for a real channel).
  const step = Math.ceil(keys.length / budget);
  const out = keys.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== keys[keys.length - 1]) out.push(keys[keys.length - 1]);
  return out;
}

type Interp = "linear" | "smooth";

/**
 * Piecewise expression over the time expression `T` (seconds): holds the first
 * value before the first key, interpolates between keys (linearly, or with a
 * smoothstep ease), holds the last value after the last key.
 *
 * Emitted as a flat sum of half-open gated terms — see the module header for
 * why nesting `if`s is not an option.
 */
export function piecewiseExpr(keys: Key[], T: string, interp: Interp): string {
  if (keys.length === 0) return "0";
  if (keys.length === 1) return num(keys[0].v);
  const first = keys[0];
  const last = keys[keys.length - 1];
  const terms: string[] = [`lt(${T},${num(first.t)})*${num(first.v)}`];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    const dt = b.t - a.t;
    const gate = `gte(${T},${num(a.t)})*lt(${T},${num(b.t)})`;
    if (a.v === b.v || dt < 1e-6) {
      terms.push(`${gate}*${num(a.v)}`);
    } else if (interp === "linear") {
      const slope = (b.v - a.v) / dt;
      terms.push(`${gate}*(${num(a.v)}+(${num(slope)})*(${T}-${num(a.t)}))`);
    } else {
      const p = `((${T}-${num(a.t)})/${num(dt)})`;
      terms.push(`${gate}*(${num(a.v)}+(${num(b.v - a.v)})*${p}*${p}*(3-2*${p}))`);
    }
  }
  terms.push(`gte(${T},${num(last.t)})*${num(last.v)}`);
  return terms.join("+");
}

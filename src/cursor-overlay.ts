/**
 * Compose-time cursor overlay. The default pipeline BAKES the cursor into the
 * recording (src/cursor.ts). When a storyboard opts into `cursor` control, the
 * take is recorded cursor-free and the player logs the cursor path
 * (timeline `cursorSamples`); compose then draws the cursor as an overlay along
 * that path so hide/resize is a recompose, never a re-record.
 *
 * The path is replayed with the same piecewise-expression trick as the auto-zoom
 * (src/zoom.ts): overlay the cursor PNG at x='X(t)':y='Y(t)', where X/Y are
 * piecewise-LINEAR over the recorded samples (the samples are already eased, so
 * linear interpolation between them preserves the glide). Portable — `overlay`
 * is the same baseline filter the caption strip uses. Applied to the content
 * BEFORE the zoom pass, so the cursor zooms and pans with the frame, exactly
 * like the baked one.
 */

/** A cursor sample already mapped into final content time + output pixels. */
export interface CursorPoint {
  /** Content-time seconds. */
  t: number;
  /** Output pixels (viewport CSS px * pxScale). */
  x: number;
  y: number;
}

/** A content-time span (seconds) during which the cursor is hidden. */
export interface HideWindow {
  a: number;
  b: number;
}

/**
 * Per-axis key budget. ffmpeg's expression evaluator allocates an AST and blows
 * up (ENOMEM) somewhere past ~100 flat terms — measured ~80 OK / 120 fail on a
 * stock build. X(t) and Y(t) are INDEPENDENT overlay expressions, so this budget
 * is per axis; keeping it well under the cliff (and small) also protects weaker
 * ffmpeg builds. The path is simplified to fit (simplifyAxis) — cheap, because
 * the player's glides are eased S-curves that RDP collapses to a few keys each.
 */
const KEY_BUDGET = 48;

interface Key {
  t: number;
  v: number;
}

function num(n: number): string {
  const s = n.toFixed(3).replace(/\.?0+$/, "");
  return s === "" || s === "-" ? "0" : s;
}

/** Linear-interpolation (vertical) error at `p` against the a→b chord. */
function chordError(a: Key, b: Key, p: Key): number {
  const dt = b.t - a.t;
  const vAt = dt < 1e-9 ? a.v : a.v + ((b.v - a.v) * (p.t - a.t)) / dt;
  return Math.abs(p.v - vAt);
}

/**
 * Ramer–Douglas–Peucker on a value-over-time polyline, using vertical (linear-
 * interpolation) error in the value's own units (pixels) — so `eps` is exactly
 * "max pixels the drawn cursor may drift from the recorded path". Keeps the
 * points where the curve actually bends; a straight or held stretch collapses to
 * its endpoints. Iterative to avoid deep recursion on long inputs.
 */
function rdp(keys: Key[], eps: number): Key[] {
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
 * Simplify one axis to at most KEY_BUDGET keys: start at a sub-pixel epsilon and
 * grow it until the point count fits, so a busy path just drifts a pixel or two
 * more rather than blowing the expression budget.
 */
function simplifyAxis(keys: Key[]): Key[] {
  if (keys.length <= KEY_BUDGET) {
    const r = rdp(keys, 1.2);
    if (r.length <= KEY_BUDGET) return r;
  }
  let eps = 1.2;
  for (let i = 0; i < 24; i++) {
    const r = rdp(keys, eps);
    if (r.length <= KEY_BUDGET) return r;
    eps *= 1.6;
  }
  // Backstop: uniform thin (should never be reached for a real cursor path).
  const step = Math.ceil(keys.length / KEY_BUDGET);
  const out = keys.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== keys[keys.length - 1]) out.push(keys[keys.length - 1]);
  return out;
}

/**
 * Piecewise-linear expression over overlay's `t` (seconds): holds the first
 * value before the first key, linearly interpolates between keys, holds the last
 * value after the last.
 *
 * Emitted as a FLAT sum of half-open gated segments — NOT nested `if`s. A path
 * has dozens–hundreds of keys, and ffmpeg's expression parser blows its nesting
 * limit ("Missing ')' or too many args") a hundred `if`s deep (zoom.ts gets away
 * with nested `if` only because it has a handful of keys). Each segment
 * [t_i, t_{i+1}) contributes `gte(t,t_i)*lt(t,t_{i+1})*(v_i + slope*(t-t_i))`;
 * the gates are disjoint half-open intervals so exactly one term is live at a
 * time. Depth stays ~3 regardless of key count.
 */
function piecewiseLinear(keys: Key[]): string {
  if (keys.length === 1) return num(keys[0].v);
  const first = keys[0];
  const last = keys[keys.length - 1];
  const terms: string[] = [`lt(t,${num(first.t)})*${num(first.v)}`];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    const dt = b.t - a.t;
    const gate = `gte(t,${num(a.t)})*lt(t,${num(b.t)})`;
    if (a.v === b.v || dt < 1e-6) {
      terms.push(`${gate}*${num(a.v)}`);
    } else {
      const slope = (b.v - a.v) / dt;
      terms.push(`${gate}*(${num(a.v)}+(${num(slope)})*(t-${num(a.t)}))`);
    }
  }
  terms.push(`gte(t,${num(last.t)})*${num(last.v)}`);
  return terms.join("+");
}

/**
 * Build the `-filter_complex` string overlaying the cursor PNG (input 1) onto
 * the content (input 0) along `rawPts`, hidden during `hideWindows`. Returns
 * null when there's nothing to draw (no samples). The PNG's top-left tracks the
 * point — the same anchor the baked cursor used (translate(x,y)), so the arrow
 * tip lands identically.
 */
export function buildCursorFilter(
  rawPts: CursorPoint[],
  hideWindows: HideWindow[] = []
): string | null {
  if (rawPts.length === 0) return null;
  const sorted = [...rawPts].sort((p, q) => p.t - q.t);
  // Strictly-increasing time so each segment has a positive span.
  const mono: CursorPoint[] = [];
  for (const p of sorted) {
    const last = mono[mono.length - 1];
    mono.push(last && p.t <= last.t ? { ...p, t: last.t + 0.001 } : p);
  }
  // Simplify each axis independently (X and Y are separate expressions) so each
  // stays under the ffmpeg expression budget.
  const X = piecewiseLinear(simplifyAxis(mono.map((p) => ({ t: p.t, v: p.x }))));
  const Y = piecewiseLinear(simplifyAxis(mono.map((p) => ({ t: p.t, v: p.y }))));

  // enable is single-quoted so the commas inside between()/not() are literal,
  // not filtergraph separators (same reason zoom single-quotes its expressions).
  let enable = "";
  if (hideWindows.length) {
    const terms = hideWindows
      .map((w) => `between(t,${num(w.a)},${num(w.b)})`)
      .join("+");
    enable = `:enable='not(${terms})'`;
  }
  return `[0:v][1:v]overlay=x='${X}':y='${Y}':eval=frame${enable}[vout]`;
}

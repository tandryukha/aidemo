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

import { type Key, num, piecewiseExpr, simplifyKeys } from "./expr.js";

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
 * ffmpeg builds. The path is simplified to fit (expr.ts simplifyKeys) — cheap, because
 * the player's glides are eased S-curves that RDP collapses to a few keys each.
 */
const KEY_BUDGET = 48;

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
  const axis = (vals: Key[]): string =>
    piecewiseExpr(simplifyKeys(vals, KEY_BUDGET, 1.2), "t", "linear");
  const X = axis(mono.map((p) => ({ t: p.t, v: p.x })));
  const Y = axis(mono.map((p) => ({ t: p.t, v: p.y })));

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

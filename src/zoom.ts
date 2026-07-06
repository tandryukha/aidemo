import type { ZoomConfig } from "./types.js";

/**
 * Screen-Studio-style auto-zoom, rendered at compose time with ffmpeg's
 * `zoompan`. The player records focus events (clicks / typing / explicit
 * `focus` actions); compose maps them into final-video time and this module
 * turns them into eased zoom choreography:
 *
 *   idle 1.0x → ease in to `scale` just before the click → hold → ease back
 *
 * Consecutive focus points closer together than a hold+ease don't bounce out
 * and in again — the camera stays zoomed and *pans* between them.
 *
 * Everything is emitted as piecewise smoothstep ffmpeg expressions over output
 * time (`on/fps`), one channel each for zoom, center-x and center-y.
 */

/** A focus point in FINAL video time, coordinates in output-video pixels. */
export interface ZoomEvent {
  tMs: number;
  x: number;
  y: number;
  scale?: number;
  holdMs?: number;
}

interface Key {
  t: number; // seconds
  v: number;
}

/** Append a keyframe, nudging time forward to keep the channel monotonic. */
function pushKey(keys: Key[], t: number, v: number): void {
  const last = keys[keys.length - 1];
  if (last && t <= last.t) t = last.t + 0.02;
  keys.push({ t, v });
}

const num = (n: number): string => {
  const s = n.toFixed(4).replace(/\.?0+$/, "");
  return s === "" || s === "-" ? "0" : s;
};

/**
 * Piecewise expression over `T` (a time expression in seconds): holds the
 * first value before the first key, smoothsteps between keys, holds the last
 * value after the last key.
 */
function piecewise(keys: Key[], T: string): string {
  let expr = num(keys[keys.length - 1].v);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i];
    const b = keys[i + 1];
    let seg: string;
    if (a.v === b.v || b.t - a.t < 1e-6) {
      seg = num(a.v);
    } else {
      const p = `((${T}-${num(a.t)})/${num(b.t - a.t)})`;
      seg = `(${num(a.v)}+(${num(b.v - a.v)})*${p}*${p}*(3-2*${p}))`;
    }
    expr = `if(lt(${T},${num(b.t)}),${seg},${expr})`;
  }
  // Guard the span before the first key (p would be negative in seg 0).
  return `if(lt(${T},${num(keys[0].t)}),${num(keys[0].v)},${expr})`;
}

/**
 * Build the zoom/pan keyframes for all three channels.
 * Exported for tests/debugging; buildZoomFilter is the real entry point.
 */
export function planZoom(
  events: ZoomEvent[],
  cfg: ZoomConfig,
  outW: number,
  outH: number,
  durMs: number
): { z: Key[]; cx: Key[]; cy: Key[] } | null {
  const dur = durMs / 1000;
  const ease = Math.max(0.15, cfg.easeMs / 1000);
  const sorted = [...events]
    .filter((e) => e.tMs >= 0 && e.tMs < durMs)
    .sort((a, b) => a.tMs - b.tMs);
  if (sorted.length === 0) return null;

  const z: Key[] = [{ t: 0, v: 1 }];
  const cx: Key[] = [{ t: 0, v: outW / 2 }];
  const cy: Key[] = [{ t: 0, v: outH / 2 }];

  let zoomed = false;
  let lastZ = 1;
  let lastX = outW / 2;
  let lastY = outH / 2;

  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const t = e.tMs / 1000;
    const scale = Math.min(4, Math.max(1.05, e.scale ?? cfg.scale));
    const hold = Math.max(0.2, (e.holdMs ?? cfg.holdMs) / 1000);
    const ex = Math.min(outW, Math.max(0, e.x));
    const ey = Math.min(outH, Math.max(0, e.y));

    if (!zoomed) {
      // Ease in, starting a beat before the click so the click lands zoomed.
      const inStart = Math.max(0, t - ease * 0.35);
      const inEnd = inStart + ease;
      pushKey(z, inStart, 1);
      pushKey(z, inEnd, scale);
      // While z=1 the center is invisible — snap it to the new focus point.
      pushKey(cx, inStart, ex);
      pushKey(cy, inStart, ey);
    } else {
      // Already zoomed: pan (and rescale if needed) to the new focus point.
      const panDur = Math.min(ease, 0.8);
      const panStart = Math.max(0, t - panDur * 0.5);
      const panEnd = panStart + panDur;
      pushKey(cx, panStart, lastX);
      pushKey(cx, panEnd, ex);
      pushKey(cy, panStart, lastY);
      pushKey(cy, panEnd, ey);
      if (scale !== lastZ) {
        pushKey(z, panStart, lastZ);
        pushKey(z, panEnd, scale);
      }
    }

    // Zoom out after the hold — unless the next focus point arrives before
    // we'd finish bouncing out; then stay zoomed and let the pan handle it.
    const holdEnd = t + hold;
    const next = sorted[i + 1];
    const nextInStart = next ? next.tMs / 1000 - ease * 0.35 : Infinity;
    if (nextInStart < holdEnd + ease) {
      zoomed = true;
    } else {
      const outStart = Math.min(holdEnd, Math.max(0, dur - ease));
      pushKey(z, outStart, scale);
      pushKey(z, outStart + ease, 1);
      // Pin the center through the zoom-out so it doesn't drift mid-move.
      pushKey(cx, outStart, ex);
      pushKey(cy, outStart, ey);
      zoomed = false;
    }
    lastZ = scale;
    lastX = ex;
    lastY = ey;
  }

  return { z, cx, cy };
}

/**
 * Full `-vf` filter string applying the auto-zoom to a CFR video of
 * outW x outH at `fps`, or null when there is nothing to zoom. For SD-ish
 * sources the frame is upscaled 2x first so zoompan's integer-pixel crop
 * doesn't shimmer and a 1.5x zoom stays sharp.
 */
export function buildZoomFilter(
  events: ZoomEvent[],
  cfg: ZoomConfig,
  outW: number,
  outH: number,
  durMs: number,
  fps: number
): string | null {
  const plan = planZoom(events, cfg, outW, outH, durMs);
  if (!plan) return null;

  const up = outW < 1600 ? 2 : 1;
  const T = `on/${fps}`;
  const zExpr = piecewise(plan.z, T);
  const scaleKeys = (keys: Key[]): Key[] =>
    keys.map((k) => ({ t: k.t, v: k.v * up }));
  const cxExpr = piecewise(scaleKeys(plan.cx), T);
  const cyExpr = piecewise(scaleKeys(plan.cy), T);

  const xExpr = `clip(${cxExpr}-(iw/zoom)/2,0,iw-iw/zoom)`;
  const yExpr = `clip(${cyExpr}-(ih/zoom)/2,0,ih-ih/zoom)`;
  const pre = up > 1 ? `scale=${outW * up}:${outH * up}:flags=lanczos,` : "";
  return (
    pre +
    `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}'` +
    `:d=1:s=${outW}x${outH}:fps=${fps}`
  );
}

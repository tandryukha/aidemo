import type { ZoomConfig } from "./types.js";
import { type Key, piecewiseExpr } from "./expr.js";

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
 * time (`on/fps`), one channel each for zoom, center-x and center-y — as a FLAT
 * gated sum, and simplified to a key budget, because a long take's worth of
 * focus points overflows ffmpeg's expression parser otherwise (see expr.ts).
 */

/**
 * Per-channel key budget. zoom/x/y are three INDEPENDENT expressions, so this
 * is per channel; it is deliberately well under ffmpeg's ~100-term AST cliff
 * because each term references the time expression three times.
 */
const KEY_BUDGET = 56;

/**
 * Smallest slice of the page, in LOGICAL (storyboard) pixels, that a zoom is
 * allowed to leave visible horizontally. A scale tuned on a 1440px desktop
 * viewport crops a 430px mobile take to ribbons — 1.35x cost the question
 * headline its left edge on every click (issue #38). Anything at or below this
 * width stops zooming further in.
 */
const MIN_VISIBLE_LOGICAL_WIDTH = 360;

/**
 * Cap `scale` so a zoom never leaves less than MIN_VISIBLE_LOGICAL_WIDTH of the
 * page in frame. Returns the configured scale unchanged on desktop-width takes.
 */
export function clampScaleForWidth(scale: number, logicalWidth: number): number {
  if (logicalWidth <= 0) return scale;
  const max = Math.max(1.05, logicalWidth / MIN_VISIBLE_LOGICAL_WIDTH);
  return Math.min(scale, max);
}

/** A focus point in FINAL video time, coordinates in output-video pixels. */
export interface ZoomEvent {
  tMs: number;
  x: number;
  y: number;
  scale?: number;
  holdMs?: number;
}

/** Append a keyframe, nudging time forward to keep the channel monotonic. */
function pushKey(keys: Key[], t: number, v: number): void {
  const last = keys[keys.length - 1];
  if (last && t <= last.t) t = last.t + 0.02;
  keys.push({ t, v });
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
 * Plan the zoom, thinning focus events until every channel fits KEY_BUDGET.
 *
 * A long take can carry forty-plus focus points, and each one costs a handful
 * of keys per channel — more than ffmpeg's expression evaluator will take
 * (see expr.ts). Simplifying the CURVE is the wrong lever here: the zoom
 * channel is a train of bounces, and smoothing it enough to fit flattens the
 * zoom out of existence. Dropping whole focus points keeps every surviving
 * beat at full amplitude, evenly spread across the demo — the same trade the
 * author would make by hand, and it is logged so it is not a surprise.
 */
function planWithinBudget(
  events: ZoomEvent[],
  cfg: ZoomConfig,
  outW: number,
  outH: number,
  durMs: number
): { plan: ReturnType<typeof planZoom>; dropped: number } {
  let use = events;
  for (let i = 0; i < 24; i++) {
    const plan = planZoom(use, cfg, outW, outH, durMs);
    if (!plan) return { plan, dropped: 0 };
    const worst = Math.max(plan.z.length, plan.cx.length, plan.cy.length);
    if (worst <= KEY_BUDGET || use.length <= 2) {
      return { plan, dropped: events.length - use.length };
    }
    // Thin proportionally to the overshoot, keeping an even spread.
    const keep = Math.max(2, Math.floor((use.length * KEY_BUDGET) / worst));
    const step = use.length / keep;
    const next: ZoomEvent[] = [];
    for (let k = 0; k < keep; k++) next.push(use[Math.floor(k * step)]);
    use = next;
  }
  return { plan: planZoom(use, cfg, outW, outH, durMs), dropped: events.length - use.length };
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
  fps: number,
  /** Storyboard (logical) viewport width, for the narrow-viewport scale cap. */
  logicalWidth = outW,
  /** Called when focus events had to be thinned to fit the key budget. */
  onThin?: (dropped: number, total: number) => void
): string | null {
  const capped: ZoomConfig = {
    ...cfg,
    scale: clampScaleForWidth(cfg.scale, logicalWidth),
  };
  const clamped = events.map((e) =>
    e.scale == null
      ? e
      : { ...e, scale: clampScaleForWidth(e.scale, logicalWidth) }
  );
  const { plan, dropped } = planWithinBudget(clamped, capped, outW, outH, durMs);
  if (!plan) return null;
  if (dropped > 0) onThin?.(dropped, clamped.length);

  const up = outW < 1600 ? 2 : 1;
  const T = `on/${fps}`;
  const scaleKeys = (keys: Key[]): Key[] =>
    keys.map((k) => ({ t: k.t, v: k.v * up }));
  const zExpr = piecewiseExpr(plan.z, T, "smooth");
  const cxExpr = piecewiseExpr(scaleKeys(plan.cx), T, "smooth");
  const cyExpr = piecewiseExpr(scaleKeys(plan.cy), T, "smooth");

  const xExpr = `clip(${cxExpr}-(iw/zoom)/2,0,iw-iw/zoom)`;
  const yExpr = `clip(${cyExpr}-(ih/zoom)/2,0,ih-ih/zoom)`;
  const pre = up > 1 ? `scale=${outW * up}:${outH * up}:flags=lanczos,` : "";
  return (
    pre +
    `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}'` +
    `:d=1:s=${outW}x${outH}:fps=${fps}`
  );
}

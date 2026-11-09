import type { NativeMark, StoreHold, StoreRamp, StoreScene } from "../types.js";

/**
 * The store-video edit plan: which parts of each scene clip play at 1x, which
 * are sped up (typing, waiting, still frames), and which are holds. Pure —
 * the ffmpeg side (src/store/video.ts) just executes it, and the unit tests
 * prove the rule "no still frame longer than maxStillMs unless it is a hold".
 */

export interface Span {
  startMs: number;
  endMs: number;
}
export interface RateSpan extends Span {
  rate: number;
}

export type SegmentKind = "play" | "ramp" | "still" | "hold";
export interface Segment {
  fromMs: number;
  toMs: number;
  rate: number;
  kind: SegmentKind;
}

export interface ScenePlan {
  segments: Segment[];
  /** Extra hold of the last frame (tpad clone), output ms. */
  tailHoldMs: number;
  /** Output duration (segments + tail hold), ms. */
  outMs: number;
  /** Hold windows in the scene's OUTPUT time — exempt from the still check. */
  holdsOut: Span[];
}

export interface PlanOptions {
  maxStillMs: number;
  stillKeepMs: number;
  defaultRampRate: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = { maxStillMs: 700, stillKeepMs: 250, defaultRampRate: 4 };

/** One output frame at 30 fps; shorter pieces are dropped. */
const MIN_OUT_MS = 1000 / 30;

/** Normalize "inputText" / "inputTextCommand" / "InputText" to one key. */
export function commandKey(c: string): string {
  return c.replace(/Command$/, "").toLowerCase();
}

function spansFor(
  span: { label?: string; command?: string; fromMs?: number; toMs?: number },
  marks: NativeMark[],
  what: string,
  sceneId: string
): Span[] {
  if (span.fromMs != null && span.toMs != null) {
    if (span.toMs <= span.fromMs) throw new Error(`scene "${sceneId}": ${what} toMs must be after fromMs`);
    return [{ startMs: span.fromMs, endMs: span.toMs }];
  }
  const hits = marks.filter(
    (m) =>
      (span.label != null && m.label === span.label) ||
      (span.command != null && commandKey(m.command) === commandKey(span.command))
  );
  if (!hits.length) {
    const key = span.label != null ? `label "${span.label}"` : `command "${span.command}"`;
    const known = [...new Set(marks.map((m) => m.label ?? m.command))].join(", ") || "none";
    throw new Error(
      `scene "${sceneId}": ${what} ${key} matches no recorded Maestro command (recorded: ${known}). ` +
        `Re-record after adding \`label:\` to the flow step, or use fromMs/toMs.`
    );
  }
  return hits.map((m) => ({ startMs: m.startMs, endMs: Math.max(m.endMs, m.startMs + 1) }));
}

export function resolveRamps(scene: StoreScene, marks: NativeMark[], defaultRate: number): RateSpan[] {
  return (scene.ramps ?? []).flatMap((r: StoreRamp) =>
    spansFor(r, marks, "ramp", scene.id).map((s) => ({ ...s, rate: r.rate ?? defaultRate }))
  );
}

export function resolveHolds(scene: StoreScene, marks: NativeMark[]): Span[] {
  return (scene.holds ?? []).flatMap((h: StoreHold) =>
    spansFor(h, marks, "hold", scene.id).map((s) =>
      h.afterMs != null ? { startMs: s.endMs, endMs: s.endMs + h.afterMs } : s
    )
  );
}

/**
 * The raw-clip window a scene is cut to. No `trim`: from just before the first recorded step to
 * shortly after the last (`fallback`). `startMs`/`endMs` are raw clip ms (legacy: either one alone
 * leaves the other side uncut). `endAfter` ends `afterMs` after the last step matching its
 * label/command, so the cut follows the flow across re-records.
 */
export function resolveTrim(
  scene: StoreScene,
  marks: NativeMark[],
  durationMs: number,
  fallback: { startMs: number; endMs: number }
): { startMs: number; endMs: number } {
  const t = scene.trim;
  if (!t) return fallback;
  const legacy = t.startMs != null || t.endMs != null;
  const startMs = t.startMs ?? (legacy ? 0 : fallback.startMs);
  let endMs = t.endMs ?? (legacy && !t.endAfter ? durationMs : fallback.endMs);
  if (t.endAfter) {
    const hits = spansFor(t.endAfter, marks, "trim.endAfter", scene.id);
    endMs = Math.min(durationMs, Math.max(...hits.map((h) => h.endMs)) + (t.endAfter.afterMs ?? 0));
  }
  if (endMs <= startMs) throw new Error(`scene "${scene.id}": trim window ${startMs}–${endMs} ms is empty`);
  return { startMs, endMs };
}

/** Raw clip ms of a frame: `atMs`, or `afterMs` after the last recorded step matching `label` / `command`. */
export function frameTime(
  src: { atMs?: number; label?: string; command?: string; afterMs?: number },
  marks: NativeMark[],
  sceneId: string,
  durationMs?: number
): number {
  if (src.atMs != null) return src.atMs;
  const hits = spansFor(src, marks, "fromScene", sceneId);
  const t = Math.max(...hits.map((h) => h.endMs)) + (src.afterMs ?? 0);
  return durationMs != null ? Math.min(t, Math.max(0, durationMs - 34)) : t;
}

/** The store's duration window narrowed by the project's `video.minSec`/`maxSec`. */
export function durationWindow(
  preset: { minSec?: number; maxSec?: number },
  project: { minSec?: number; maxSec?: number } = {}
): { minSec?: number; maxSec?: number } {
  const pick = (a: number | undefined, b: number | undefined, f: (x: number, y: number) => number) =>
    a == null ? b : b == null ? a : f(a, b);
  const minSec = pick(preset.minSec, project.minSec, Math.max);
  const maxSec = pick(preset.maxSec, project.maxSec, Math.min);
  if (minSec != null && maxSec != null && minSec > maxSec)
    throw new Error(`video duration window is empty: at least ${minSec} s and at most ${maxSec} s`);
  return { minSec, maxSec };
}

function clip(s: Span, a: number, b: number): Span | null {
  const startMs = Math.max(a, s.startMs);
  const endMs = Math.min(b, s.endMs);
  return endMs > startMs ? { startMs, endMs } : null;
}

/** Length of `s` not covered by any of `holds`. */
function uncoveredMs(s: Span, holds: Span[]): number {
  let covered = 0;
  const parts = holds
    .map((h) => clip(h, s.startMs, s.endMs))
    .filter((x): x is Span => !!x)
    .sort((x, y) => x.startMs - y.startMs);
  let cursor = s.startMs;
  for (const p of parts) {
    const from = Math.max(cursor, p.startMs);
    if (p.endMs > from) covered += p.endMs - from;
    cursor = Math.max(cursor, p.endMs);
  }
  return s.endMs - s.startMs - covered;
}

export function planScene(input: {
  durationMs: number;
  trim?: { startMs?: number; endMs?: number };
  freezes: Span[];
  ramps: RateSpan[];
  holds: Span[];
  tailHoldMs?: number;
  options?: Partial<PlanOptions>;
}): ScenePlan {
  const o = { ...DEFAULT_PLAN_OPTIONS, ...input.options };
  const a = Math.max(0, input.trim?.startMs ?? 0);
  const b = Math.min(input.durationMs, input.trim?.endMs ?? input.durationMs);
  if (b - a < MIN_OUT_MS) throw new Error(`scene window ${a}–${b} ms is empty`);
  const holds = input.holds.map((h) => clip(h, a, b)).filter((x): x is Span => !!x);
  const ramps = input.ramps
    .map((r) => {
      const c = clip(r, a, b);
      return c ? { ...c, rate: r.rate } : null;
    })
    .filter((x): x is RateSpan => !!x);
  // A still is only a problem past maxStillMs of NON-hold time; it is ramped
  // so it lasts stillKeepMs on screen (0 = cut out).
  const stills = input.freezes
    .map((f) => clip(f, a, b))
    .filter((x): x is Span => !!x)
    .map((f) => ({ ...f, nonHold: uncoveredMs(f, holds) }))
    .filter((f) => f.nonHold > o.maxStillMs);

  const cuts = new Set<number>([a, b]);
  for (const s of [...holds, ...ramps, ...stills]) {
    cuts.add(s.startMs);
    cuts.add(s.endMs);
  }
  const points = [...cuts].sort((x, y) => x - y);
  const raw: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const s = points[i];
    const e = points[i + 1];
    if (e <= s) continue;
    const mid = (s + e) / 2;
    const inside = (x: Span) => x.startMs <= mid && mid < x.endMs;
    if (holds.some(inside)) {
      raw.push({ fromMs: s, toMs: e, rate: 1, kind: "hold" });
      continue;
    }
    let rate = 1;
    let kind: SegmentKind = "play";
    for (const r of ramps.filter(inside)) {
      if (r.rate > rate) {
        rate = r.rate;
        kind = "ramp";
      }
    }
    for (const f of stills.filter(inside)) {
      const r = o.stillKeepMs > 0 ? f.nonHold / o.stillKeepMs : Infinity;
      if (r > rate) {
        rate = r;
        kind = "still";
      }
    }
    raw.push({ fromMs: s, toMs: e, rate, kind });
  }
  // Merge neighbours that play the same way; drop sub-frame or cut pieces.
  const segments: Segment[] = [];
  for (const seg of raw) {
    const last = segments[segments.length - 1];
    if (last && last.kind === seg.kind && Math.abs(last.rate - seg.rate) < 1e-9 && last.toMs === seg.fromMs) {
      last.toMs = seg.toMs;
    } else segments.push({ ...seg });
  }
  const kept = segments.filter((s) => Number.isFinite(s.rate) && (s.toMs - s.fromMs) / s.rate >= MIN_OUT_MS);
  return finishPlan(kept, Math.max(0, input.tailHoldMs ?? 0));
}

function finishPlan(segments: Segment[], tailHoldMs: number): ScenePlan {
  const holdsOut: Span[] = [];
  let t = 0;
  for (const s of segments) {
    const d = (s.toMs - s.fromMs) / s.rate;
    if (s.kind === "hold") holdsOut.push({ startMs: t, endMs: t + d });
    t += d;
  }
  if (tailHoldMs > 0) {
    // The clone of the last frame, plus the frames just before it that may
    // already be still (the result has landed).
    holdsOut.push({ startMs: Math.max(0, t - 700), endMs: t + tailHoldMs });
  }
  return { segments, tailHoldMs, outMs: Math.round(t + tailHoldMs), holdsOut };
}

/**
 * Fit the edit into the store's duration window. Too long + `speed`: every
 * non-hold segment speeds up by one factor (holds and the end card keep their
 * time). Too short: always an error — the engine never pads with stills.
 */
export function fitPlans(
  plans: ScenePlan[],
  fixedMs: number,
  limits: { minMs?: number; maxMs?: number },
  mode: "fail" | "speed"
): { plans: ScenePlan[]; totalMs: number; speedFactor: number } {
  const total = plans.reduce((n, p) => n + p.outMs, 0) + fixedMs;
  if (limits.minMs != null && total < limits.minMs - 10) {
    throw new Error(
      `edit runs ${(total / 1000).toFixed(2)} s — the store needs at least ${limits.minMs / 1000} s. ` +
        `Add a scene, lengthen a hold/tailHoldMs, or lower a ramp rate; the engine never pads with still frames.`
    );
  }
  if (limits.maxMs == null || total <= limits.maxMs + 10) return { plans, totalMs: total, speedFactor: 1 };
  if (mode === "fail") {
    throw new Error(
      `edit runs ${(total / 1000).toFixed(2)} s — the store allows at most ${limits.maxMs / 1000} s. ` +
        `Trim scenes, add ramps, or set video.durationFit: "speed".`
    );
  }
  const flexible = plans.reduce(
    (n, p) => n + p.segments.filter((s) => s.kind !== "hold").reduce((m, s) => m + (s.toMs - s.fromMs) / s.rate, 0),
    0
  );
  const excess = total - (limits.maxMs - 100);
  if (flexible <= excess) throw new Error(`edit is ${(total / 1000).toFixed(1)} s and mostly holds — cannot speed it into ${limits.maxMs / 1000} s`);
  const k = flexible / (flexible - excess);
  const out = plans.map((p) =>
    finishPlan(
      p.segments.map((s) => (s.kind === "hold" ? s : { ...s, rate: s.rate * k })),
      p.tailHoldMs
    )
  );
  return { plans: out, totalMs: out.reduce((n, p) => n + p.outMs, 0) + fixedMs, speedFactor: k };
}

/**
 * Still spans in a FINAL video that break the rule: longer than maxStillMs
 * and not inside an allowed window (holds, the end card). `tolMs` absorbs
 * frame quantization.
 */
/**
 * Clamp freeze spans to a file's length. `probeFreezeSpans` reports a span
 * still frozen at EOF (a static end card) as unbounded; measured as-is it
 * would never be covered by the end-card allowance.
 */
export function clampSpans(spans: Span[], endMs: number): Span[] {
  return spans
    .map((f) => ({ startMs: f.startMs, endMs: Math.min(f.endMs, endMs) }))
    .filter((f) => f.endMs > f.startMs);
}

export function stillViolations(freezes: Span[], allowed: Span[], maxStillMs: number, tolMs = 120): Span[] {
  return freezes.filter((f) => uncoveredMs(f, allowed) > maxStillMs + tolMs);
}

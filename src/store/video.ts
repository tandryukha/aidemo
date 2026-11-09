import { promises as fs } from "node:fs";
import type { Project } from "../project.js";
import { probeDurationMs, probeFreezeSpans, probeVideoDims, runFfmpeg } from "../ffmpeg.js";
import type { NativeTimeline, StoreProject, StoreVideoPresetId } from "../types.js";
import { ensureDir, log, ok, step, writeJson } from "../util.js";
import { sceneHash } from "../native/record.js";
import { clampSpans, durationWindow, fitPlans, planScene, resolveHolds, resolveRamps, resolveTrim, stillViolations, type ScenePlan, type Span, DEFAULT_PLAN_OPTIONS, minCaptionedSceneMs } from "./plan.js";
import { posterTimeCode, storeVideoPreset, type StoreVideoPreset } from "./presets.js";
import { loadNativeTimeline, loadStoreProject, localized, resolveIn, storePaths } from "./project.js";
import {
  brandCss,
  dataUri,
  endCardHtml,
  Rasterizer,
  toOpaqueRgbPng,
  videoLayout,
  videoOverlayHtml,
} from "./render-html.js";
import { readImageHeader, StoreSpecError, validateStoreVideoFile, type SpecReport } from "./validate.js";

/**
 * `store-video`: native clips → App Store App Preview / Google Play promo.
 *
 *  1. Plan each scene (src/store/plan.ts): Maestro start-up and exit are
 *     trimmed by the flow's own command marks, labelled typing/waiting spans
 *     are ramped, every still longer than maxStillMs that isn't a hold is
 *     ramped down to stillKeepMs.
 *  2. Per preset: lay the device video onto the canvas (fill / band / side),
 *     burn in the scene caption (Chrome-rasterized PNG from text), append the
 *     end card, add a silent stereo AAC track, encode to the store's spec.
 *  3. Verify: ffprobe against the preset (dimensions, codec, fps, audio,
 *     duration, size) and freezedetect against the still rule. Any failure
 *     throws — a file that would be rejected never looks finished.
 */

export interface StoreVideoOptions {
  presets?: StoreVideoPresetId[];
  lang?: string;
  onSceneStart?: (id: string, index: number, total: number) => void;
  onSceneComplete?: (id: string, index: number, total: number) => void;
}

export interface StoreVideoResult {
  preset: StoreVideoPresetId;
  file: string;
  poster: string;
  posterTimeCode: string;
  durationMs: number;
  report: SpecReport;
  reportFile: string;
}

/** Marks-based trim: drop Maestro's JVM/driver start-up and its exit. */
export function defaultTrim(
  durationMs: number,
  marks: { startMs: number; endMs: number }[],
  lead = 250,
  tail = 600
): { startMs: number; endMs: number } {
  if (!marks.length) return { startMs: 0, endMs: durationMs };
  const first = Math.min(...marks.map((m) => m.startMs));
  const last = Math.max(...marks.map((m) => m.endMs));
  return { startMs: Math.max(0, first - lead), endMs: Math.min(durationMs, Math.max(last + tail, first + 500)) };
}

/** The scenes the edit uses, in order: everything except screenshot-only scenes (`inVideo: false`). */
export function videoScenes(store: StoreProject): StoreProject["scenes"] {
  const scenes = store.scenes.filter((s) => s.inVideo !== false);
  if (!scenes.length) throw new Error("every scene has inVideo: false — the video needs at least one scene");
  return scenes;
}

interface PlannedScene {
  id: string;
  clip: string;
  plan: ScenePlan;
  caption?: string;
  dims: { width: number; height: number };
}

async function planAll(project: Project, store: StoreProject, timeline: NativeTimeline): Promise<PlannedScene[]> {
  const v = store.video ?? {};
  const options = {
    maxStillMs: v.maxStillMs ?? 700,
    stillKeepMs: v.stillKeepMs ?? DEFAULT_PLAN_OPTIONS.stillKeepMs,
    defaultRampRate: v.rampRate ?? DEFAULT_PLAN_OPTIONS.defaultRampRate,
    minHoldMs: v.minHoldMs ?? DEFAULT_PLAN_OPTIONS.minHoldMs,
    maxRate: v.maxRate ?? DEFAULT_PLAN_OPTIONS.maxRate,
  };
  const out: PlannedScene[] = [];
  for (const scene of videoScenes(store)) {
    const rec = timeline.scenes.find((s) => s.id === scene.id);
    if (!rec) throw new Error(`scene "${scene.id}" has no clip — run \`aidemo native-record <dir>\` (or --only ${scene.id})`);
    const hash = await sceneHash(project, store, scene);
    if (hash !== rec.hash)
      log(`⚠ scene "${scene.id}": its flow/env changed since it was recorded — re-record with --only ${scene.id}`);
    const durationMs = rec.durationMs || (await probeDurationMs(rec.clip));
    const trim = resolveTrim(scene, rec.marks, durationMs, defaultTrim(durationMs, rec.marks));
    const freezes = await probeFreezeSpans(rec.clip, options.maxStillMs);
    const plan = planScene({
      durationMs,
      trim,
      freezes: freezes.map((f) => ({ startMs: f.startMs, endMs: Math.min(f.endMs, durationMs) })),
      ramps: resolveRamps(scene, rec.marks, options.defaultRampRate),
      holds: resolveHolds(scene, rec.marks),
      tailHoldMs: scene.tailHoldMs,
      options,
    });
    out.push({ id: scene.id, clip: rec.clip, plan, caption: scene.caption, dims: await probeVideoDims(rec.clip) });
  }
  return out;
}

export async function storeVideo(project: Project, opts: StoreVideoOptions = {}): Promise<StoreVideoResult[]> {
  const store = await loadStoreProject(project);
  const timeline = await loadNativeTimeline(project);
  if (!timeline) throw new Error("no generated/native-timeline.json — run `aidemo native-record <dir>` first");
  const paths = storePaths(project);
  const lang = opts.lang;
  const presetIds = opts.presets?.length ? opts.presets : (store.video?.presets ?? ["app-store-preview"]);
  const presets = presetIds.map(storeVideoPreset);
  const v = store.video ?? {};
  const maxStillMs = v.maxStillMs ?? 700;
  const endMs = store.endCard ? (store.endCard.durationMs ?? 2000) : 0;

  step("planning the edit");
  const planned = await planAll(project, store, timeline);
  const captions = videoScenes(store).map((s) => localized(s.caption, s.localized, "caption", lang));
  if (!captions[0]) log("⚠ the first scene has no caption — store autoplay is muted, the first frame should carry the message");

  const brand = await brandCss(store.brand, (p) => resolveIn(project, p));
  const raster = new Rasterizer();
  const results: StoreVideoResult[] = [];
  await ensureDir(paths.outDir);
  await fs.rm(paths.tmpDir, { recursive: true, force: true });
  await ensureDir(paths.tmpDir);
  try {
    for (const storePreset of presets) {
      // The project may ask for a tighter window than the store allows (e.g. 15–20 s of a 30 s slot).
      const preset = { ...storePreset, ...durationWindow(storePreset, { minSec: v.minSec, maxSec: v.maxSec }) };
      const fit = fitPlans(
        planned.map((p) => p.plan),
        endMs,
        { minMs: preset.minSec != null ? preset.minSec * 1000 : undefined, maxMs: preset.maxSec != null ? preset.maxSec * 1000 : undefined },
        v.durationFit ?? "fail",
        v.maxRate ?? DEFAULT_PLAN_OPTIONS.maxRate
      );
      // Viewer pacing: a captioned scene runs long enough to read its caption and see the action.
      const short = planned
        .map((p, i) => ({ id: p.id, outMs: fit.plans[i].outMs, needMs: minCaptionedSceneMs(captions[i]) }))
        .filter((s) => s.outMs + 50 < s.needMs);
      if (short.length)
        throw new Error(
          short.map((s) => `scene "${s.id}" runs ${(s.outMs / 1000).toFixed(1)} s; its caption needs ${(s.needMs / 1000).toFixed(1)} s to read`).join("; ") +
            ` — lengthen its result hold (holds[].afterMs) or tailHoldMs, or drop a scene to make room.`
        );
      if (fit.speedFactor !== 1) log(`durationFit: non-hold time sped up ×${fit.speedFactor.toFixed(2)} to fit ${preset.maxSec} s`);
      step(`${preset.id}: ${preset.width}x${preset.height}, ${(fit.totalMs / 1000).toFixed(2)} s`);
      const sceneFiles: string[] = [];
      const allowed: Span[] = [];
      const sceneReport: Array<{ id: string; startMs: number; outMs: number; segments: ScenePlan["segments"] }> = [];
      let t = 0;
      let region: Span2D | undefined;
      for (const [i, sc] of planned.entries()) {
        opts.onSceneStart?.(sc.id, i, planned.length);
        const plan = fit.plans[i];
        const layout = videoLayout(preset.width, preset.height, sc.dims.width, sc.dims.height, v.layout ?? "auto", v.captionPosition ?? "top", !!captions[i]);
        region = unionRect(region, clipRect(layout.video, preset.width, preset.height));
        const overlay = paths.tmp(`${preset.id}-${sc.id}-over.png`);
        await raster.render(videoOverlayHtml(brand, layout, captions[i]), preset.width, preset.height, overlay, { transparent: true });
        const out = paths.tmp(`${preset.id}-${sc.id}.mp4`);
        await renderScene(sc.clip, plan, layout, overlay, out, preset.fps);
        sceneFiles.push(out);
        for (const h of plan.holdsOut) allowed.push({ startMs: t + h.startMs, endMs: t + h.endMs });
        sceneReport.push({ id: sc.id, startMs: Math.round(t), outMs: plan.outMs, segments: plan.segments });
        t += plan.outMs;
        opts.onSceneComplete?.(sc.id, i, planned.length);
      }
      if (store.endCard) {
        const png = paths.tmp(`${preset.id}-endcard.png`);
        await raster.render(
          endCardHtml(brand, preset.width, preset.height, {
            appName: store.endCard.appName,
            line: localized(store.endCard.line, store.endCard.localized, "line", lang),
            iconUri: store.endCard.icon ? await dataUri(resolveIn(project, store.endCard.icon)) : undefined,
          }),
          preset.width,
          preset.height,
          png
        );
        const out = paths.tmp(`${preset.id}-endcard.mp4`);
        await runFfmpeg([
          "-loop", "1", "-framerate", String(preset.fps), "-t", (endMs / 1000).toFixed(3), "-i", png,
          "-vf", `format=yuv420p`, "-r", String(preset.fps),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", out,
        ]);
        sceneFiles.push(out);
        allowed.push({ startMs: t - 200, endMs: t + endMs + 1000 });
        t += endMs;
      }
      const file = paths.video(preset.id, lang);
      await encodeFinal(sceneFiles, file, preset);
      const report = await validateStoreVideoFile(file, preset);
      const fileMs = await probeDurationMs(file).catch(() => t);
      const finalFreezes = clampSpans(await probeFreezeSpans(file, maxStillMs + 120, undefined, region), fileMs);
      const bad = stillViolations(finalFreezes, allowed, maxStillMs);
      if (bad.length)
        report.errors.push(
          ...bad.map(
            (b) =>
              `still frame ${(b.startMs / 1000).toFixed(2)}–${(b.endMs / 1000).toFixed(2)} s is longer than ${maxStillMs} ms and not a hold — add a ramp or mark it as a hold`
          )
        );
      const posterAt = Math.min(v.posterAtMs ?? 0, Math.max(0, t - 100));
      const poster = file.replace(/\.mp4$/, ".poster.png");
      const posterTmp = paths.tmp(`${preset.id}-poster.png`);
      await runFfmpeg(["-ss", (posterAt / 1000).toFixed(3), "-i", file, "-frames:v", "1", "-update", "1", posterTmp]);
      await toOpaqueRgbPng(posterTmp, poster);
      const ph = readImageHeader(await fs.readFile(poster));
      if (ph.width !== preset.width || ph.height !== preset.height || ph.hasAlpha)
        report.errors.push(`poster is ${ph.width}x${ph.height}${ph.hasAlpha ? " with alpha" : ""} — expected opaque ${preset.width}x${preset.height}`);
      const reportFile = file.replace(/\.mp4$/, ".report.json");
      const durationMs = Math.round(Number(report.facts.durationSec) * 1000);
      await writeJson(reportFile, {
        preset: preset.id,
        note: preset.note,
        lang: lang ?? null,
        file,
        poster,
        posterTimeCode: posterTimeCode(posterAt, preset.fps),
        durationMs,
        speedFactor: fit.speedFactor,
        holds: allowed,
        scenes: sceneReport,
        spec: report,
      });
      for (const w of report.warnings) log(`⚠ ${preset.id}: ${w}`);
      if (report.errors.length) throw new StoreSpecError(report);
      ok(`${preset.id} → ${file} (${(durationMs / 1000).toFixed(2)} s, poster ${posterTimeCode(posterAt, preset.fps)})`);
      results.push({ preset: preset.id, file, poster, posterTimeCode: posterTimeCode(posterAt, preset.fps), durationMs, report, reportFile });
    }
  } finally {
    await raster.close();
    if (!process.env.AIDEMO_KEEP_TMP) await fs.rm(paths.tmpDir, { recursive: true, force: true });
  }
  return results;
}

type Span2D = { x: number; y: number; w: number; h: number };
/** The part of `r` that is on a W×H canvas (even sizes, as ffmpeg's crop wants for yuv420p). */
export function clipRect(r: Span2D, W: number, H: number): Span2D {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  const w = Math.min(W, r.x + r.w) - x, h = Math.min(H, r.y + r.h) - y;
  return { x, y, w: Math.max(2, Math.floor(w / 2) * 2), h: Math.max(2, Math.floor(h / 2) * 2) };
}
export function unionRect(a: Span2D | undefined, b: Span2D): Span2D {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Build the ffmpeg filter for one scene: CFR → segments at their rates → tail hold → canvas → overlay. */
export function sceneFilter(plan: ScenePlan, layout: ReturnType<typeof videoLayout>, fps: number): string {
  // Each segment gets an exact frame count, taken from the plan's cumulative output clock
  // (frames = round(end·fps) − round(start·fps)). Left to setpts + concat, every sped-up
  // segment lost up to a frame at its end; across a 17-segment scene that drifted ~0.4 s, so
  // the rendered holds no longer sat where the plan (and the still check) put them.
  const frames: number[] = [];
  let tOut = 0;
  for (const s of plan.segments) {
    const start = Math.round((tOut * fps) / 1000);
    tOut += (s.toMs - s.fromMs) / s.rate;
    frames.push(Math.round((tOut * fps) / 1000) - start);
  }
  const used = plan.segments.map((s, i) => ({ s, i, n: frames[i] })).filter((x) => x.n > 0);
  const n = used.length;
  const parts: string[] = [];
  // simctl/screenrecord are VFR (no frames while the screen is still): go CFR
  // BEFORE trimming or the still tails of each segment vanish.
  parts.push(`[0:v]fps=${fps},setpts=PTS-STARTPTS,split=${n}${used.map((x) => `[r${x.i}]`).join("")}`);
  for (const { s, i, n: count } of used) {
    parts.push(
      `[r${i}]trim=start=${(s.fromMs / 1000).toFixed(4)}:end=${(s.toMs / 1000).toFixed(4)},setpts=(PTS-STARTPTS)/${s.rate.toFixed(6)},` +
        `fps=${fps},tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(4)},trim=end_frame=${count},setpts=PTS-STARTPTS[s${i}]`
    );
  }
  const tail = plan.tailHoldMs > 0 ? `,tpad=stop_mode=clone:stop_duration=${(plan.tailHoldMs / 1000).toFixed(3)}` : "";
  parts.push(`${used.map((x) => `[s${x.i}]`).join("")}concat=n=${n}:v=1:a=0,fps=${fps}${tail}[c]`);
  const { w: W, h: H } = layout.canvas;
  const vr = layout.video;
  if (layout.mode === "fill") {
    const cx = Math.max(0, -vr.x);
    const cy = Math.max(0, -vr.y);
    parts.push(`[c]scale=${vr.w}:${vr.h}:flags=lanczos,crop=${W}:${H}:${cx}:${cy},setsar=1[v]`);
  } else {
    parts.push(`[c]scale=${vr.w}:${vr.h}:flags=lanczos,pad=${W}:${H}:${vr.x}:${vr.y}:color=black,setsar=1[v]`);
  }
  parts.push(`[v][1:v]overlay=0:0:format=auto,format=yuv420p[out]`);
  return parts.join(";");
}

async function renderScene(
  clip: string,
  plan: ScenePlan,
  layout: ReturnType<typeof videoLayout>,
  overlay: string,
  out: string,
  fps: number
): Promise<void> {
  await runFfmpeg([
    "-i", clip,
    "-i", overlay,
    "-filter_complex", sceneFilter(plan, layout, fps),
    "-map", "[out]",
    "-an",
    "-r", String(fps),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12",
    out,
  ]);
}

async function encodeFinal(parts: string[], out: string, preset: StoreVideoPreset): Promise<void> {
  // Total from the parts themselves, so the silent track is exactly as long.
  let totalMs = 0;
  for (const p of parts) totalMs += await probeDurationMs(p);
  const inputs = parts.flatMap((p) => ["-i", p]);
  const n = parts.length;
  const filter = `${parts.map((_, i) => `[${i}:v]`).join("")}concat=n=${n}:v=1:a=0,fps=${preset.fps},format=yuv420p[v]`;
  await runFfmpeg([
    ...inputs,
    // Bounded silent stereo track (never an unbounded source).
    "-f", "lavfi", "-t", (totalMs / 1000).toFixed(3), "-i", `anullsrc=channel_layout=stereo:sample_rate=${preset.sampleRate}`,
    "-filter_complex", filter,
    "-map", "[v]", "-map", `${n}:a`,
    "-r", String(preset.fps),
    "-c:v", "libx264", "-profile:v", preset.profile, "-level:v", (preset.maxLevel / 10).toFixed(1),
    "-preset", "slow", "-b:v", preset.videoBitrate, "-maxrate", preset.maxrate, "-bufsize", preset.bufsize,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", preset.audioBitrate, "-ar", String(preset.sampleRate), "-ac", "2",
    "-t", (totalMs / 1000).toFixed(3),
    "-movflags", "+faststart",
    out,
  ]);
}


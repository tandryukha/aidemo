import { promises as fs } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { Project } from "./project.js";
import type {
  Storyboard,
  Timeline,
  IdleSpan,
  Card,
  Output,
  Loudness,
  ComposeReport,
  ComposeSceneReport,
  ComposeWarning,
} from "./types.js";
import { TimelineSchema, VoiceManifestSchema, LoudnessSchema, HoldSchema } from "./types.js";
import { sceneWordsFor, type Cue } from "./captions.js";
import { wordStartMs } from "./anchors.js";
import { renderCaptionPngs } from "./caption-render.js";
import { renderCardPng } from "./cards.js";
import { renderCursorPng } from "./cursor.js";
import { buildZoomFilter, clampScaleForWidth, type ZoomEvent } from "./zoom.js";
import {
  buildCursorFilter,
  type CursorPoint,
  type HideWindow,
} from "./cursor-overlay.js";
import {
  renderAttentionPngs,
  renderKeyChipPngs,
  renderClickRingPngs,
  buildRedactFilter,
  REDACT_BATCH,
  KEY_CHIP_MS,
  DEFAULT_ACCENT,
  type OverlayItem,
  type PlacedAttention,
  type PlacedKey,
  type PlacedClick,
  type PlacedRedact,
} from "./attention.js";
import { renderFramePng } from "./frame.js";
import { OUTPUT_PRESETS, type CaptionsConfig } from "./types.js";
import {
  runFfmpeg,
  probeDurationMs,
  probeFlatTailMs,
  probeVideoDims,
} from "./ffmpeg.js";
import {
  ensureDir,
  readJson,
  writeJson,
  exists,
  log,
  ok,
  step,
  type SceneProgress,
} from "./util.js";

/** Idle "thinking" spans are trimmed down to at most this, then time-stretched. */
const IDLE_CAP_MS = 400;
const FPS = 30;
/** Bounds on how much we retime a scene before freezing the last frame instead. */
const MAX_STRETCH = 1.6; // don't slow real motion beyond this; freeze-hold the rest
const MIN_FACTOR = 0.5; // don't speed up beyond 2x

/**
 * Turns the raw recording + timeline.json + narration.mp3 (+ captions,
 * +optional music/zoom/cards) into the final MP4. Per scene: keep non-idle
 * content plus a capped sliver of idle, then time-stretch that segment to
 * exactly match the scene's narration length. This kills dead time AND locks
 * audio/video in sync. Then, in order: auto-zoom pass over the content,
 * intro/outro cards around it, caption overlay, audio mux with ducked music.
 */
export async function compose(
  project: Project,
  storyboard: Storyboard,
  opts: SceneProgress = {}
): Promise<ComposeReport> {
  step("Composing final video (ffmpeg)");

  const timeline = TimelineSchema.parse(await readJson(project.timelinePath));
  const voice = VoiceManifestSchema.parse(
    await readJson(project.voiceManifestPath)
  );
  // Structured twin of the log lines below — see ComposeReportSchema.
  const warnings: ComposeWarning[] = [];
  const sceneReports: ComposeSceneReport[] = [];
  const warn = (code: string, message: string, scene?: string): void => {
    warnings.push({ code, message, ...(scene ? { scene } : {}) });
  };
  const hold = HoldSchema.parse(storyboard.hold ?? {});
  if (await warnStaleCaptions(project)) {
    warn(
      "stale-captions",
      `narration.mp3 is newer than the caption files — re-run: aidemo captions ${project.dir}`
    );
  }
  const tmp = project.composeTmpDir;
  await fs.rm(tmp, { recursive: true, force: true });
  await ensureDir(tmp);
  await ensureDir(resolve(project.outputPath, ".."));

  const rawVideo = await project.resolveRawVideo();
  // Raw video may be recorded at a higher pixel density than the storyboard's
  // logical size (native/OBS capture on retina). Everything overlay-related
  // scales by pxScale so captions/cards/zoom line up at any density.
  const { width: outW, height: outH } = await probeVideoDims(rawVideo);
  const pxScale = outW / storyboard.video.width;

  // Map scene id -> narration duration; compose target = narration + gap.
  const voiceById = new Map(voice.scenes.map((s) => [s.id, s.durationMs]));
  const sceneById = new Map(storyboard.scenes.map((s) => [s.id, s]));

  const zoomCfg =
    storyboard.zoom && storyboard.zoom.enabled !== false ? storyboard.zoom : null;
  const zoomEvents: ZoomEvent[] = [];
  let outCursorMs = 0;

  // Compose-time cursor overlay accumulators (opt-in `cursor` block). We collect
  // the recorded path — remapped into final content time + output pixels, like
  // the focus events — plus the content-time windows of any `hideScenes`.
  const cursorCfg = storyboard.cursor ?? null;
  const hideSceneIds = new Set(cursorCfg?.hideScenes ?? []);
  const cursorPts: CursorPoint[] = [];
  const hideWindows: HideWindow[] = [];
  let cursorSampleCount = 0;
  // Attention layer accumulators (all opt-in; empty for a plain storyboard).
  const accent = storyboard.attention?.color ?? storyboard.brand?.accent ?? DEFAULT_ACCENT;
  const attentionPlaced: PlacedAttention[] = [];
  const keysPlaced: PlacedKey[] = [];
  const clicksPlaced: PlacedClick[] = [];
  const redactPlaced: PlacedRedact[] = [];
  const clickRings = !!(storyboard.attention?.clicks && cursorCfg);
  /** Per-scene caption placement windows (content ms, before the intro shift). */
  const captionWindows: Array<{ a: number; b: number; position: "top" | "bottom" }> = [];
  // Dot cursors are centered on the point; the arrow PNG's tip is its top-left.
  const dotOffset =
    cursorCfg?.style === "dot" ? Math.round(16 * pxScale * (cursorCfg.scale ?? 1)) : 0;

  const sceneVideos: string[] = [];
  const sceneTotal = timeline.scenes.length;
  for (let i = 0; i < timeline.scenes.length; i++) {
    const tl = timeline.scenes[i];
    opts.onSceneStart?.(tl.id, i, sceneTotal);
    const narrMs = voiceById.get(tl.id) ?? 0;
    const targetMs = narrMs + voice.gapMs;
    if (targetMs <= 0) {
      log(`scene ${tl.id}: no narration, skipping`);
      warn("scene-no-narration", `scene ${tl.id} has no narration audio and was skipped`, tl.id);
      opts.onSceneComplete?.(tl.id, i, sceneTotal);
      continue;
    }

    let blankTrimMs = 0;
    // A resumed take's reused scenes live in an earlier raw file with its own lead-in.
    const leadInMs = tl.leadInMs ?? timeline.leadInMs;
    const sceneRaw = tl.source ? resolve(project.dir, tl.source) : rawVideo;
    const keeps = keepIntervals(tl, leadInMs);
    const rawSegPath = resolve(tmp, `scene-${i}-raw.mp4`);
    await extractAndConcat(sceneRaw, keeps, rawSegPath, tmp, i);

    let srcMs = await probeDurationMs(rawSegPath);
    // A scene that ends right before a `goto` can trail off into the browser's
    // white pre-paint. Freeze-holding THAT frame paints seconds of solid white
    // (issue #36), so drop a flat tail before deciding how long to hold —
    // but only when we would actually hold, and never the whole segment.
    if (srcMs > 0 && targetMs > srcMs + 400) {
      const flatMs = await probeFlatTailMs(rawSegPath, srcMs);
      const trimTo = srcMs - flatMs;
      if (flatMs > 200 && trimTo > 500) {
        blankTrimMs = flatMs;
        srcMs = trimTo;
      }
    }
    // Retime the segment toward the narration length, but only within
    // [MIN_FACTOR, MAX_STRETCH]. If narration still needs more time, hold
    // (freeze) the last frame for the remainder — natural for a static page,
    // and far better than 3x slow-motion.
    const ratio = targetMs / Math.max(srcMs, 1);
    const uniformFactor = Math.min(MAX_STRETCH, Math.max(MIN_FACTOR, ratio));

    // Narration anchors → piecewise retime. Each anchored action is a raw
    // offset (inside the kept spans) that must land on the ms its word is
    // spoken; between anchors the factor is whatever gets there (clamped to
    // the same [MIN_FACTOR, MAX_STRETCH], so a beat that can't be reached is
    // reported, never faked). No anchors → one piece, the uniform factor —
    // arithmetically identical to the pre-anchor path.
    const sceneDef = sceneById.get(tl.id);
    const anchorDefs = sceneDef?.anchors ?? {};
    const anchorPts: Array<{ name: string; raw: number; target: number }> = [];
    if (Object.keys(anchorDefs).length && (tl.anchorEvents ?? []).length) {
      const words = await sceneWordsFor(project, tl.id, sceneDef?.narration ?? "", narrMs);
      for (const ev of tl.anchorEvents) {
        const wi = anchorDefs[ev.name];
        if (wi == null) continue;
        const target = wordStartMs(words, sceneDef?.narration ?? "", wi);
        if (target == null) continue;
        const raw = offsetInKeeps(keeps, ev.tMs + leadInMs);
        if (raw > srcMs - 40) {
          warn(
            "anchor-unreachable",
            `scene ${tl.id}: anchor "${ev.name}" fires at the very end of the take (${Math.round(raw)}ms of ${Math.round(srcMs)}ms) — add a pause or a later action after it so the beat has room`,
            tl.id
          );
          continue;
        }
        anchorPts.push({ name: ev.name, raw, target });
      }
      anchorPts.sort((a, b) => a.raw - b.raw);
    }
    const pieces: RetimePiece[] = [];
    const anchorReport: NonNullable<ComposeSceneReport["anchors"]> = [];
    if (anchorPts.length) {
      let out = 0;
      let prevRaw = 0;
      const bounds = [
        ...anchorPts.map((a) => ({ raw: a.raw, target: a.target, name: a.name as string | null })),
        { raw: srcMs, target: targetMs, name: null as string | null },
      ];
      for (const bnd of bounds) {
        const len = bnd.raw - prevRaw;
        if (len >= 40) {
          const want = bnd.target - out;
          const f = Math.min(MAX_STRETCH, Math.max(MIN_FACTOR, want / len));
          pieces.push({ a: prevRaw, b: bnd.raw, f, out });
          out += len * f;
          prevRaw = bnd.raw;
        }
        if (bnd.name) {
          const offMs = Math.round(out - bnd.target);
          anchorReport.push({
            name: bnd.name,
            targetMs: Math.round(bnd.target),
            landedMs: Math.round(out),
            offMs,
          });
          if (Math.abs(offMs) > 150) {
            warn(
              "anchor-unreachable",
              `scene ${tl.id}: anchor "${bnd.name}" lands ${Math.abs(offMs)}ms ${offMs > 0 ? "after" : "before"} its word even at ${offMs > 0 ? "2x speed" : "x1.6 slow-motion"} — ${
                offMs > 0
                  ? "trim what happens before the action (mark waits idle, drop a scroll) or move the {{@" + bnd.name + "}} marker later"
                  : "give the action more lead-in (a pause, a hover) or move the {{@" + bnd.name + "}} marker earlier"
              }`,
              tl.id
            );
          }
        }
      }
    }
    if (!pieces.length) pieces.push({ a: 0, b: srcMs, f: uniformFactor, out: 0 });
    const anchored = anchorPts.length > 0;
    let stretchedMs = anchored
      ? pieces[pieces.length - 1].out + (pieces[pieces.length - 1].b - pieces[pieces.length - 1].a) * pieces[pieces.length - 1].f
      : uniformFactor * srcMs;
    const factor = anchored ? stretchedMs / Math.max(srcMs, 1) : uniformFactor;
    /** Kept-span offset (raw ms inside the concatenated keeps) → stretched scene ms. */
    const stretchLocal = (local: number): number => {
      let pc = pieces[0];
      for (const q of pieces) if (local >= q.a) pc = q;
      return pc.out + (local - pc.a) * pc.f;
    };
    // A scene whose active video exceeds 2x its narration would OVERRUN its
    // narration slot — the narration track is fixed, so every later scene's
    // video drifts behind its audio and the finale slides past the end of the
    // video. Trim the segment tail instead: losing late dwell is far better
    // than global A/V desync (bit us live 2026-07-06 when a 31s player stall
    // inflated one scene's active span).
    let overrunTrimMs = 0;
    if (stretchedMs > targetMs + 40) {
      overrunTrimMs = stretchedMs - targetMs;
      stretchedMs = targetMs;
    }
    const holdMs = Math.max(0, targetMs - stretchedMs);
    const holding = holdMs > 40;
    // `hold.backoffMs` takes the held frame from slightly before the segment
    // end (a mid-flight hover, a half-painted transition); the hold grows by
    // the same amount so the scene still fills its narration slot exactly.
    const backoffMs = holding
      ? Math.min(hold.backoffMs, Math.max(0, stretchedMs - 500))
      : 0;
    const driftHold = holding && hold.mode === "drift";
    let vf = "";
    if (blankTrimMs > 0) {
      vf += `trim=duration=${(srcMs / 1000).toFixed(3)},setpts=PTS-STARTPTS,`;
    }
    // Tail (shared by the uniform and the piecewise path): overrun trim,
    // backoff trim, freeze hold.
    let tail = "";
    if (overrunTrimMs > 0) {
      tail += `,trim=duration=${(targetMs / 1000).toFixed(3)},setpts=PTS-STARTPTS`;
    }
    if (backoffMs > 0) {
      tail += `,trim=duration=${((stretchedMs - backoffMs) / 1000).toFixed(3)},setpts=PTS-STARTPTS`;
    }
    if (holding && !driftHold) {
      tail += `,tpad=stop_mode=clone:stop_duration=${((holdMs + backoffMs) / 1000).toFixed(3)}`;
    }
    let filterArgs: string[];
    if (anchored) {
      // split → per-piece trim + setpts → concat. Same source, same format,
      // so concat is a plain join; everything stays in the core filter set.
      const n = pieces.length;
      const splitLabels = pieces.map((_, k) => `[s${k}]`).join("");
      const pieceFilters = pieces
        .map(
          (pc, k) =>
            `[s${k}]trim=start=${(pc.a / 1000).toFixed(3)}:end=${(pc.b / 1000).toFixed(3)},` +
            `setpts=(PTS-STARTPTS)*${pc.f.toFixed(6)}[p${k}]`
        )
        .join(";");
      const concatIn = pieces.map((_, k) => `[p${k}]`).join("");
      const fc =
        `[0:v]${vf}split=${n}${splitLabels};${pieceFilters};` +
        `${concatIn}concat=n=${n}:v=1:a=0,setpts=PTS-STARTPTS${tail}[vout]`;
      filterArgs = ["-filter_complex", fc, "-map", "[vout]"];
    } else {
      filterArgs = ["-vf", `${vf}setpts=${factor.toFixed(6)}*PTS${tail}`];
    }

    // Map this scene's focus events into final-video time for the zoom pass:
    // raw time → offset inside the kept spans → stretched → + scene offset.
    let sceneFocus = 0;
    if (zoomCfg && sceneById.get(tl.id)?.zoom !== false) {
      for (const ev of tl.focusEvents ?? []) {
        sceneFocus++;
        const rawT = ev.tMs + leadInMs;
        const local = stretchLocal(offsetInKeeps(keeps, rawT));
        zoomEvents.push({
          tMs: outCursorMs + Math.min(local, stretchedMs),
          x: ev.x * pxScale,
          y: ev.y * pxScale,
          scale: ev.scale,
          holdMs: ev.holdMs,
        });
      }
    }

    // Cursor path for the compose-time overlay — same raw→content-time remap as
    // the focus events, in output pixels. The scene's content-time span drives
    // per-scene hide (`hideScenes`).
    if (cursorCfg) {
      const sceneStart = outCursorMs;
      for (const s of tl.cursorSamples ?? []) {
        const rawT = s.tMs + leadInMs;
        const local = stretchLocal(offsetInKeeps(keeps, rawT));
        cursorPts.push({
          t: (outCursorMs + Math.min(local, stretchedMs)) / 1000,
          x: s.x * pxScale - dotOffset,
          y: s.y * pxScale - dotOffset,
        });
      }
      cursorSampleCount += (tl.cursorSamples ?? []).length;
      if (hideSceneIds.has(tl.id)) {
        const sceneEnd = outCursorMs + stretchedMs + (holdMs > 40 ? holdMs : 0);
        hideWindows.push({ a: sceneStart / 1000, b: sceneEnd / 1000 });
      }
    }

    // Attention beats, key chips, click rings and redact spans: same raw →
    // content-time remap; holds are content-time and clipped to the scene.
    {
      const sceneStart = outCursorMs;
      const sceneEnd = outCursorMs + stretchedMs + (holdMs > 40 ? holdMs : 0);
      const toContent = (rawMs: number): number =>
        sceneStart + Math.min(stretchLocal(offsetInKeeps(keeps, rawMs + leadInMs)), stretchedMs);
      for (const ev of tl.attentionEvents ?? []) {
        const a = toContent(ev.tMs);
        const b = Math.min(sceneEnd, a + ev.holdMs);
        if (b - a < 80) continue;
        attentionPlaced.push({ ...ev, a: a / 1000, b: b / 1000 });
      }
      for (const k of tl.keyEvents ?? []) {
        const a = toContent(k.tMs);
        const b = Math.min(sceneEnd, a + KEY_CHIP_MS);
        if (b - a < 80) continue;
        keysPlaced.push({ keys: k.keys, a: a / 1000, b: b / 1000 });
      }
      if (clickRings) {
        for (const f of tl.focusEvents ?? []) {
          if (f.kind !== "click") continue;
          clicksPlaced.push({ x: f.x, y: f.y, t: toContent(f.tMs) / 1000 });
        }
      }
      for (const r of tl.redactSpans ?? []) {
        const a = toContent(r.startMs);
        // A span open at the scene end covers the hold too.
        const b = r.endMs >= tl.endMs - 5 ? sceneEnd : toContent(r.endMs);
        if (b - a < 40) continue;
        redactPlaced.push({ ...r, a: a / 1000, b: b / 1000 });
      }
      const pos = sceneById.get(tl.id)?.captions?.position;
      if (pos) captionWindows.push({ a: sceneStart, b: sceneEnd, position: pos });
    }

    outCursorMs += stretchedMs + (holdMs > 40 ? holdMs : 0);

    let scenePath = resolve(tmp, `scene-${i}.mp4`);
    await runFfmpeg([
      "-i",
      rawSegPath,
      ...filterArgs,
      "-an",
      "-r",
      String(FPS),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      scenePath,
    ]);
    if (driftHold) {
      scenePath = await appendDriftHold(
        scenePath,
        holdMs + backoffMs,
        hold.driftScale,
        outW,
        outH,
        tmp,
        i
      );
    }
    sceneVideos.push(scenePath);
    const holdPct = holding ? holdMs / targetMs : 0;
    log(
      `scene ${tl.id}: ${srcMs}ms -> ${targetMs}ms ` +
        `(x${factor.toFixed(2)}${
          holding
            ? ` + ${Math.round(holdMs)}ms ${hold.mode === "drift" ? "drift " : ""}hold` +
              (backoffMs > 0 ? ` (backoff ${backoffMs}ms)` : "")
            : ""
        }${
          overrunTrimMs > 0 ? ` - ${Math.round(overrunTrimMs)}ms tail trim` : ""
        }${blankTrimMs > 0 ? ` - ${Math.round(blankTrimMs)}ms blank tail` : ""}, ${keeps.length} span(s)${
          anchored
            ? `, ${pieces.length} piece(s): ` +
              anchorReport.map((a) => `${a.name} ${a.offMs >= 0 ? "+" : ""}${a.offMs}ms`).join(" ")
            : ""
        })`
    );
    sceneReports.push({
      id: tl.id,
      srcMs: Math.round(srcMs),
      targetMs: Math.round(targetMs),
      factor: Number(factor.toFixed(3)),
      holdMs: Math.round(holding ? holdMs : 0),
      holdPct: Number(holdPct.toFixed(3)),
      tailTrimMs: Math.round(overrunTrimMs),
      blankTrimMs: Math.round(blankTrimMs),
      spans: keeps.length,
      focusEvents: sceneFocus,
      ...(anchorReport.length ? { anchors: anchorReport } : {}),
    });
    if (holdPct > FREEZE_WARN_PCT) {
      warn(
        "scene-freeze",
        `scene ${tl.id}: ${Math.round(holdPct * 100)}% of its ${(targetMs / 1000).toFixed(1)}s ` +
          `is a held frame (${(srcMs / 1000).toFixed(1)}s of action for ` +
          `${(targetMs / 1000).toFixed(1)}s of narration) — add on-screen action ` +
          `(hover/scroll/focus beats, a pause) or shorten the narration`,
        tl.id
      );
    }
    if (overrunTrimMs > 0) {
      warn(
        "overrun-trim",
        `scene ${tl.id}: ${Math.round(overrunTrimMs)}ms of recorded action was cut from ` +
          `the tail — the action outran the narration even at 2x; mark waits idle or ` +
          `lengthen the narration`,
        tl.id
      );
    }
    if (blankTrimMs > 0) {
      warn(
        "blank-tail",
        `scene ${tl.id}: dropped a ${Math.round(blankTrimMs)}ms solid-color tail before holding`,
        tl.id
      );
    }
    opts.onSceneComplete?.(tl.id, i, sceneTotal);
  }

  if (sceneVideos.length === 0) throw new Error("No scenes to compose.");

  // Scene assembly. Default: stream-copy concat (hard cuts) — the fast,
  // lossless path, untouched when no transition is set. Opt-in: crossfade the
  // scene boundaries (re-encodes the join; total duration is preserved).
  let content: string;
  if (storyboard.transition && sceneVideos.length >= 2) {
    const durMs = storyboard.transition.durationMs;
    log(
      `scene crossfade: ${durMs}ms x ${sceneVideos.length - 1} boundary/ies`
    );
    content = await crossfadeScenes(
      sceneVideos,
      durMs,
      resolve(tmp, "content.mp4")
    );
  } else {
    content = await concatSegments(
      sceneVideos,
      resolve(tmp, "content.mp4"),
      tmp,
      "scenes"
    );
  }

  // Redaction first: blur boxes ride every later pass (cursor, zoom, blur).
  if (redactPlaced.length) {
    let src = content;
    let passes = 0;
    for (let i = 0; i < redactPlaced.length; i += REDACT_BATCH) {
      const batch = redactPlaced.slice(i, i + REDACT_BATCH);
      const filter = buildRedactFilter(batch, outW, outH, pxScale);
      if (!filter) continue;
      const out = resolve(tmp, `content-redact-${passes}.mp4`);
      await runFfmpeg([
        "-i",
        src,
        "-filter_complex",
        filter,
        "-map",
        "[vout]",
        "-an",
        "-r",
        String(FPS),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        out,
      ]);
      src = out;
      passes++;
    }
    content = src;
    log(`redact: ${redactPlaced.length} span(s) blurred in ${passes} pass(es)`);
  }

  // Attention overlays (highlight / spotlight / callout / click rings) go on
  // BEFORE the cursor and the zoom, so they ride the camera like page content.
  let attentionItems: OverlayItem[] = [];
  if (attentionPlaced.length || clicksPlaced.length) {
    attentionItems = [
      ...(await renderAttentionPngs(
        attentionPlaced,
        resolve(tmp, "attention"),
        storyboard.video.width,
        storyboard.video.height,
        pxScale,
        accent
      )),
      ...(await renderClickRingPngs(clicksPlaced, resolve(tmp, "attention"), pxScale, accent)),
    ];
    const r = await overlayPngBatches(content, attentionItems, tmp, "attention");
    content = r.video;
    log(
      `attention: ${attentionPlaced.length} beat(s)` +
        (clicksPlaced.length ? `, ${clicksPlaced.length} click ring(s)` : "") +
        ` in ${r.passes} pass(es)`
    );
  }

  // Compose-time cursor overlay (opt-in `cursor` block). Draw the recorded
  // cursor path onto the (cursor-free) content BEFORE the zoom pass, so the
  // cursor zooms and pans with the frame exactly like a baked one would.
  // `hidden` skips it entirely; `hideScenes` gates it off during those scenes.
  if (cursorCfg) {
    if (cursorSampleCount === 0) {
      log(
        "⚠ cursor: storyboard opts into the compose-time cursor, but this take " +
          "has no recorded cursor path — re-run `record`/`render` with the cursor " +
          "block present (the current recording may still show a baked cursor)."
      );
      warn(
        "cursor-missing",
        "cursor block present but the take has no recorded cursor path — re-record with the block"
      );
    } else if (cursorCfg.hidden) {
      log("cursor: hidden (no overlay drawn)");
    } else {
      const filter = buildCursorFilter(cursorPts, hideWindows);
      if (filter) {
        const cScale = cursorCfg.scale ?? 1;
        const png = resolve(tmp, "cursor.png");
        await renderCursorPng(
          png,
          Math.round(32 * pxScale * cScale),
          cursorCfg.style ?? "arrow",
          cursorCfg.color
        );
        const withCursor = resolve(tmp, "content-cursor.mp4");
        await runFfmpeg([
          "-i",
          content,
          "-i",
          png,
          "-filter_complex",
          filter,
          "-map",
          "[vout]",
          "-an",
          "-r",
          String(FPS),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          withCursor,
        ]);
        content = withCursor;
        log(
          `cursor overlay: ${cursorPts.length} path point(s)` +
            (hideWindows.length ? `, ${hideWindows.length} scene(s) hidden` : "") +
            (cScale !== 1 ? `, scale ${cScale}` : "")
        );
      }
    }
  }

  // Auto-zoom pass over the content (never over the cards or captions).
  let focusDropped = 0;
  if (zoomCfg && zoomEvents.length > 0) {
    const contentMs = await probeDurationMs(content);
    const filter = buildZoomFilter(
      zoomEvents,
      zoomCfg,
      outW,
      outH,
      contentMs,
      FPS,
      storyboard.video.width,
      (dropped, total) => {
        focusDropped = dropped;
        log(
          `  ! auto-zoom: ${dropped} of ${total} focus point(s) dropped to fit ` +
            `ffmpeg's expression budget — the rest are spread evenly. Set ` +
            `"zoom": false on scenes that don't need the camera to choose which.`
        );
        warn(
          "focus-dropped",
          `auto-zoom dropped ${dropped} of ${total} focus point(s) to fit ffmpeg's ` +
            `expression budget — set "zoom": false on scenes that don't need the camera`
        );
      }
    );
    if (filter) {
      const capped = clampScaleForWidth(zoomCfg.scale, storyboard.video.width);
      log(
        `auto-zoom: ${zoomEvents.length} focus event(s)` +
          (capped < zoomCfg.scale
            ? ` (scale ${zoomCfg.scale} capped to ${capped.toFixed(2)} for a ` +
              `${storyboard.video.width}px-wide viewport)`
            : "")
      );
      const zoomed = resolve(tmp, "content-zoomed.mp4");
      await runFfmpeg([
        "-i",
        content,
        "-vf",
        filter,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        zoomed,
      ]);
      content = zoomed;
    }
  }

  // Motion blur (opt-in `motionBlur` block). Average a small sliding window of
  // frames so fast motion — cursor glides, eased scrolls, zoom pans — trails
  // subtly; static UI is untouched (identical frames average to themselves).
  // Over the content only (not cards/captions). Portable: `tmix` is baseline.
  if (storyboard.motionBlur && storyboard.motionBlur.enabled !== false) {
    const frames = storyboard.motionBlur.frames ?? 3;
    const blurred = resolve(tmp, "content-blur.mp4");
    await runFfmpeg([
      "-i",
      content,
      "-vf",
      `tmix=frames=${frames}`,
      "-an",
      "-r",
      String(FPS),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      blurred,
    ]);
    content = blurred;
    log(`motion blur: tmix ${frames} frames`);
  }

  // Keystroke chips are screen-fixed UI: after the zoom/blur, before cards.
  let keyItems: OverlayItem[] = [];
  if (keysPlaced.length) {
    keyItems = await renderKeyChipPngs(
      keysPlaced,
      resolve(tmp, "attention"),
      storyboard.video.width,
      storyboard.video.height,
      pxScale
    );
    const r = await overlayPngBatches(content, keyItems, tmp, "keys");
    content = r.video;
    log(`keystrokes: ${keysPlaced.length} chip(s) in ${r.passes} pass(es)`);
  }

  // Produced-look frame (opt-in `frame` block): pad the content onto a canvas
  // and overlay the rasterized frame PNG (background, shadow, chrome, rounded
  // hole). Everything after this — cards, watermark, captions — renders at
  // the canvas size, so captions land in the padding band.
  let canvasW = outW;
  let canvasH = outH;
  const outCfg = resolveOutputSizing(storyboard.output);
  if (storyboard.frame) {
    const framePng = resolve(tmp, "frame.png");
    const layout = await renderFramePng(
      storyboard.frame,
      storyboard.brand,
      framePng,
      storyboard.video.width,
      storyboard.video.height,
      pxScale,
      outCfg.width != null && outCfg.height != null ? outCfg.width / outCfg.height : undefined
    );
    const framed = resolve(tmp, "content-framed.mp4");
    await runFfmpeg([
      "-i",
      content,
      "-i",
      framePng,
      "-filter_complex",
      `[0:v]pad=${layout.canvasW}:${layout.canvasH}:${layout.offsetX}:${layout.offsetY}:color=${layout.padColor}[p];` +
        `[p][1:v]overlay=0:0:format=auto[vout]`,
      "-map",
      "[vout]",
      "-an",
      "-r",
      String(FPS),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      framed,
    ]);
    content = framed;
    canvasW = layout.canvasW;
    canvasH = layout.canvasH;
    log(
      `frame: ${layout.canvasW}x${layout.canvasH} canvas (padding ${storyboard.frame.padding ?? 48}` +
        `${storyboard.frame.chrome && storyboard.frame.chrome !== "none" ? `, ${storyboard.frame.chrome} chrome` : ""})`
    );
  }
  const logicalW = canvasW / pxScale;
  const logicalH = canvasH / pxScale;

  // Brand watermark (opt-in `brand.logo`): scaled logo in a corner over the
  // content (not the cards — the cards carry the logo in their layout).
  const logoPath = storyboard.brand?.logo
    ? resolve(project.dir, storyboard.brand.logo)
    : null;
  if (logoPath && storyboard.brand?.watermark?.enabled !== false) {
    if (!(await exists(logoPath))) {
      warn("brand-logo-missing", `brand.logo not found at ${logoPath} — watermark and card logo skipped`);
    } else {
      const wm = storyboard.brand?.watermark ?? {};
      const wmW = Math.round(canvasW * (wm.scale ?? 0.11));
      const margin = Math.round(24 * pxScale);
      const pos = wm.position ?? "bottom-right";
      const x = pos.endsWith("left") ? margin : canvasW - wmW - margin;
      const yExpr = pos.startsWith("top") ? `${margin}` : `${canvasH}-h-${margin}`;
      const marked = resolve(tmp, "content-marked.mp4");
      await runFfmpeg([
        "-i",
        content,
        "-i",
        logoPath,
        "-filter_complex",
        `[1:v]scale=${wmW}:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=${(wm.opacity ?? 0.85).toFixed(2)}[lg];` +
          `[0:v][lg]overlay=${x}:${yExpr}[vout]`,
        "-map",
        "[vout]",
        "-an",
        "-r",
        String(FPS),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        marked,
      ]);
      content = marked;
      log(`watermark: ${storyboard.brand?.logo} at ${pos}`);
    }
  }
  const logoDataUri =
    logoPath && (await exists(logoPath)) ? await fileToDataUri(logoPath) : undefined;

  // Intro/outro title cards. Music runs under them; narration and captions
  // shift right by the intro's length.
  const segments: string[] = [];
  const introMs = storyboard.intro ? storyboard.intro.durationMs : 0;
  if (storyboard.intro) {
    segments.push(
      await cardSegment(storyboard.intro, "intro", tmp, storyboard, logicalW, logicalH, pxScale, logoDataUri)
    );
  }
  segments.push(content);
  if (storyboard.outro) {
    segments.push(
      await cardSegment(storyboard.outro, "outro", tmp, storyboard, logicalW, logicalH, pxScale, logoDataUri)
    );
  }
  // Re-encode when assembling cards: the card segments carry mp4 edit lists
  // (B-frame pts offsets), and a stream-copy concat of those yields NEGATIVE
  // leading timestamps — which silently breaks the caption overlay downstream
  // (framesync stops repeating the single-frame PNG inputs). A fresh encode
  // regenerates clean pts from 0.
  const fullVideo =
    segments.length === 1
      ? content
      : await concatSegments(segments, resolve(tmp, "video.mp4"), tmp, "full", true);

  // Caption band collisions: any attention box / key chip that reaches into
  // the bottom strip flips the caption to the top for the cues it overlaps.
  const bandTop = canvasH - Math.round((CAPTION_BOTTOM_GAP + 80) * pxScale);
  const collisions = [...attentionItems, ...keyItems]
    .filter((it) => {
      // Spotlights are full-frame PNGs; use the hole instead of the canvas.
      return it.y + pngHeightHint(it, attentionPlaced, pxScale) > bandTop;
    })
    .map((it) => ({ a: it.a * 1000, b: it.b * 1000 }));
  const captionsResult = await burnCaptions(
    project,
    storyboard,
    fullVideo,
    tmp,
    introMs,
    pxScale,
    {
      defaultPosition: storyboard.captions?.position ?? "bottom",
      windows: captionWindows,
      collisions,
      look: { ...(storyboard.captions ?? {}), font: storyboard.captions?.font ?? storyboard.brand?.font },
      logicalWidth: logicalW,
    }
  );
  const captioned = captionsResult.video;
  // Optional final resize/reframe (opt-in). Applied last, over the whole
  // composed frame (cards + captions included), so a 1280x720 take can render
  // as a vertical social clip. Audio is muxed after, so mux stays -c:v copy.
  // `output` may carry only a `loudness` override (no width/height) — resize
  // just when both dimensions are set.
  const finalVideo =
    outCfg.width != null && outCfg.height != null
      ? await resizeOutput(captioned, outCfg, tmp)
      : captioned;
  const chapters = storyboard.output?.chapters
    ? await writeChapters(tmp, [
        ...(storyboard.intro
          ? [{ id: "intro", title: storyboard.intro.title, durationMs: introMs }]
          : []),
        ...sceneReports.map((r) => ({
          id: r.id,
          title: sceneById.get(r.id)?.title ?? r.id,
          durationMs: r.targetMs,
        })),
        ...(storyboard.outro
          ? [{ id: "outro", title: storyboard.outro.title, durationMs: storyboard.outro.durationMs }]
          : []),
      ])
    : null;
  await muxAudio(project, storyboard, finalVideo, introMs, chapters);
  ok(`final video → ${project.outputPath}`);
  let poster: string | undefined;
  if (storyboard.output?.poster) {
    poster = project.posterPath;
    await runFfmpeg([
      "-ss",
      ((introMs + 500) / 1000).toFixed(3),
      "-i",
      project.outputPath,
      "-frames:v",
      "1",
      "-update",
      "1",
      poster,
    ]);
    log(`poster → ${poster}`);
  }
  // AIDEMO_KEEP_TMP=1 keeps .compose-tmp for debugging intermediates.
  if (!process.env.AIDEMO_KEEP_TMP) {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  const report: ComposeReport = {
    output: project.outputPath,
    durationMs: await probeDurationMs(project.outputPath).catch(() => 0),
    scenes: sceneReports,
    zoom: { focusTotal: zoomEvents.length, focusDropped },
    cursorPoints: cursorPts.length,
    captions: { cues: captionsResult.cues, passes: captionsResult.passes },
    hold: hold.mode,
    ...(poster ? { poster } : {}),
    ...(attentionPlaced.length || keysPlaced.length || clicksPlaced.length || redactPlaced.length
      ? {
          attention: {
            events: attentionPlaced.length,
            keys: keysPlaced.length,
            clicks: clicksPlaced.length,
            redactSpans: redactPlaced.length,
            captionsFlipped: captionsResult.flipped,
          },
        }
      : {}),
    warnings,
  };
  await writeJson(project.reportPath, report);
  const frozen = sceneReports.filter((s) => s.holdPct > FREEZE_WARN_PCT).length;
  log(
    `report → ${project.reportPath}` +
      (frozen ? ` (${frozen} of ${sceneReports.length} scene(s) mostly held)` : "")
  );
  if (warnings.length) {
    log(`⚠ ${warnings.length} compose warning(s):`);
    for (const w of warnings) log(`  - [${w.code}] ${w.message}`);
  }
  return report;
}

/** Share of a scene that may be a held frame before compose flags it. */
const FREEZE_WARN_PCT = 0.4;

/**
 * Hold mode "drift": instead of cloning the scene's last frame for `holdMs`,
 * push in on it very slowly (1 → driftScale over the hold), so a long
 * narration over a static page reads as a deliberate dwell, not a stall.
 * The frame is pulled from the encoded scene's tail, rendered as a zoompan
 * still (pre-upscaled 2x so integer-pixel crops don't shimmer — the same rule
 * the auto-zoom pass follows), and re-encoded onto the scene. One tiny
 * expression, so the zoom budget is untouched; `zoompan`/`scale` are core.
 */
async function appendDriftHold(
  scenePath: string,
  holdMs: number,
  driftScale: number,
  outW: number,
  outH: number,
  tmp: string,
  sceneIdx: number
): Promise<string> {
  const durMs = await probeDurationMs(scenePath);
  const framePng = resolve(tmp, `scene-${sceneIdx}-hold.png`);
  await runFfmpeg([
    "-ss",
    (Math.max(0, durMs - 60) / 1000).toFixed(3),
    "-i",
    scenePath,
    "-frames:v",
    "1",
    "-update",
    "1",
    framePng,
  ]);
  const holdSec = holdMs / 1000;
  const frames = Math.max(1, Math.round(holdSec * FPS));
  const holdMp4 = resolve(tmp, `scene-${sceneIdx}-hold.mp4`);
  // Ease the creep (ease-out quad) so it starts moving right away and settles.
  const z = `'1+(${driftScale.toFixed(4)}-1)*(1-pow(1-min(on/${frames}\,1)\,2))'`;
  await runFfmpeg([
    "-loop",
    "1",
    "-framerate",
    String(FPS),
    "-i",
    framePng,
    "-t",
    holdSec.toFixed(3),
    "-vf",
    `scale=iw*2:ih*2:flags=lanczos,` +
      `zoompan=z=${z}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${outW}x${outH}:fps=${FPS},` +
      `setsar=1`,
    "-r",
    String(FPS),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    holdMp4,
  ]);
  // The PNG-sourced hold carries an edit list; re-encode the join so the pts
  // start clean at 0 (a stream-copy concat would leak negative timestamps
  // into the overlay passes — see AGENTS.md).
  return concatSegments(
    [scenePath, holdMp4],
    resolve(tmp, `scene-${sceneIdx}-held.mp4`),
    tmp,
    `scene-${sceneIdx}-held`,
    true
  );
}

/**
 * A re-voice after captions were generated leaves the caption files stale —
 * compose would silently burn OLD caption text over the NEW audio, and the
 * mismatch only shows up in review (bit us on maxfit-chatgpt-v3). Whisper
 * needs an API key so compose can't regenerate them itself; warn loudly and
 * name the fix instead.
 */
async function warnStaleCaptions(project: Project): Promise<boolean> {
  try {
    const [cap, narr] = await Promise.all([
      fs.stat(project.captionsCuesPath),
      fs.stat(project.narrationPath),
    ]);
    if (cap.mtimeMs < narr.mtimeMs) {
      log(
        `⚠ STALE CAPTIONS: narration.mp3 is newer than the caption files — ` +
          `the burned captions will not match the audio. ` +
          `Fix: aidemo captions ${project.dir}` + ` (then re-run compose).`
      );
      return true;
    }
  } catch {
    /* captions or narration absent — burnCaptions handles missing captions */
  }
  return false;
}

/**
 * Concat same-codec segments via the concat demuxer. Stream copy by default;
 * pass reencode=true to regenerate timestamps (needed when segments carry
 * edit-list pts offsets, e.g. the title cards).
 */
async function concatSegments(
  parts: string[],
  outPath: string,
  tmp: string,
  name: string,
  reencode = false
): Promise<string> {
  if (parts.length === 1) return parts[0];
  const listPath = resolve(tmp, `${name}.txt`);
  await fs.writeFile(
    listPath,
    parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n"
  );
  const codecArgs = reencode
    ? ["-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
    : ["-c", "copy"];
  await runFfmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-an",
    ...codecArgs,
    outPath,
  ]);
  return outPath;
}

/**
 * Crossfade the scene segments into one clip WITHOUT shrinking the timeline.
 *
 * A plain xfade overlaps its two inputs and so shortens the result by the fade
 * length per boundary — which would slide every later scene ahead of its
 * (fixed, continuous) narration. Instead we steal the overlap from each
 * scene's OWN frozen tail: every non-last segment is clone-padded past its end,
 * and each xfade offset is the cumulative *real* scene duration, so scene k's
 * content still begins at exactly sum(d_0..d_{k-1}) — its narration slot. The
 * final total equals the plain-concat total (the last segment is left un-
 * padded). Net effect: identical A/V duration + alignment as hard cuts, but the
 * boundaries cross-dissolve. Re-encodes (xfade needs filter_complex).
 */
async function crossfadeScenes(
  sceneVideos: string[],
  durationMs: number,
  outPath: string
): Promise<string> {
  const D = Math.max(0.05, durationMs / 1000);
  // Measure each segment so the offsets track real (not assumed) durations.
  const durs = await Promise.all(sceneVideos.map((p) => probeDurationMs(p)));
  // Freeze-tail margin: a touch longer than D so the fade never starves at the
  // boundary. The excess past offset+D is discarded by xfade (harmless).
  const extendSec = (D + 0.25).toFixed(3);

  const inputs: string[] = [];
  for (const p of sceneVideos) inputs.push("-i", p);

  const filters: string[] = [];
  const labels: string[] = [];
  sceneVideos.forEach((_, i) => {
    const last = i === sceneVideos.length - 1;
    // Clone-freeze the tail of every non-last segment so the crossfade overlaps
    // that freeze rather than eating real content. Reset PTS for a clean join.
    const pad = last
      ? ""
      : `tpad=stop_mode=clone:stop_duration=${extendSec},`;
    filters.push(`[${i}:v]${pad}setpts=PTS-STARTPTS[e${i}]`);
    labels.push(`e${i}`);
  });

  let prev = labels[0];
  let cumMs = 0;
  for (let i = 1; i < sceneVideos.length; i++) {
    cumMs += durs[i - 1];
    const offset = (cumMs / 1000).toFixed(3);
    const out = i === sceneVideos.length - 1 ? "xout" : `x${i}`;
    filters.push(
      `[${prev}][${labels[i]}]xfade=transition=fade:duration=${D.toFixed(
        3
      )}:offset=${offset}[${out}]`
    );
    prev = out;
  }

  await runFfmpeg([
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[xout]",
    "-an",
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    outPath,
  ]);
  return outPath;
}

/**
 * Reframe the finished (captioned) video to a different size/aspect — the
 * opt-in `output` block. "contain" scales to fit and pads the remainder
 * (letterbox bars in `background`); "cover" scales to fill and center-crops.
 * Core scale/pad/crop only (portable). This seeds the vertical "social clip"
 * lane: e.g. 720x1280 / 1080x1920 from a 1280x720 take.
 */
async function resizeOutput(
  video: string,
  output: Output,
  tmp: string
): Promise<string> {
  const { width: W, height: H } = output;
  const fit = output.fit ?? "contain";
  const bg = output.background ?? "black";
  const vf =
    fit === "cover"
      ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=${W}:${H},setsar=1`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1`;
  const out = resolve(tmp, "resized.mp4");
  await runFfmpeg([
    "-i",
    video,
    "-vf",
    vf,
    "-an",
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
  log(`output resize -> ${W}x${H} (${fit})`);
  return out;
}

/** Render a title card PNG and encode it as a fade-in/out video segment. */
async function cardSegment(
  card: Card,
  name: string,
  tmp: string,
  storyboard: Storyboard,
  logicalW: number,
  logicalH: number,
  pxScale: number,
  logoDataUri?: string
): Promise<string> {
  const png = resolve(tmp, `${name}.png`);
  await renderCardPng(
    card,
    png,
    Math.round(logicalW),
    Math.round(logicalH),
    pxScale,
    storyboard.brand,
    logoDataUri
  );
  const outW = Math.round(logicalW * pxScale) & ~1;
  const outH = Math.round(logicalH * pxScale) & ~1;
  const durSec = card.durationMs / 1000;
  const fadeSec = Math.min(card.fadeMs / 1000, durSec / 3);
  const out = resolve(tmp, `${name}.mp4`);
  await runFfmpeg([
    "-loop",
    "1",
    "-framerate",
    String(FPS),
    "-i",
    png,
    "-t",
    durSec.toFixed(3),
    "-vf",
    `scale=${outW}:${outH}:flags=lanczos,setsar=1,` +
      `fade=t=in:st=0:d=${fadeSec.toFixed(3)},` +
      `fade=t=out:st=${(durSec - fadeSec).toFixed(3)}:d=${fadeSec.toFixed(3)}`,
    "-r",
    String(FPS),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
  log(`${name} card: "${card.title}" (${card.durationMs}ms)`);
  return out;
}

/**
 * Build the list of [startMs,endMs] video-time spans to keep for a scene:
 * non-idle content in full, each idle span capped to IDLE_CAP_MS.
 */
function keepIntervals(
  tl: Timeline["scenes"][number],
  leadInMs: number
): Array<[number, number]> {
  const vStart = tl.startMs + leadInMs;
  const vEnd = tl.endMs + leadInMs;
  const idles: IdleSpan[] = [...tl.idleSpans]
    .map((s) => ({ ...s, startMs: s.startMs + leadInMs, endMs: s.endMs + leadInMs }))
    .sort((a, b) => a.startMs - b.startMs);

  const keeps: Array<[number, number]> = [];
  let cursor = vStart;
  for (const idle of idles) {
    const s = Math.max(idle.startMs, cursor);
    const e = Math.min(idle.endMs, vEnd);
    if (s <= cursor) {
      // idle starts at/behind cursor: keep only the capped sliver
    } else {
      keeps.push([cursor, s]); // non-idle before the idle
    }
    if (e > s) keeps.push([s, Math.min(e, s + IDLE_CAP_MS)]); // capped idle
    cursor = Math.max(cursor, idle.endMs);
  }
  if (cursor < vEnd) keeps.push([cursor, vEnd]);
  // Drop empty/negative spans.
  return keeps.filter(([a, b]) => b - a > 20);
}

/** One retime piece: kept-span offsets [a,b) play at factor f, starting at stretched ms `out`. */
interface RetimePiece {
  a: number;
  b: number;
  f: number;
  out: number;
}

/**
 * Where a raw-video timestamp lands inside the concatenation of the kept
 * spans. Timestamps inside a trimmed gap clamp to the gap's start.
 */
function offsetInKeeps(keeps: Array<[number, number]>, t: number): number {
  let off = 0;
  for (const [a, b] of keeps) {
    if (t < a) return off;
    if (t <= b) return off + (t - a);
    off += b - a;
  }
  return off;
}

/** Extract each keep span from raw and concat into one mp4 (uniform h264). */
async function extractAndConcat(
  rawVideo: string,
  keeps: Array<[number, number]>,
  outPath: string,
  tmp: string,
  sceneIdx: number
): Promise<void> {
  const parts: string[] = [];
  for (let k = 0; k < keeps.length; k++) {
    const [aMs, bMs] = keeps[k];
    const part = resolve(tmp, `s${sceneIdx}-k${k}.mp4`);
    await runFfmpeg([
      "-ss",
      (aMs / 1000).toFixed(3),
      "-i",
      rawVideo,
      "-t",
      ((bMs - aMs) / 1000).toFixed(3),
      "-an",
      "-r",
      String(FPS),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      part,
    ]);
    parts.push(part);
  }
  if (parts.length === 1) {
    await fs.rename(parts[0], outPath);
    return;
  }
  const listPath = resolve(tmp, `s${sceneIdx}-list.txt`);
  await fs.writeFile(
    listPath,
    parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n"
  );
  await runFfmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    outPath,
  ]);
}

/**
 * Overlay time-gated caption PNGs onto the silent video. Returns the captioned
 * video path (or the input unchanged if there are no cues). This avoids the
 * libass/drawtext ffmpeg filters, which many builds lack; `overlay` is universal.
 */
/**
 * Pixels (at logical/storyboard scale) to lift the caption strip off the very
 * bottom of the frame, so the caption pill clears the app's input bar (e.g.
 * the ChatGPT composer at the bottom) instead of overlapping the prompt.
 */
const CAPTION_BOTTOM_GAP = 96;

/**
 * Max caption cues overlaid in a single ffmpeg pass. Each cue costs one input
 * and one filter link; ffmpeg fails to configure the graph somewhere past ~90
 * (issue #36), so long narrations are burned in several passes.
 */
const CAPTION_BATCH = 32;

/**
 * Overlay many time-gated PNGs onto `src` in passes of ≤ CAPTION_BATCH. Each
 * item is one extra input plus one overlay link; ffmpeg fails to configure a
 * graph somewhere past ~90 of them (issue #36), so long lists are burned in
 * several re-encoding passes. Shared by captions, attention beats, key chips.
 */
async function overlayPngBatches(
  src: string,
  items: OverlayItem[],
  tmp: string,
  label: string
): Promise<{ video: string; passes: number }> {
  if (items.length === 0) return { video: src, passes: 0 };
  const batches: OverlayItem[][] = [];
  for (let i = 0; i < items.length; i += CAPTION_BATCH) {
    batches.push(items.slice(i, i + CAPTION_BATCH));
  }
  if (batches.length > 1) {
    log(`${label} overlay: ${batches.length} pass(es) of <= ${CAPTION_BATCH} item(s)`);
  }
  let cur = src;
  let out = src;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const args: string[] = ["-i", cur];
    for (const it of batch) args.push("-i", it.png);
    const chain: string[] = [];
    let prev = "0:v";
    batch.forEach((it, i) => {
      const inp = `${i + 1}:v`;
      const lbl = i === batch.length - 1 ? "vout" : `o${i}`;
      // Escape the enable-expression commas so ffmpeg doesn't read them as
      // filter separators.
      chain.push(
        `[${prev}][${inp}]overlay=${it.x}:${it.y}:enable=between(t\\,${it.a.toFixed(3)}\\,${it.b.toFixed(3)})[${lbl}]`
      );
      prev = lbl;
    });
    out = resolve(tmp, `${label}-${b}.mp4`);
    await runFfmpeg([
      ...args,
      "-filter_complex",
      chain.join(";"),
      "-map",
      "[vout]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      out,
    ]);
    cur = out;
  }
  return { video: out, passes: batches.length };
}

/** Height of an overlay PNG for the caption-collision check (spotlight → its hole). */
function pngHeightHint(it: OverlayItem, placed: PlacedAttention[], pxScale: number): number {
  if (it.x === 0 && it.y === 0) {
    const ev = placed.find((p) => p.kind === "spotlight" && p.a === it.a && p.b === it.b);
    if (ev) return Math.round((ev.y + ev.h + (ev.padding ?? 10)) * pxScale);
    return 0;
  }
  return it.png.includes("/key-") ? 60 * pxScale : 48 * pxScale;
}

interface CaptionPlacement {
  defaultPosition: "top" | "bottom";
  /** Caption look (style/font/size/color/background), brand font already merged. */
  look?: CaptionsConfig & { font?: string };
  /** Logical (CSS px) width of the frame the strip must span. */
  logicalWidth?: number;
  /** Content-time windows (ms, before the intro shift) with a fixed position. */
  windows: Array<{ a: number; b: number; position: "top" | "bottom" }>;
  /** Content-time windows (ms) during which the bottom band is occupied. */
  collisions: Array<{ a: number; b: number }>;
}

async function burnCaptions(
  project: Project,
  storyboard: Storyboard,
  silentVideo: string,
  tmp: string,
  introMs: number,
  pxScale: number,
  placement: CaptionPlacement = { defaultPosition: "bottom", windows: [], collisions: [] }
): Promise<{ video: string; cues: number; passes: number; flipped: number }> {
  const none = { video: silentVideo, cues: 0, passes: 0, flipped: 0 };
  if (placement.look?.style === "none") {
    log("captions: style none — not burned (SRT/VTT files still written)");
    return none;
  }
  if (!(await exists(project.captionsCuesPath))) return none;
  const cues = (await readJson<Cue[]>(project.captionsCuesPath)) ?? [];
  if (cues.length === 0) return none;

  log(`rendering ${cues.length} caption image(s)`);
  const rendered = await renderCaptionPngs(
    cues,
    resolve(tmp, "captions"),
    Math.round(placement.logicalWidth ?? storyboard.video.width),
    pxScale,
    placement.look ?? {}
  );

  // Cue times are narration-relative; the intro card shifts them right. The
  // strip sits `gap` above the bottom edge (clear of an app's bottom input
  // bar) — or, per scene / on a collision with an attention overlay, at the
  // top: the PNG is a bottom-anchored strip, so "top" flips it vertically.
  // A "bar" strip is flush with the frame edge (no gap, no pill offset).
  const bar = placement.look?.style === "bar";
  const gap = bar ? 0 : Math.round(CAPTION_BOTTOM_GAP * pxScale);
  const { height: outH } = await probeVideoDims(silentVideo);
  let flipped = 0;
  const overlap = (a: number, b: number, w: { a: number; b: number }) => a < w.b && b > w.a;
  const items: OverlayItem[] = rendered.map((r) => {
    let pos = placement.defaultPosition;
    const win = placement.windows.find((w) => r.startMs >= w.a && r.startMs < w.b);
    if (win) pos = win.position;
    else if (pos === "bottom" && placement.collisions.some((c) => overlap(r.startMs, r.endMs, c))) {
      pos = "top";
      flipped++;
    }
    const stripH = Math.round(r.height * pxScale);
    // The strip PNG is bottom-anchored (pill bottom ≈ 22 px above the strip's
    // edge). For "top", slide the strip up so the pill's bottom lands ~gap+70
    // px from the top edge — a one- or two-line pill stays fully in frame.
    const topY = bar
      ? -(stripH - Math.round(62 * pxScale))
      : gap + Math.round(70 * pxScale) - (stripH - Math.round(22 * pxScale));
    return {
      png: r.png,
      x: 0,
      y: pos === "top" ? topY : outH - stripH - gap,
      a: (r.startMs + introMs) / 1000,
      b: (r.endMs + introMs) / 1000,
    };
  });
  if (flipped) log(`captions: ${flipped} cue(s) moved to the top (overlay in the bottom band)`);
  const r = await overlayPngBatches(silentVideo, items, tmp, "captioned");
  return { video: r.video, cues: cues.length, passes: r.passes, flipped };
}

/**
 * Mux the (captioned) video with narration and the optional music bed.
 *
 * Music ducking is dynamic by default: the narration keys a sidechain
 * compressor on the music, so the bed dips under speech and breathes back up
 * in pauses and over the intro/outro cards ("constant" mode keeps the legacy
 * fixed -22dB bed). The bed is trimmed to the video, faded out at the end,
 * and the narration is delayed past the intro card.
 */
/** Output sizing with a preset's defaults filled in (explicit keys win). */
function resolveOutputSizing(output: Output | undefined): Output {
  if (!output) return { fit: "contain" };
  const p = output.preset ? OUTPUT_PRESETS[output.preset] : null;
  return {
    ...output,
    width: output.width ?? p?.width,
    height: output.height ?? p?.height,
    fit: output.width != null ? output.fit : (p?.fit ?? output.fit),
  };
}

/** Write an ffmetadata file with one chapter per scene (content time + intro). */
async function writeChapters(
  tmp: string,
  scenes: Array<{ id: string; title: string; durationMs: number }>
): Promise<string> {
  const lines = [";FFMETADATA1"];
  let t = 0;
  for (const s of scenes) {
    const a = Math.round(t);
    const b = Math.round(t + s.durationMs);
    lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${a}`, `END=${b}`, `title=${s.title.replace(/[\\=;#\n]/g, " ")}`);
    t += s.durationMs;
  }
  const path = resolve(tmp, "chapters.ffmeta");
  await fs.writeFile(path, lines.join("\n") + "\n");
  log(`chapters: ${scenes.length} marker(s)`);
  return path;
}

async function fileToDataUri(path: string): Promise<string> {
  const ext = path.toLowerCase().split(".").pop() ?? "png";
  const mime =
    ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  const buf = await fs.readFile(path);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function muxAudio(
  project: Project,
  storyboard: Storyboard,
  video: string,
  introMs: number,
  chaptersPath: string | null = null
): Promise<void> {
  let musicPath = await resolveMusic(project, storyboard);
  const videoMs = await probeDurationMs(video);
  const durSec = (videoMs / 1000).toFixed(3);

  // Loop the music enough times to cover the video, but FINITELY — an
  // infinite -stream_loop never EOFs through atrim/amix, so ffmpeg would
  // keep transcoding forever instead of stopping at -t.
  let musicLoops = 0;
  if (musicPath) {
    const musicMs = await probeDurationMs(musicPath).catch(() => 0);
    if (musicMs <= 0) {
      log(`music track unreadable at ${musicPath}; skipping background music`);
      musicPath = null;
    } else {
      musicLoops = Math.max(0, Math.ceil(videoMs / musicMs) - 1);
    }
  }

  // Inputs, fixed order: 0=video, 1=narration, 2=music (if any), then the
  // chapters metadata file (mapped by index, never a stream).
  const args: string[] = ["-i", video, "-i", project.narrationPath];
  if (musicPath) args.push("-stream_loop", String(musicLoops), "-i", musicPath);
  let chaptersIdx = -1;
  if (chaptersPath) {
    chaptersIdx = musicPath ? 3 : 2;
    args.push("-i", chaptersPath);
  }

  const delay = introMs > 0 ? `,adelay=${Math.round(introMs)}:all=1` : "";
  const filters: string[] = [];

  // Loudness normalization runs LAST over the muxed audio. Default-ON only when
  // music is actually in the mix (the amix bed drops the master to ~-29 LUFS);
  // an explicit `output.loudness` object forces it on (even narration-only) and
  // `false` disables it. When it's off, the mix terminates directly in [aout]
  // and the narration-only path is byte-for-byte the pre-loudness behavior.
  const loudness = resolveLoudness(storyboard, !!musicPath);
  const mixOut = loudness ? "amixed" : "aout";

  if (musicPath) {
    const m = storyboard.music!; // musicPath implies storyboard.music.track
    const ducking = m.ducking ?? "sidechain";
    const fadeMs = m.fadeOutMs ?? 1800;
    const fadeStart = Math.max(0, (videoMs - fadeMs) / 1000);
    const bedDb = ducking === "constant" ? (m.duckToDb ?? -22) : (m.gainDb ?? -14);
    const bed =
      `[2:a]atrim=0:${durSec},aresample=44100,volume=${bedDb}dB,` +
      `afade=t=out:st=${fadeStart.toFixed(3)}:d=${(fadeMs / 1000).toFixed(3)}[mbed]`;

    // NOTE: every apad uses whole_dur so the filtergraph is FINITE. An
    // unbounded apad never EOFs, and `-t` alone doesn't stop ffmpeg from
    // encoding the endless silence — it would run (and grow the file) forever.
    // amix uses normalize=0: the default normalize=1 divides every input by the
    // input count (2), silently attenuating the NARRATION by ~6 dB — the root of
    // the too-quiet master. normalize=0 keeps each input at its authored level;
    // the final loudnorm sets the absolute master level.
    if (ducking === "sidechain") {
      const threshold = m.duckThreshold ?? 0.02;
      const ratio = m.duckRatio ?? 8;
      const attack = m.duckAttackMs ?? 150;
      const release = m.duckReleaseMs ?? 600;
      filters.push(
        // Pad the sidechain key with silence so the compressor releases (and
        // the bed swells) over the intro/outro instead of ending early.
        `[1:a]aresample=44100${delay},asplit=2[nar][k0]`,
        `[k0]apad=whole_dur=${durSec}[sckey]`,
        bed,
        `[mbed][sckey]sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=${attack}:release=${release}[mduck]`,
        `[nar][mduck]amix=inputs=2:normalize=0:duration=longest:dropout_transition=2,apad=whole_dur=${durSec}[${mixOut}]`
      );
    } else {
      filters.push(
        `[1:a]aresample=44100${delay}[nar]`,
        bed,
        `[nar][mbed]amix=inputs=2:normalize=0:duration=longest:dropout_transition=2,apad=whole_dur=${durSec}[${mixOut}]`
      );
    }
  } else {
    filters.push(`[1:a]aresample=44100${delay},apad=whole_dur=${durSec}[${mixOut}]`);
  }

  // Final loudnorm to a fixed master target. Single-pass loudnorm resamples
  // internally to 192 kHz, so pin the rate back to 44100 (the pipeline's
  // canonical audio rate) — otherwise the muxed AAC balloons.
  if (loudness) {
    filters.push(
      `[amixed]loudnorm=I=${loudness.integrated}:TP=${loudness.truePeak}:LRA=${loudness.lra},` +
        `aresample=44100[aout]`
    );
    log(
      `loudness: loudnorm I=${loudness.integrated} TP=${loudness.truePeak} ` +
        `LRA=${loudness.lra}${musicPath ? "" : " (narration-only override)"}`
    );
  }

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", "0:v", "-map", "[aout]");
  if (chaptersIdx >= 0) args.push("-map_metadata", String(chaptersIdx));
  args.push(
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    // moov atom up front so the MP4 streams/scrubs in a browser tab or a PR
    // preview before it has fully downloaded (frames identical; container only).
    "-movflags",
    "+faststart",
    "-t",
    durSec,
    project.outputPath
  );
  await runFfmpeg(args);
}

/**
 * Decide the final master-loudness target. Off (null) by default so a plain
 * narration render stays byte-for-byte unchanged; on when a `music` block is in
 * the mix (music otherwise leaves the master ~-29 LUFS) OR when the storyboard
 * sets an explicit `output.loudness` object. `output.loudness: false` forces it
 * off even with music. Explicit partial objects have already been filled from
 * LoudnessSchema defaults by zod.
 */
function resolveLoudness(
  storyboard: Storyboard,
  hasMusic: boolean
): Loudness | null {
  const l = storyboard.output?.loudness;
  if (l === false) return null; // explicitly disabled
  if (l) return l; // explicit targets (defaults already applied)
  return hasMusic ? LoudnessSchema.parse({}) : null; // default-on only with music
}

async function resolveMusic(
  project: Project,
  storyboard: Storyboard
): Promise<string | null> {
  const track = storyboard.music?.track;
  if (!track) return null;
  const p = isAbsolute(track) ? track : project.p(track);
  if (await exists(p)) return p;
  log(`music track not found at ${p}; skipping background music`);
  return null;
}

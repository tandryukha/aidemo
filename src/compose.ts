import { promises as fs } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { Project } from "./project.js";
import type { Storyboard, Timeline, IdleSpan, Card } from "./types.js";
import { TimelineSchema, VoiceManifestSchema } from "./types.js";
import type { Cue } from "./captions.js";
import { renderCaptionPngs } from "./caption-render.js";
import { renderCardPng } from "./cards.js";
import { buildZoomFilter, type ZoomEvent } from "./zoom.js";
import { runFfmpeg, probeDurationMs, probeVideoDims } from "./ffmpeg.js";
import { ensureDir, readJson, exists, log, ok, step } from "./util.js";

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
  storyboard: Storyboard
): Promise<void> {
  step("Composing final video (ffmpeg)");

  const timeline = TimelineSchema.parse(await readJson(project.timelinePath));
  const voice = VoiceManifestSchema.parse(
    await readJson(project.voiceManifestPath)
  );
  await warnStaleCaptions(project);
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

  const sceneVideos: string[] = [];
  for (let i = 0; i < timeline.scenes.length; i++) {
    const tl = timeline.scenes[i];
    const narrMs = voiceById.get(tl.id) ?? 0;
    const targetMs = narrMs + voice.gapMs;
    if (targetMs <= 0) {
      log(`scene ${tl.id}: no narration, skipping`);
      continue;
    }

    const keeps = keepIntervals(tl, timeline.leadInMs);
    const rawSegPath = resolve(tmp, `scene-${i}-raw.mp4`);
    await extractAndConcat(rawVideo, keeps, rawSegPath, tmp, i);

    const srcMs = await probeDurationMs(rawSegPath);
    // Retime the segment toward the narration length, but only within
    // [MIN_FACTOR, MAX_STRETCH]. If narration still needs more time, hold
    // (freeze) the last frame for the remainder — natural for a static page,
    // and far better than 3x slow-motion.
    const ratio = targetMs / Math.max(srcMs, 1);
    const factor = Math.min(MAX_STRETCH, Math.max(MIN_FACTOR, ratio));
    let stretchedMs = factor * srcMs;
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
    let vf = `setpts=${factor.toFixed(6)}*PTS`;
    if (overrunTrimMs > 0) {
      vf += `,trim=duration=${(targetMs / 1000).toFixed(3)},setpts=PTS-STARTPTS`;
    }
    if (holdMs > 40) {
      vf += `,tpad=stop_mode=clone:stop_duration=${(holdMs / 1000).toFixed(3)}`;
    }

    // Map this scene's focus events into final-video time for the zoom pass:
    // raw time → offset inside the kept spans → stretched → + scene offset.
    if (zoomCfg && sceneById.get(tl.id)?.zoom !== false) {
      for (const ev of tl.focusEvents ?? []) {
        const rawT = ev.tMs + timeline.leadInMs;
        const local = offsetInKeeps(keeps, rawT) * factor;
        zoomEvents.push({
          tMs: outCursorMs + Math.min(local, stretchedMs),
          x: ev.x * pxScale,
          y: ev.y * pxScale,
          scale: ev.scale,
          holdMs: ev.holdMs,
        });
      }
    }
    outCursorMs += stretchedMs + (holdMs > 40 ? holdMs : 0);

    const scenePath = resolve(tmp, `scene-${i}.mp4`);
    await runFfmpeg([
      "-i",
      rawSegPath,
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
      scenePath,
    ]);
    sceneVideos.push(scenePath);
    log(
      `scene ${tl.id}: ${srcMs}ms -> ${targetMs}ms ` +
        `(x${factor.toFixed(2)}${holdMs > 40 ? ` + ${Math.round(holdMs)}ms hold` : ""}${
          overrunTrimMs > 0 ? ` - ${Math.round(overrunTrimMs)}ms tail trim` : ""
        }, ${keeps.length} span(s))`
    );
  }

  if (sceneVideos.length === 0) throw new Error("No scenes to compose.");

  let content = await concatSegments(sceneVideos, resolve(tmp, "content.mp4"), tmp, "scenes");

  // Auto-zoom pass over the content (never over the cards or captions).
  if (zoomCfg && zoomEvents.length > 0) {
    const contentMs = await probeDurationMs(content);
    const filter = buildZoomFilter(zoomEvents, zoomCfg, outW, outH, contentMs, FPS);
    if (filter) {
      log(`auto-zoom: ${zoomEvents.length} focus event(s)`);
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

  // Intro/outro title cards. Music runs under them; narration and captions
  // shift right by the intro's length.
  const segments: string[] = [];
  const introMs = storyboard.intro ? storyboard.intro.durationMs : 0;
  if (storyboard.intro) {
    segments.push(
      await cardSegment(storyboard.intro, "intro", tmp, storyboard, outW, outH, pxScale)
    );
  }
  segments.push(content);
  if (storyboard.outro) {
    segments.push(
      await cardSegment(storyboard.outro, "outro", tmp, storyboard, outW, outH, pxScale)
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

  const captioned = await burnCaptions(
    project,
    storyboard,
    fullVideo,
    tmp,
    introMs,
    pxScale
  );
  await muxAudio(project, storyboard, captioned, introMs);
  ok(`final video → ${project.outputPath}`);
  // AIDEMO_KEEP_TMP=1 keeps .compose-tmp for debugging intermediates.
  if (!process.env.AIDEMO_KEEP_TMP) {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * A re-voice after captions were generated leaves the caption files stale —
 * compose would silently burn OLD caption text over the NEW audio, and the
 * mismatch only shows up in review (bit us on maxfit-chatgpt-v3). Whisper
 * needs an API key so compose can't regenerate them itself; warn loudly and
 * name the fix instead.
 */
async function warnStaleCaptions(project: Project): Promise<void> {
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
    }
  } catch {
    /* captions or narration absent — burnCaptions handles missing captions */
  }
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

/** Render a title card PNG and encode it as a fade-in/out video segment. */
async function cardSegment(
  card: Card,
  name: string,
  tmp: string,
  storyboard: Storyboard,
  outW: number,
  outH: number,
  pxScale: number
): Promise<string> {
  const png = resolve(tmp, `${name}.png`);
  await renderCardPng(
    card,
    png,
    storyboard.video.width,
    storyboard.video.height,
    pxScale
  );
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

async function burnCaptions(
  project: Project,
  storyboard: Storyboard,
  silentVideo: string,
  tmp: string,
  introMs: number,
  pxScale: number
): Promise<string> {
  if (!(await exists(project.captionsCuesPath))) return silentVideo;
  const cues = (await readJson<Cue[]>(project.captionsCuesPath)) ?? [];
  if (cues.length === 0) return silentVideo;

  log(`rendering ${cues.length} caption image(s)`);
  const rendered = await renderCaptionPngs(
    cues,
    resolve(tmp, "captions"),
    storyboard.video.width,
    pxScale
  );

  const args: string[] = ["-i", silentVideo];
  for (const r of rendered) args.push("-i", r.png);

  // Chain one overlay per cue, each enabled only during its time window.
  // Cue times are narration-relative; the intro card shifts them right.
  const gap = Math.round(CAPTION_BOTTOM_GAP * pxScale);
  const chain: string[] = [];
  let prev = "0:v";
  rendered.forEach((r, i) => {
    const inp = `${i + 1}:v`;
    const out = i === rendered.length - 1 ? "vout" : `o${i}`;
    const a = ((r.startMs + introMs) / 1000).toFixed(3);
    const b = ((r.endMs + introMs) / 1000).toFixed(3);
    // Escape the enable-expression commas so ffmpeg doesn't read them as filter
    // separators. Lift the strip clear of the app's bottom input bar (the
    // ChatGPT composer) so captions never sit on top of the prompt being typed.
    chain.push(
      `[${prev}][${inp}]overlay=0:H-h-${gap}:enable=between(t\\,${a}\\,${b})[${out}]`
    );
    prev = out;
  });

  const out = resolve(tmp, "captioned.mp4");
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
  return out;
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
async function muxAudio(
  project: Project,
  storyboard: Storyboard,
  video: string,
  introMs: number
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

  // Inputs, fixed order: 0=video, 1=narration, 2=music (if any).
  const args: string[] = ["-i", video, "-i", project.narrationPath];
  if (musicPath) args.push("-stream_loop", String(musicLoops), "-i", musicPath);

  const delay = introMs > 0 ? `,adelay=${Math.round(introMs)}:all=1` : "";
  const filters: string[] = [];

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
        `[nar][mduck]amix=inputs=2:duration=longest:dropout_transition=2,apad=whole_dur=${durSec}[aout]`
      );
    } else {
      filters.push(
        `[1:a]aresample=44100${delay}[nar]`,
        bed,
        `[nar][mbed]amix=inputs=2:duration=longest:dropout_transition=2,apad=whole_dur=${durSec}[aout]`
      );
    }
  } else {
    filters.push(`[1:a]aresample=44100${delay},apad=whole_dur=${durSec}[aout]`);
  }

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", "0:v", "-map", "[aout]");
  args.push(
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    durSec,
    project.outputPath
  );
  await runFfmpeg(args);
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

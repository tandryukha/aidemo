import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import type {
  Storyboard,
  Timeline,
  TimelineScene,
  ProbeGoldenScene,
} from "./types.js";
import { Project } from "./project.js";
import { cursorInitScript } from "./cursor.js";
import { runStoryboard } from "./player.js";
import {
  chromeProfileDir,
  defaultCaptureMode,
  captureDevice,
  obsUrl,
  obsPassword,
} from "./config.js";
import {
  type CaptureMode,
  type CaptureProvider,
  type ViewportGeometry,
  AvfoundationCapture,
  ObsCapture,
  measureViewportGeometry,
  cropCaptureToViewport,
  verifyCaptureMatchesPage,
} from "./capture.js";
import { ensureProfileUnlocked } from "./login.js";
import { ensureDir, exists, writeJson, log, ok, step } from "./util.js";
import { probeDurationMs } from "./ffmpeg.js";
import { dirname, join } from "node:path";

const FPS = 30;

export interface RecordOptions {
  /** Chrome user-data dir (logged-in profile). Defaults to config profile. */
  profileDir?: string;
  /** Show the browser window. Default true (channel chrome needs a display). */
  headed?: boolean;
  /**
   * Capture path. "playwright" (default) = built-in CDP video; "native" =
   * ffmpeg avfoundation screen grab (macOS); "obs" = OBS via obs-websocket.
   * The external paths record the real screen for higher fidelity, then crop
   * to the viewport. Env default: AIDEMO_CAPTURE.
   */
  capture?: CaptureMode;
  /** Progress hooks + best-effort cancellation for job runners (MCP). */
  onSceneStart?: (sceneId: string, index: number, total: number) => void;
  onSceneComplete?: (scene: TimelineScene, index: number, total: number) => void;
  signal?: AbortSignal;
  /**
   * Golden-probe capture (see PlayerOptions.probe / src/golden.ts). When present,
   * the run records a normalized per-action outcome into this array and doesn't
   * abort on an action failure — for `aidemo probe --golden/--update-golden`.
   */
  probe?: ProbeGoldenScene[];
}

/**
 * Drives the storyboard's actions through a real, logged-in Chrome while
 * recording — either via Playwright's built-in video (raw.webm) or an
 * external screen capture (raw.mp4). Also writes timeline.json.
 */
export async function record(
  project: Project,
  storyboard: Storyboard,
  options: RecordOptions = {}
): Promise<Timeline> {
  step(`Recording "${storyboard.title}"`);
  await project.ensureDirs();
  await ensureDir(dirname(project.rawVideoPath));

  const mode = (options.capture ?? defaultCaptureMode()) as CaptureMode;
  const external = mode !== "playwright";
  if (external && options.headed === false) {
    throw new Error(
      `--capture ${mode} records the real screen; run headed (drop --headless).`
    );
  }

  const profileDir = options.profileDir ?? chromeProfileDir();
  // Fail fast with the actual fix when Chrome is still running on the profile
  // (a live lock stalls Playwright and then dies with a raw ProcessSingleton
  // error); clean up a stale lock from a crashed Chrome.
  await ensureProfileUnlocked(profileDir);
  const { width, height } = storyboard.video;
  const videoDir = dirname(project.rawVideoPath);
  log(`profile: ${profileDir}`);
  log(`viewport: ${width}x${height}`);
  if (external) log(`capture mode: ${mode}`);

  // Preserve the previous take as ONE `.prev` generation instead of deleting
  // it: a bad new take (mid-run failure, wrong native-capture crop) must not
  // destroy the last good recording. Roll back by copying raw.prev.* /
  // timeline.prev.json over the current files.
  const prevGeneration: Array<[string, string]> = [
    [project.rawVideoPath, project.rawVideoPrevPath],
    [project.rawVideoMp4Path, project.rawVideoMp4PrevPath],
    [project.timelinePath, project.timelinePrevPath],
  ];
  for (const [, prev] of prevGeneration) await fs.rm(prev, { force: true });
  const preserved: string[] = [];
  for (const [current, prev] of prevGeneration) {
    if (await exists(current)) {
      await fs.rename(current, prev);
      preserved.push(prev);
    }
  }
  if (preserved.length) {
    log(`previous take preserved → ${preserved.join(", ")}`);
  }
  // Clear stray recordings so we can unambiguously pick the new one afterwards.
  for (const f of await fs.readdir(videoDir).catch(() => [])) {
    if (f.endsWith(".webm") && !f.includes(".prev")) {
      await fs.rm(join(videoDir, f), { force: true });
    }
  }
  const screenCapPath = join(videoDir, "capture.mkv");
  await fs.rm(screenCapPath, { force: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: options.headed === false,
      // Hide the automation fingerprint (navigator.webdriver=false) so
      // Cloudflare on chatgpt.com doesn't throw a "Verify you are human"
      // challenge mid-recording. The profile's real cf_clearance cookie is
      // then honored because the browser matches the manual-login fingerprint.
      args: [
        "--disable-blink-features=AutomationControlled",
        // Keep the window at a known spot on the primary screen for capture.
        ...(external ? ["--window-position=40,60"] : []),
      ],
      // External capture records the REAL screen and needs real window
      // geometry, so it runs UN-emulated (viewport: null — under emulation
      // innerWidth/screen.width/devicePixelRatio all report fake values,
      // which mis-scaled the crop to the whole screen on Retina displays,
      // issue #13). measureViewportGeometry() below sizes the actual window
      // to the storyboard viewport instead. The built-in recorder keeps the
      // emulated viewport and 2x scale for crisper output.
      ...(external
        ? { viewport: null }
        : {
            viewport: { width, height },
            deviceScaleFactor: 2,
            recordVideo: {
              dir: dirname(project.rawVideoPath),
              size: { width, height },
            },
          }),
    });
  } catch (err) {
    throw new Error(
      `Failed to launch Chrome with profile ${profileDir}.\n` +
        `If Chrome is already open on this profile, quit it first (Playwright ` +
        `needs exclusive access to the profile).\nOriginal error: ${
          (err as Error).message
        }`
    );
  }

  // Cursor rendering. Default: BAKE the animated cursor into every frame before
  // any page script runs. When the storyboard opts into compose-time cursor
  // control (a `cursor` block), skip the bake and record a clean, cursor-free
  // take instead — the player logs the cursor path and compose draws it as an
  // overlay, so hide/resize becomes a recompose rather than a re-record.
  const composeCursor = !!storyboard.cursor;
  if (!composeCursor) {
    await context.addInitScript({ content: cursorInitScript() });
  } else {
    log("cursor: compose-time overlay (recording cursor-free take + path)");
  }

  const page = context.pages()[0] ?? (await context.newPage());

  // Start from a clean blank so the recording's lead-in isn't the new-tab page.
  await page.goto("about:blank");

  let capture: CaptureProvider | null = null;
  let geo: ViewportGeometry | null = null;
  if (external) {
    await page.bringToFront();
    // Size the real window to the storyboard viewport and measure where it
    // sits on screen (CDP window bounds + un-emulated page metrics, re-read
    // until stable). Throws BEFORE any screen pixels are captured when the
    // geometry can't be made safe to crop (see capture.ts, issue #13).
    geo = await measureViewportGeometry(page, { width, height });
    capture =
      mode === "native"
        ? new AvfoundationCapture(screenCapPath, captureDevice(), FPS)
        : new ObsCapture(obsUrl(), obsPassword());
    log(`starting ${capture.name}`);
    await capture.start();
    // Re-assert front-most right before driving: the measure/start dance takes
    // seconds, and a screen grab records whatever window is PAINTED at the
    // crop rect — an occluded browser silently ships someone else's window
    // into the take (issue #21).
    await page.bringToFront();
  }

  const t0 = Date.now();
  const logsDir = project.p("logs");
  const doneScenes: TimelineScene[] = [];
  let timeline: Timeline;
  let capFile: string | null = null;
  let captureRefPath: string | null = null;
  let tailMs = 0;
  let recordErr: unknown = null;
  try {
    timeline = await runStoryboard(page, storyboard, {
      t0,
      video: { width, height },
      logsDir,
      signal: options.signal,
      probe: options.probe,
      captureCursorPath: composeCursor,
      onSceneStart: options.onSceneStart,
      onSceneComplete: (s, i, total) => {
        doneScenes.push(s);
        options.onSceneComplete?.(s, i, total);
      },
    });
    if (capture) {
      // Reference frame for the post-crop content verification (issue #21):
      // the CDP page buffer at stop time — immune to window occlusion, so if
      // the cropped screen pixels don't match it, the grab recorded something
      // other than the driven page. Taken BEFORE stopAt so its latency lands
      // in the (trimmed) tail, not in the lead-in math.
      captureRefPath = join(videoDir, "capture-ref.png");
      await page
        .screenshot({ path: captureRefPath, timeout: 5000 })
        .catch(() => (captureRefPath = null));
      // Stop immediately so the tail past the last scene stays small. Measure
      // the tail at stop-initiation — the recorder stops taking frames at the
      // stop signal, not when it finishes flushing the file.
      const stopAt = Date.now();
      capFile = await capture.stop();
      tailMs = Math.max(0, stopAt - (t0 + timeline.totalMs));
    }
  } catch (err) {
    // Salvage: a failure in scene 7 of 7 (a phantom click, a platform
    // interruption) otherwise discards minutes of good recording. Keep the
    // scenes that completed, still finalize the video below, then re-throw so
    // the exit code stays 1. `record --from-scene <id>` resume is future work.
    recordErr = err;
    const lastEnd = doneScenes.length ? doneScenes[doneScenes.length - 1].endMs : 0;
    timeline = { totalMs: lastEnd, leadInMs: 0, scenes: doneScenes };
    if (capture && !capFile) {
      const stopAt = Date.now();
      capFile = await capture.stop().catch(() => null);
      tailMs = Math.max(0, stopAt - (t0 + timeline.totalMs));
    }
  } finally {
    if (capture && !capFile) await capture.stop().catch(() => {});
    // For built-in capture, closing the context finalizes the video file.
    await context.close();
  }

  let finalized = false;
  try {
  if (external) {
    await fs.rm(project.rawVideoPath, { force: true });
    await cropCaptureToViewport(
      capFile!,
      project.rawVideoMp4Path,
      geo!,
      width,
      height,
      FPS
    );
    await fs.rm(capFile!, { force: true });
    // Content guard (issue #21): geometry can be perfect while the pixels are
    // some other window's (occlusion / wrong display). On mismatch this throws
    // and keeps both files for review; on pass the reference is cleaned up.
    // A salvaged (failed) take skips it — the reference may not exist.
    if (captureRefPath && !recordErr) {
      await verifyCaptureMatchesPage(project.rawVideoMp4Path, captureRefPath);
      await fs.rm(captureRefPath, { force: true });
    } else if (!recordErr) {
      log(
        "⚠ no page reference screenshot — capture content not verified; frame-review the take"
      );
    }
    const videoMs = await probeDurationMs(project.rawVideoMp4Path);
    // Capture started before t0 and stopped ~tailMs after the last scene.
    timeline.leadInMs = Math.max(0, videoMs - tailMs - timeline.totalMs);
    await writeJson(project.timelinePath, timeline);
    log(
      `video ${videoMs}ms, content ${timeline.totalMs}ms, tail ${tailMs}ms → lead-in ${timeline.leadInMs}ms`
    );
    ok(`recording → ${project.rawVideoMp4Path}`);
    finalized = true;
  } else {
    // saveAs() is unreliable for persistent contexts (needs the closed
    // connection), so locate the finalized .webm on disk and move it. A demo may
    // open a second tab (e.g. a checkout hand-off to an external site), which Playwright
    // records as its own short .webm — so pick the LARGEST file (the full main-page
    // recording), not just the first one, then drop the strays. The preserved
    // previous take (raw.prev.webm) is not a candidate.
    const produced = (await fs.readdir(videoDir)).filter(
      (f) => f.endsWith(".webm") && !f.includes(".prev")
    );
    if (produced.length === 0) {
      throw new Error(`No video produced in ${videoDir}`);
    }
    let mainVideo = produced[0];
    let mainSize = -1;
    for (const f of produced) {
      const { size } = await fs.stat(join(videoDir, f));
      if (size > mainSize) {
        mainSize = size;
        mainVideo = f;
      }
    }
    for (const f of produced) {
      if (f !== mainVideo) await fs.rm(join(videoDir, f), { force: true });
    }
    await fs.rename(join(videoDir, mainVideo), project.rawVideoPath);

    // The front lead-in (about:blank + launch) = actual video length minus the
    // measured content span. This is more reliable than timing the launch.
    const videoMs = await probeDurationMs(project.rawVideoPath);
    timeline.leadInMs = Math.max(0, videoMs - timeline.totalMs);
    await writeJson(project.timelinePath, timeline);
    log(
      `video ${videoMs}ms, content ${timeline.totalMs}ms → lead-in ${timeline.leadInMs}ms`
    );
    ok(`recording → ${project.rawVideoPath}`);
    finalized = true;
  }
  } catch (finalizeErr) {
    // A partial take may not finalize cleanly (e.g. a truncated webm); tolerate
    // it when we're already salvaging, but surface a real finalize failure.
    if (!recordErr) throw finalizeErr;
    log(`salvage: could not finalize recording (${(finalizeErr as Error).message})`);
  }

  if (finalized) {
    ok(
      `timeline  → ${project.timelinePath} (${timeline.scenes.length} scenes, ${timeline.totalMs}ms)`
    );
  }
  if (recordErr) {
    log(
      `salvaged ${doneScenes.length}/${storyboard.scenes.length} scene(s) before failure; ` +
        `see logs/ for the screenshot + frame dump, then re-run`
    );
    throw recordErr;
  }
  return timeline;
}

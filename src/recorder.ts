import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import type { Storyboard, Timeline, TimelineScene } from "./types.js";
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
  viewportGeometry,
  cropCaptureToViewport,
} from "./capture.js";
import { ensureDir, writeJson, log, ok, step } from "./util.js";
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
  const { width, height } = storyboard.video;
  const videoDir = dirname(project.rawVideoPath);
  log(`profile: ${profileDir}`);
  log(`viewport: ${width}x${height}`);
  if (external) log(`capture mode: ${mode}`);

  // Clear stray recordings so we can unambiguously pick the new one afterwards.
  for (const f of await fs.readdir(videoDir).catch(() => [])) {
    if (f.endsWith(".webm")) await fs.rm(join(videoDir, f), { force: true });
  }
  await fs.rm(project.rawVideoMp4Path, { force: true });
  const screenCapPath = join(videoDir, "capture.mkv");
  await fs.rm(screenCapPath, { force: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: options.headed === false,
      viewport: { width, height },
      // Hide the automation fingerprint (navigator.webdriver=false) so
      // Cloudflare on chatgpt.com doesn't throw a "Verify you are human"
      // challenge mid-recording. The profile's real cf_clearance cookie is
      // then honored because the browser matches the manual-login fingerprint.
      args: [
        "--disable-blink-features=AutomationControlled",
        // Keep the window at a known spot on the primary screen for capture.
        ...(external ? ["--window-position=40,60"] : []),
      ],
      // External capture uses the screen's own pixel density; the built-in
      // recorder emulates 2x for crisper output.
      ...(external
        ? {}
        : {
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

  // Inject the animated cursor into every frame before any page script runs.
  await context.addInitScript({ content: cursorInitScript() });

  const page = context.pages()[0] ?? (await context.newPage());

  // Start from a clean blank so the recording's lead-in isn't the new-tab page.
  await page.goto("about:blank");

  let capture: CaptureProvider | null = null;
  let geo: ViewportGeometry | null = null;
  if (external) {
    await page.bringToFront();
    geo = await viewportGeometry(page);
    capture =
      mode === "native"
        ? new AvfoundationCapture(screenCapPath, captureDevice(), FPS)
        : new ObsCapture(obsUrl(), obsPassword());
    log(`starting ${capture.name}`);
    await capture.start();
  }

  const t0 = Date.now();
  const logsDir = project.p("logs");
  const doneScenes: TimelineScene[] = [];
  let timeline: Timeline;
  let capFile: string | null = null;
  let tailMs = 0;
  let recordErr: unknown = null;
  try {
    timeline = await runStoryboard(page, storyboard, {
      t0,
      video: { width, height },
      logsDir,
      onSceneComplete: (s) => doneScenes.push(s),
    });
    if (capture) {
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
    // recording), not just the first one, then drop the strays.
    const produced = (await fs.readdir(videoDir)).filter((f) =>
      f.endsWith(".webm")
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

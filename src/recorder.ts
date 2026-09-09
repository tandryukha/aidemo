import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import {
  TimelineSchema,
  type Scene,
  type Storyboard,
  type Timeline,
  type TimelineScene,
  type ProbeGoldenScene,
  type SeedCookie,
} from "./types.js";
import { Project } from "./project.js";
import { cursorInitScript } from "./cursor.js";
import { hideCss } from "./player.js";
import { runStoryboard } from "./player.js";
import {
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
import { resolveProfile } from "./profile.js";
import { applySeeds, collectSeeds, runPreflight } from "./setup.js";
import { ensureDir, exists, readJson, writeJson, log, ok, step } from "./util.js";
import { probeDurationMs } from "./ffmpeg.js";
import { dirname, extname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const FPS = 30;

/**
 * Identity of a scene's take: everything that changes what the camera sees
 * for that scene. `record --from-scene` reuses a previous take's scene only
 * when this still matches, so a resumed demo never splices stale footage.
 */
export function sceneHash(storyboard: Storyboard, scene: Scene): string {
  return hashIdent({
    ...legacyIdent(storyboard, scene),
    // A param change that alters typed text already shows up in `actions`
    // (params resolve at load time), but one that only moves `setup` — a
    // different cookie, a different storageState, another preflight — used to
    // slip through and splice footage of a differently-prepared app.
    setup: storyboard.setup ?? null,
    params: storyboard.params ?? null,
  });
}

/** The pre-`setup`/`params` identity — only to recognize takes recorded before it. */
export function legacySceneHash(storyboard: Storyboard, scene: Scene): string {
  return hashIdent(legacyIdent(storyboard, scene));
}

function legacyIdent(storyboard: Storyboard, scene: Scene): Record<string, unknown> {
  return {
    id: scene.id,
    actions: scene.actions,
    hide: [...(storyboard.hide ?? []), ...(scene.hide ?? [])],
    redact: [...(storyboard.redact ?? []), ...(scene.redact ?? [])],
    video: storyboard.video,
    cursor: !!storyboard.cursor,
  };
}

function hashIdent(ident: unknown): string {
  return createHash("sha256").update(JSON.stringify(ident)).digest("hex").slice(0, 16);
}

/** `recordings/raw.keep-<stamp>.<ext>` — footage a resumed take still references. */
const KEEP_RE = /^raw\.keep-.*\.(webm|mp4)$/;

export interface RecordOptions {
  /** Chrome user-data dir (logged-in profile). Defaults to config profile. */
  profileDir?: string;
  /**
   * Run against a WIPED throwaway profile (`<demo>/.chrome-profile-fresh`)
   * instead of the shared one. Use for any storyboard that shows a first-run
   * gate, onboarding, an empty state or a one-shot flow — carried-over state
   * silently records the wrong story (see src/profile.ts).
   */
  fresh?: boolean;
  /**
   * Playwright storageState JSON to seed (cookies + per-origin localStorage)
   * before the first action — on top of the storyboard's `setup.storageState`.
   */
  storageState?: string;
  /** Cookies to seed before the first action (on top of `setup.cookies`). */
  cookies?: SeedCookie[];
  /**
   * The profile is seeded on purpose (a login, a cookie gate): silence the
   * carried-over-state warning. Implied by seeds and by `setup.expectState`.
   */
  profileSeeded?: boolean;
  /**
   * Re-read the storyboard after a `setup.preflight` hook ran — the hook may
   * have patched it (e.g. a selector for today's fixture). Call sites pass the
   * same loader they used, so params/relaxed semantics are preserved.
   */
  reloadStoryboard?: () => Promise<Storyboard>;
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
  /**
   * Resume from this scene id: the previous take's scenes before it are kept
   * (footage + timeline, verified unchanged by hash) and only replayed at speed
   * to rebuild app state; recording starts at this scene.
   */
  fromScene?: string;
  /** With `fromScene`: skip the reused scenes' actions instead of replaying them (state-earning flows). */
  noReplay?: boolean;
}

/**
 * Drives the storyboard's actions through a real, logged-in Chrome while
 * recording — either via Playwright's built-in video (raw.webm) or an
 * external screen capture (raw.mp4). Also writes timeline.json.
 */
export async function record(
  project: Project,
  storyboardIn: Storyboard,
  options: RecordOptions = {}
): Promise<Timeline> {
  let storyboard = storyboardIn;
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

  const { dir: profileDir, warning: profileWarning } = await resolveProfile(
    project.dir,
    storyboard,
    { profileDir: options.profileDir, fresh: options.fresh }
  );
  // Fail fast with the actual fix when Chrome is still running on the profile
  // (a live lock stalls Playwright and then dies with a raw ProcessSingleton
  // error); clean up a stale lock from a crashed Chrome.
  await ensureProfileUnlocked(profileDir);
  log(`profile: ${profileDir}${options.fresh ? " (fresh)" : ""}`);

  // Preflight hook (issue #44): runs before Chrome launches, with the resolved
  // profile in its env. It may rewrite the storyboard (a rotating fixture), so
  // re-read it afterwards when the caller gave us a loader.
  if (storyboard.setup?.preflight) {
    await runPreflight(storyboard.setup.preflight, {
      demoDir: project.dir,
      storyboardPath: project.storyboardPath,
      profileDir,
    });
    if (options.reloadStoryboard) storyboard = await options.reloadStoryboard();
  }
  const seeds = await collectSeeds(project.dir, storyboard, {
    storageState: options.storageState,
    cookies: options.cookies,
  });
  // A deliberately seeded profile is the point, not the trap the warning
  // names — acknowledge it via --profile-seeded / setup.expectState / seeds.
  const seededOnPurpose =
    !!options.profileSeeded || !!storyboard.setup?.expectState || !!seeds;
  if (profileWarning && !seededOnPurpose) log(`  ! ${profileWarning}`);

  const { width, height } = storyboard.video;
  const videoDir = dirname(project.rawVideoPath);
  log(`viewport: ${width}x${height}`);
  if (external) log(`capture mode: ${mode}`);

  // Resume: keep the previous take's leading scenes. Their raw file moves to a
  // `raw.keep-*` name that the reused timeline scenes point at, the take's
  // rotation below then only sees the new recording, and unreferenced keep
  // files are swept once the resumed timeline is written.
  let fromIndex = 0;
  const reused: TimelineScene[] = [];
  if (options.fromScene) {
    fromIndex = storyboard.scenes.findIndex((s) => s.id === options.fromScene);
    if (fromIndex < 0) {
      throw new Error(`--from-scene: no scene "${options.fromScene}" in the storyboard`);
    }
    if (fromIndex === 0) {
      log(`--from-scene ${options.fromScene} is the first scene — recording the full take`);
    } else {
      const prevRaw = await project.resolveRawVideo();
      if (!(await exists(project.timelinePath)) || !(await exists(prevRaw))) {
        throw new Error(
          `--from-scene: no previous take to resume from (need ${project.timelinePath} + ${prevRaw}); record the full demo first`
        );
      }
      const prev = TimelineSchema.parse(await readJson(project.timelinePath));
      for (let i = 0; i < fromIndex; i++) {
        const sc = storyboard.scenes[i];
        const ps = prev.scenes[i];
        if (!ps || ps.id !== sc.id) {
          throw new Error(
            `--from-scene: the previous take has ${ps ? `"${ps.id}"` : "nothing"} at position ${i + 1}, the storyboard has "${sc.id}" — scene order changed; record the full demo`
          );
        }
        if (!ps.hash) {
          throw new Error(
            `--from-scene: the previous take predates resume support (no scene hashes); record the full demo once, then resume`
          );
        }
        if (ps.hash !== sceneHash(storyboard, sc)) {
          if (ps.hash === legacySceneHash(storyboard, sc)) {
            // Recorded before `setup`/`params` were part of the identity: the
            // action-spec still matches, so reuse the footage, but say plainly
            // what can no longer be checked.
            log(
              `resume: scene "${sc.id}" predates setup/params hashing — its actions match, but a changed \`setup\` (cookies, storageState, preflight) would not be caught; re-record if the app is prepared differently now`
            );
          } else {
            throw new Error(
              `--from-scene: scene "${sc.id}" changed since the previous take (actions, hide, redact, viewport, cursor mode, setup or params) — resume from "${sc.id}" or earlier`
            );
          }
        }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const keepPath = join(videoDir, `raw.keep-${stamp}${extname(prevRaw)}`);
      await fs.rename(prevRaw, keepPath);
      const keepRel = relative(project.dir, keepPath);
      for (const ps of prev.scenes.slice(0, fromIndex)) {
        reused.push({
          ...ps,
          source: ps.source ?? keepRel,
          leadInMs: ps.leadInMs ?? prev.leadInMs,
        });
      }
      log(
        `resume: reusing ${reused.length} scene(s) from the previous take (${keepRel}); recording from "${options.fromScene}"`
      );
    }
  }

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
    if (f.endsWith(".webm") && !f.includes(".prev") && !KEEP_RE.test(f)) {
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

  // Top-level `hide`: a stylesheet injected before any page script, in every
  // frame and across navigations — teasers, cookie bars, ad slots that would
  // photobomb the take. The ONE record-time exception to compose-time polish.
  if (storyboard.hide?.length) {
    const css = hideCss(storyboard.hide);
    await context.addInitScript({
      content:
        `(() => { const add = () => { const s = document.createElement("style");` +
        ` s.id = "__aidemo_hide"; s.textContent = ${JSON.stringify(css)};` +
        ` (document.head || document.documentElement).appendChild(s); };` +
        ` if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add(); })();`,
    });
    log(`hide: ${storyboard.hide.length} selector(s) hidden at record time`);
  }

  const page = context.pages()[0] ?? (await context.newPage());

  // Start from a clean blank so the recording's lead-in isn't the new-tab page.
  await page.goto("about:blank");
  // Seed cookies / localStorage (issue #44). Any origin visits this needs land
  // in the lead-in, which compose trims.
  if (seeds) await applySeeds(context, page, seeds);

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
  let salvageTailMs = 0;
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
      baseDir: project.dir,
      replayUntil: fromIndex || undefined,
      skipReplay: !!options.noReplay,
      onSceneStart: options.onSceneStart,
      onSceneReplayed: (id, i, total) => {
        // Progress-wise a replayed scene is "done": its footage already exists.
        options.onSceneComplete?.(reused[i], i, total);
      },
      onSceneComplete: (s, i, total) => {
        s.hash = sceneHash(storyboard, storyboard.scenes[i]);
        doneScenes.push(s);
        options.onSceneComplete?.(s, i, total);
      },
    });
    timeline.scenes = [...reused, ...doneScenes];
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
    // the exit code stays 1; `record --from-scene <id>` resumes past them.
    recordErr = err;
    const lastEnd = doneScenes.length ? doneScenes[doneScenes.length - 1].endMs : 0;
    timeline = { totalMs: lastEnd, leadInMs: 0, scenes: [...reused, ...doneScenes] };
    // The take kept recording through the FAILED scene (its goto, waits and
    // the assert/timeout that broke it). That footage sits AFTER the last
    // completed scene, so it must not be mistaken for front lead-in at
    // finalize: otherwise every reused scene of a later `--from-scene` resume
    // is read that many ms too late and plays ahead of its narration.
    salvageTailMs = Math.max(0, Date.now() - t0 - lastEnd);
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
      (f) => f.endsWith(".webm") && !f.includes(".prev") && !KEEP_RE.test(f)
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
    timeline.leadInMs = Math.max(0, videoMs - timeline.totalMs - salvageTailMs);
    await writeJson(project.timelinePath, timeline);
    log(
      `video ${videoMs}ms, content ${timeline.totalMs}ms${salvageTailMs ? `, failed-scene tail ${salvageTailMs}ms` : ""} → lead-in ${timeline.leadInMs}ms`
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
    // Sweep keep files no scene of the written timeline points at anymore.
    const referenced = new Set(
      timeline.scenes.filter((s) => s.source).map((s) => resolve(project.dir, s.source!))
    );
    for (const f of await fs.readdir(videoDir).catch(() => [])) {
      const p = join(videoDir, f);
      if (KEEP_RE.test(f) && !referenced.has(p)) await fs.rm(p, { force: true });
    }
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

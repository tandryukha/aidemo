import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Project } from "../project.js";
import { probeDurationMs } from "../ffmpeg.js";
import { loadNativeTimeline, loadStoreProject, resolveIn, storePaths } from "../store/project.js";
import type { NativeMark, NativeTimeline, StoreProject, StoreScene } from "../types.js";
import { ensureDir, log, ok, sleep, step, writeJson } from "../util.js";
import { openDevice, type Device } from "./device.js";
import { runMaestroFlow, type MaestroCommandTiming } from "./maestro.js";

/**
 * `native-record`: one clip per scene on an iOS Simulator / Android emulator.
 *
 * Per scene: run its `setup` flow (not filmed) → start the device recorder →
 * run the scene's Maestro `flow` (or `steps`) → settle → stop → optional
 * full-resolution `still`. Maestro's per-command timings are shifted onto the
 * clip's clock and saved as marks (generated/native-timeline.json), which is
 * what `store-video` ramps and holds by label. The flows are fixed specs: no
 * LLM steers a take, so re-recording replays the same thing.
 *
 * One clip per scene (instead of one long take) keeps every scene re-recordable
 * on its own (`--only`), sidesteps Android screenrecord's 180 s cap, and makes
 * scene boundaries exact.
 */

export interface NativeRecordOptions {
  only?: string[];
  boot?: boolean;
  deviceId?: string;
  /** An already-open device (tests; an embedding host) instead of `openDevice`. */
  device?: Device;
  signal?: AbortSignal;
  onSceneStart?: (id: string, index: number, total: number) => void;
  onSceneComplete?: (id: string, index: number, total: number) => void;
}

/** Settle time after the flow before the recorder stops (last frame lands). */
const SETTLE_MS = 600;

export async function sceneHash(project: Project, store: StoreProject, scene: StoreScene): Promise<string> {
  const h = createHash("sha256");
  h.update(JSON.stringify({ platform: store.device.platform, env: { ...store.env, ...scene.env }, steps: scene.steps ?? null }));
  for (const f of [scene.flow, scene.setup, scene.clip]) {
    if (f) h.update(await fs.readFile(resolveIn(project, f)).catch(() => Buffer.from("missing:" + f)));
  }
  return h.digest("hex").slice(0, 16);
}

/** Shift epoch-ms command timings onto the clip clock. */
export function toClipMarks(timings: MaestroCommandTiming[], clipStartEpochMs: number): NativeMark[] {
  return timings.map((t) => ({
    command: t.command,
    ...(t.label ? { label: t.label } : {}),
    startMs: Math.max(0, t.startMs - clipStartEpochMs),
    endMs: Math.max(0, t.endMs - clipStartEpochMs),
    ...(t.status ? { status: t.status } : {}),
  }));
}

export async function nativeRecord(project: Project, opts: NativeRecordOptions = {}): Promise<NativeTimeline> {
  const store = await loadStoreProject(project);
  const paths = storePaths(project);
  await ensureDir(paths.nativeDir);
  await ensureDir(paths.stillsDir);
  const only = opts.only?.length ? new Set(opts.only) : null;
  if (only) for (const id of only) if (!store.scenes.some((s) => s.id === id)) throw new Error(`--only: unknown scene "${id}"`);
  const toRecord = store.scenes.filter((s) => !s.clip && (!only || only.has(s.id)));

  const previous = await loadNativeTimeline(project);
  const byId = new Map((previous?.scenes ?? []).map((s) => [s.id, s]));
  let device: Device | null = null;
  let deviceInfo = previous?.device;
  let restore: (() => Promise<void>) | null = null;
  const env = (scene?: StoreScene) => ({ ...(store.env ?? {}), ...(scene?.env ?? {}) });
  // Written after every recorded scene, not only at the end: a later scene that fails must not lose the clips
  // already made (a `--only` re-record of the failed scene then merges onto them).
  const writeTimeline = async (): Promise<NativeTimeline> => {
    const scenes = store.scenes.map((s) => byId.get(s.id)).filter((x): x is NativeTimeline["scenes"][number] => !!x);
    const timeline: NativeTimeline = {
      version: 1,
      platform: store.device.platform,
      device: deviceInfo ?? { id: "imported", name: "imported clips", width: 0, height: 0 },
      recordedAt: new Date().toISOString(),
      scenes,
    };
    await writeJson(paths.timeline, timeline);
    return timeline;
  };

  try {
    if (toRecord.length) {
      device = opts.device ?? (await openDevice(store.device.platform, opts.deviceId ?? store.device.id, { boot: opts.boot }));
      const size = await device.screenSize();
      deviceInfo = { id: device.id, name: device.name, ...size };
      step(`native-record on ${device.platform} ${device.name} (${size.width}x${size.height})`);
      restore = await device.prepare({
        cleanStatusBar: store.device.cleanStatusBar ?? true,
        appearance: store.device.appearance,
      });
      if (store.setup && !only) {
        log("setup flow (not recorded)");
        await runMaestroFlow({
          flow: resolveIn(project, store.setup),
          deviceId: device.id,
          env: env(),
          debugDir: paths.debugDir("_setup"),
          signal: opts.signal,
        });
      }
    }
    for (const [index, scene] of toRecord.entries()) {
      if (opts.signal?.aborted) throw new Error("canceled");
      opts.onSceneStart?.(scene.id, index, toRecord.length);
      const d = device!;
      step(`scene ${scene.id}`);
      if (scene.setup) {
        await runMaestroFlow({
          flow: resolveIn(project, scene.setup),
          deviceId: d.id,
          env: env(scene),
          debugDir: paths.debugDir(`${scene.id}-setup`),
          signal: opts.signal,
        });
      }
      const clipPath = paths.clip(scene.id);
      const tmp = clipPath.replace(/\.mp4$/, ".recording.mp4");
      const rec = await d.startRecording(tmp);
      let marks: NativeMark[];
      try {
        await sleep(250); // the first frame lands before the first step
        if (scene.flow) {
          const timings = await runMaestroFlow({
            flow: resolveIn(project, scene.flow),
            deviceId: d.id,
            env: env(scene),
            debugDir: paths.debugDir(scene.id),
            signal: opts.signal,
          });
          marks = toClipMarks(timings, rec.startedAtMs);
        } else {
          const timings: MaestroCommandTiming[] = [];
          for (const st of scene.steps ?? []) {
            const t0 = Date.now();
            await d.runStep(st);
            timings.push({ command: st.op, label: st.label, startMs: t0, endMs: Date.now(), status: "COMPLETED" });
          }
          marks = toClipMarks(timings, rec.startedAtMs);
        }
        await sleep(SETTLE_MS);
      } finally {
        await rec.stop();
      }
      await fs.rename(tmp, clipPath);
      if (scene.still) await d.screenshot(paths.still(scene.still));
      const durationMs = await probeDurationMs(clipPath);
      byId.set(scene.id, {
        id: scene.id,
        clip: clipPath,
        durationMs,
        hash: await sceneHash(project, store, scene),
        marks,
        ...(scene.still ? { still: paths.still(scene.still) } : {}),
      });
      await writeTimeline();
      ok(`${scene.id}: ${(durationMs / 1000).toFixed(1)} s, ${marks.length} marks`);
      opts.onSceneComplete?.(scene.id, index, toRecord.length);
    }
  } finally {
    if (restore) await restore();
    if (device) await device.release();
  }

  // Imported clips (scene.clip) join the timeline without a device.
  for (const scene of store.scenes.filter((s) => s.clip)) {
    const clip = resolveIn(project, scene.clip!);
    byId.set(scene.id, {
      id: scene.id,
      clip,
      durationMs: await probeDurationMs(clip),
      hash: await sceneHash(project, store, scene),
      marks: [],
    });
  }
  const missing = store.scenes.filter((s) => !byId.has(s.id)).map((s) => s.id);
  if (missing.length) log(`⚠ scenes not recorded yet: ${missing.join(", ")}`);
  const timeline = await writeTimeline();
  ok(`native timeline → ${paths.timeline}`);
  return timeline;
}

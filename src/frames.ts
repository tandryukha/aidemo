/**
 * `aidemo frames <dir>` — dump evenly spaced PNG frames from a take or the
 * final video for agent-side review (issue #44). Reviewing a render used to
 * mean hand-typed `ffmpeg -ss` per frame; this writes `output/frames/<source>-
 * <mm-ss>.png` at a fixed cadence, sized for a vision model, and prints the
 * paths.
 */

import { promises as fs } from "node:fs";
import { join, resolve, relative } from "node:path";
import { runFfmpeg, probeDurationMs } from "./ffmpeg.js";
import type { Project } from "./project.js";
import { ensureDir, exists, readJson } from "./util.js";
import { TimelineSchema } from "./types.js";

export interface FramesOptions {
  /** Seconds between frames. Default 3. */
  everySec?: number;
  /**
   * "final" (output/final-demo.mp4, default), "raw" (the latest raw file), or
   * "take" (the whole recorded take — follows the timeline across the raw
   * files a resumed take is spliced from, which `raw` cannot see).
   */
  source?: "final" | "raw" | "take";
  /** Output width in px (aspect kept). Default 640 — legible, cheap to look at. */
  width?: number;
  /** Output directory. Default <demo>/output/frames. */
  outDir?: string;
}

export interface FramesResult {
  source: string;
  durationMs: number;
  everySec: number;
  files: string[];
}

/** `mm-ss` (plus tenths when the cadence isn't whole seconds) — unique + sortable. */
function stamp(sec: number, whole: boolean): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = whole
    ? String(Math.round(s)).padStart(2, "0")
    : s.toFixed(1).padStart(4, "0");
  return `${String(m).padStart(2, "0")}-${ss}`;
}

export async function extractFrames(
  project: Project,
  opts: FramesOptions = {}
): Promise<FramesResult> {
  const everySec = Math.max(0.2, opts.everySec ?? 3);
  const width = Math.max(64, Math.round(opts.width ?? 640));
  const kind = opts.source ?? "final";
  if (kind === "take") return takeFrames(project, everySec, width, opts.outDir);
  const source = kind === "raw" ? await project.resolveRawVideo() : project.outputPath;
  if (!(await exists(source))) {
    throw new Error(
      kind === "raw"
        ? `no take at ${source} — run 'aidemo record <dir>' (or probe) first`
        : `no video at ${source} — run 'aidemo render <dir>' (or compose) first`
    );
  }
  const outDir = opts.outDir ?? project.p("output", "frames");
  await ensureDir(outDir);
  // Clear this source's previous dump so stale frames don't mix in.
  for (const f of await fs.readdir(outDir).catch(() => [] as string[])) {
    if (f.startsWith(`${kind}-`) && f.endsWith(".png")) {
      await fs.rm(join(outDir, f), { force: true });
    }
  }
  const durationMs = await probeDurationMs(source);
  const pattern = join(outDir, `${kind}-%04d.png`);
  await runFfmpeg([
    "-i",
    source,
    "-vf",
    `fps=1/${everySec},scale=${width}:-2`,
    "-vsync",
    "vfr",
    pattern,
  ]);
  // ffmpeg numbers frames 0001…; rename to the timestamp each one represents.
  const produced = (await fs.readdir(outDir))
    .filter((f) => new RegExp(`^${kind}-\\d{4}\\.png$`).test(f))
    .sort();
  const files: string[] = [];
  const whole = Number.isInteger(everySec);
  for (const [i, f] of produced.entries()) {
    const at = i * everySec;
    const name = `${kind}-${stamp(at, whole)}.png`;
    await fs.rename(join(outDir, f), join(outDir, name));
    files.push(join(outDir, name));
  }
  return { source, durationMs, everySec, files };
}

/**
 * `--source take`: sample the RECORDED take end to end. A resumed take
 * (`record --from-scene`) is spliced from more than one raw file, so `raw`
 * shows only the newest tail; this walks the timeline scene by scene, seeking
 * into whichever file each scene names, and stamps the frames with the scene
 * they came from.
 */
async function takeFrames(
  project: Project,
  everySec: number,
  width: number,
  outDirOpt?: string
): Promise<FramesResult> {
  const timeline = TimelineSchema.parse(await readJson(project.timelinePath));
  const rawVideo = await project.resolveRawVideo();
  const outDir = outDirOpt ?? project.p("output", "frames");
  await ensureDir(outDir);
  for (const f of await fs.readdir(outDir).catch(() => [] as string[])) {
    if (f.startsWith("take-") && f.endsWith(".png")) await fs.rm(join(outDir, f), { force: true });
  }
  const files: string[] = [];
  const whole = Number.isInteger(everySec);
  const sources = new Set<string>();
  let elapsedMs = 0; // content time across the whole take
  let carryMs = 0; // ms owed to the next scene so the cadence never resets
  for (const scene of timeline.scenes) {
    const file = scene.source ? resolve(project.dir, scene.source) : rawVideo;
    if (!(await exists(file))) {
      throw new Error(`take frames: scene "${scene.id}" points at ${file}, which is gone`);
    }
    sources.add(file);
    const leadInMs = scene.leadInMs ?? timeline.leadInMs;
    const sceneMs = Math.max(0, scene.endMs - scene.startMs);
    for (let at = carryMs; at < sceneMs; at += everySec * 1000) {
      const seek = (scene.startMs + leadInMs + at) / 1000;
      const name = `take-${stamp((elapsedMs + at) / 1000, whole)}-${scene.id}.png`;
      await runFfmpeg([
        "-ss",
        seek.toFixed(3),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        `scale=${width}:-2`,
        join(outDir, name),
      ]);
      files.push(join(outDir, name));
    }
    // Where the next sample falls inside the following scene.
    const stepMs = everySec * 1000;
    const shot = Math.max(0, Math.ceil((sceneMs - carryMs) / stepMs));
    carryMs = Math.max(0, carryMs + shot * stepMs - sceneMs);
    elapsedMs += sceneMs;
  }
  return {
    source: [...sources].map((f) => relative(project.dir, f)).join(", "),
    durationMs: elapsedMs,
    everySec,
    files,
  };
}

/**
 * `aidemo frames <dir>` — dump evenly spaced PNG frames from a take or the
 * final video for agent-side review (issue #44). Reviewing a render used to
 * mean hand-typed `ffmpeg -ss` per frame; this writes `output/frames/<source>-
 * <mm-ss>.png` at a fixed cadence, sized for a vision model, and prints the
 * paths.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runFfmpeg, probeDurationMs } from "./ffmpeg.js";
import type { Project } from "./project.js";
import { ensureDir, exists } from "./util.js";

export interface FramesOptions {
  /** Seconds between frames. Default 3. */
  everySec?: number;
  /** "final" (output/final-demo.mp4, default) or "raw" (the latest take). */
  source?: "final" | "raw";
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

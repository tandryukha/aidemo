import { resolve, isAbsolute } from "node:path";
import { Project } from "./project.js";
import { TimelineSchema, type Storyboard } from "./types.js";
import { runFfmpeg, probeDurationMs, probeVideoDims } from "./ffmpeg.js";
import { ensureDir, exists, readJson, log, ok, step } from "./util.js";

export interface StillsOptions {
  /** Output directory. Default <dir>/output/stills. */
  outDir?: string;
}

/** A still marker with its scene id, in timeline order. */
interface StillMarker {
  sceneId: string;
  name: string;
  tMs: number;
}

/** True if any scene declares a `still` action (drives auto-extract in render). */
export function storyboardHasStills(storyboard: Storyboard): boolean {
  return storyboard.scenes.some((s) => s.actions.some((a) => a.op === "still"));
}

/** Reject names that aren't safe, single-segment file stems. */
function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(
      `still name ${JSON.stringify(name)} is not a valid file slug — use only ` +
        `letters, digits, dot, dash, underscore (it becomes <name>.png).`
    );
  }
}

/**
 * Screenshot mode: extract each named `still` marker recorded in timeline.json
 * as a PNG, pulled from the CLEAN take (the raw recording — no captions, zoom,
 * or title cards burned in). Timeline time → take-video time is `tMs +
 * leadInMs`, the same mapping compose uses to align focus/scene offsets. Needs
 * only the recording + timeline (no API key, no storyboard) so it runs
 * standalone against any existing take, exactly like re-composing. Duplicate
 * still names are a hard error. Returns the written PNG paths.
 */
export async function extractStills(
  project: Project,
  opts: StillsOptions = {}
): Promise<string[]> {
  if (!(await exists(project.timelinePath))) {
    throw new Error(
      `No timeline at ${project.timelinePath} — run \`aidemo record ${project.dir}\` first.`
    );
  }
  const timeline = TimelineSchema.parse(await readJson(project.timelinePath));

  // Collect markers in timeline order; reject duplicate names up-front so the
  // extraction never silently overwrites one still with another.
  const markers: StillMarker[] = [];
  const seen = new Map<string, string>(); // name -> the scene that declared it
  for (const scene of timeline.scenes) {
    for (const ev of scene.stillEvents ?? []) {
      assertSafeName(ev.name);
      if (seen.has(ev.name)) {
        throw new Error(
          `duplicate still name ${JSON.stringify(ev.name)} (scenes ` +
            `${seen.get(ev.name)} and ${scene.id}) — still names must be unique.`
        );
      }
      seen.set(ev.name, scene.id);
      markers.push({ sceneId: scene.id, name: ev.name, tMs: ev.tMs });
    }
  }

  if (markers.length === 0) {
    log("no still markers in timeline.json — nothing to extract");
    return [];
  }

  const rawVideo = await project.resolveRawVideo();
  if (!(await exists(rawVideo))) {
    throw new Error(
      `No raw recording at ${rawVideo} — run \`aidemo record ${project.dir}\` first.`
    );
  }
  const { width, height } = await probeVideoDims(rawVideo);
  const videoMs = await probeDurationMs(rawVideo);

  const outDir = opts.outDir
    ? isAbsolute(opts.outDir)
      ? opts.outDir
      : resolve(process.cwd(), opts.outDir)
    : project.stillsDir;
  await ensureDir(outDir);

  step(`Extracting ${markers.length} still(s) (${width}x${height}, clean take)`);
  const written: string[] = [];
  for (const m of markers) {
    // The same timeline→video mapping compose uses (rawT = tMs + leadInMs).
    // Clamp just inside the recording so a marker at the very tail still yields
    // a decodable frame rather than an ffmpeg seek past EOF.
    const rawMs = m.tMs + timeline.leadInMs;
    const seekMs = Math.max(0, Math.min(rawMs, Math.max(0, videoMs - 60)));
    const out = resolve(outDir, `${m.name}.png`);
    // -ss before -i is a fast, accurate seek (accurate_seek is on by default);
    // -frames:v 1 grabs exactly one frame. No overlay/drawtext filters, so this
    // stays portable across ffmpeg builds.
    await runFfmpeg([
      "-ss",
      (seekMs / 1000).toFixed(3),
      "-i",
      rawVideo,
      "-frames:v",
      "1",
      out,
    ]);
    written.push(out);
    log(
      `still "${m.name}" (scene ${m.sceneId}) @ ${Math.round(seekMs)}ms → ${out}`
    );
  }
  ok(`stills → ${outDir} (${written.length} PNG${written.length === 1 ? "" : "s"})`);
  return written;
}

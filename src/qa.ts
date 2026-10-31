/**
 * `aidemo qa <dir>` — post-render checks on the FINISHED MP4 (issue #52).
 *
 * `lint` predicts problems before the take and `output/report.json` records
 * what compose did, but neither sees the file a viewer opens: a white opening
 * frame, a blank poster, a master that is too quiet, captions that flash by,
 * an address pill naming the wrong host. Those were caught locally with a
 * ~150-line ffmpeg + python script; this is that script, in the engine, so
 * every agent-driven render is self-checking.
 *
 * Pure measurement over existing artifacts: ffmpeg/ffprobe only, no browser,
 * no network, nothing written.
 */

import { spawn } from "node:child_process";
import { relative } from "node:path";
import { stat } from "node:fs/promises";
import type { Project } from "./project.js";
import {
  probeDurationMs,
  probeFlatLeadMs,
  probeVideoDims,
} from "./ffmpeg.js";
import { ComposeReportSchema, type Storyboard } from "./types.js";
import { exists, log, ok, readJson } from "./util.js";

export type QaStatus = "pass" | "warn" | "note";

export interface QaCheck {
  /** Stable id: length | blank-open | poster | loudness | bed | hold | captions | hygiene. */
  id: string;
  status: QaStatus;
  message: string;
}

export interface QaResult {
  video: string;
  durationMs: number;
  checks: QaCheck[];
  warnings: number;
  notes: number;
}

/** Integrated loudness / true peak / the momentary p10 (the bed under speech). */
interface LoudnessStats {
  integrated: number;
  truePeak: number;
  /** 10th percentile of the momentary loudness — what plays in the gaps. */
  momentaryP10: number;
}

function ebur128(file: string): Promise<LoudnessStats | null> {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let err = "";
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", () => resolvePromise(null));
    proc.on("close", () => {
      const moments: number[] = [];
      for (const m of err.matchAll(/M:\s*(-?[\d.]+|-inf)/g)) {
        const v = m[1] === "-inf" ? -70 : parseFloat(m[1]);
        if (Number.isFinite(v) && v > -70) moments.push(v);
      }
      const summary = err.slice(err.lastIndexOf("Integrated loudness"));
      const I = /I:\s*(-?[\d.]+)\s*LUFS/.exec(summary);
      const TP = /Peak:\s*(-?[\d.]+)\s*dBFS/.exec(summary);
      if (!I) return resolvePromise(null);
      moments.sort((a, b) => a - b);
      resolvePromise({
        integrated: parseFloat(I[1]),
        truePeak: TP ? parseFloat(TP[1]) : 0,
        momentaryP10: moments.length ? moments[Math.floor(moments.length * 0.1)] : -70,
      });
    });
  });
}

/** Mean luma of a still image (a blank poster is ~white or ~black). */
function imageYavg(file: string): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        file,
        "-vf",
        "signalstats,metadata=print:file=-",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", () => resolvePromise(null));
    proc.on("close", () => {
      const m = /YAVG=\s*([\d.]+)/.exec(out);
      resolvePromise(m ? parseFloat(m[1]) : null);
    });
  });
}

/**
 * `blankOpenMs` from the compose report that belongs to `video` (written at or
 * after it), or null when there is no such report.
 */
async function reportedBlankOpenMs(project: Project, video: string): Promise<number | null> {
  if (!(await exists(project.reportPath))) return null;
  try {
    const [rs, vs] = await Promise.all([stat(project.reportPath), stat(video)]);
    if (rs.mtimeMs < vs.mtimeMs) return null;
    const report = ComposeReportSchema.safeParse(await readJson(project.reportPath));
    return report.success && typeof report.data.blankOpenMs === "number"
      ? report.data.blankOpenMs
      : null;
  } catch {
    return null;
  }
}

/** Host of a URL-ish string, or null. */
function hostOf(url: string): string | null {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host;
  } catch {
    return null;
  }
}

export async function runQa(project: Project, storyboard: Storyboard): Promise<QaResult> {
  const video = project.outputPath;
  if (!(await exists(video))) {
    throw new Error(`no video at ${video} — run 'aidemo render <dir>' (or compose) first`);
  }
  const checks: QaCheck[] = [];
  const add = (id: string, status: QaStatus, message: string): void => {
    checks.push({ id, status, message });
  };
  const durationMs = await probeDurationMs(video);

  // 1. Length against the storyboard's own target.
  const target = storyboard.targetLengthSeconds;
  const secs = Math.round(durationMs / 1000);
  if (target == null) {
    add("length", "note", `${secs}s (no targetLengthSeconds declared)`);
  } else if (Math.abs(secs - target) > Math.max(10, target * 0.2)) {
    add("length", "warn", `${secs}s vs targetLengthSeconds ${target}`);
  } else {
    add("length", "pass", `${secs}s (target ${target}s)`);
  }

  // 2. The opening frames: a demo that starts on the browser's white pre-paint.
  // Prefer compose's own measurement (report.json `blankOpenMs`): it is taken
  // on the page footage before captions are burned in, and the finished MP4
  // can't tell a caption pill over a blank page from sparse real content
  // (issue #78). Fall back to probing the MP4 when there's no report for it.
  const introMs = storyboard.intro?.durationMs ?? 0;
  let blankMs = await reportedBlankOpenMs(project, video);
  if (blankMs == null) {
    const dims = await probeVideoDims(video).catch(() => null);
    const pxScale = dims ? dims.width / storyboard.video.width : 1;
    blankMs = await probeFlatLeadMs(video, 4000, introMs, pxScale).catch(() => 0);
  }
  if (blankMs > 250) {
    add(
      "blank-open",
      "warn",
      `opens on ${(blankMs / 1000).toFixed(2)}s of blank page — set output.trimLeadingBlank`
    );
  } else {
    add("blank-open", "pass", `content from ${(blankMs / 1000).toFixed(2)}s`);
  }

  // 3. Poster: a white rectangle is worse than no poster at all.
  if (await exists(project.posterPath)) {
    const yavg = await imageYavg(project.posterPath);
    if (yavg != null && (yavg > 180 || yavg < 25)) {
      add(
        "poster",
        "warn",
        `${relative(project.dir, project.posterPath)} looks blank (YAVG=${yavg.toFixed(1)}) — ` +
          `set output.poster to an explicit ms`
      );
    } else {
      add("poster", "pass", `${relative(project.dir, project.posterPath)} has content`);
    }
  }

  // 4. Master loudness, and the music bed's level in the gaps.
  const loud = await ebur128(video);
  if (loud) {
    // The loudness pass only runs with music, or when `output.loudness` is an
    // explicit object — a narration-only render is deliberately untouched, so
    // measuring it against -16 LUFS would warn on every such demo.
    const normalized =
      storyboard.output?.loudness !== false &&
      (storyboard.music != null || typeof storyboard.output?.loudness === "object");
    const wantI = normalized ? -16 : null;
    if (wantI != null && Math.abs(loud.integrated - wantI) > 2) {
      add(
        "loudness",
        "warn",
        `I=${loud.integrated.toFixed(1)} LUFS (target ${wantI}), TP=${loud.truePeak.toFixed(1)} dBTP`
      );
    } else {
      add(
        "loudness",
        wantI == null ? "note" : "pass",
        `I=${loud.integrated.toFixed(1)} LUFS, TP=${loud.truePeak.toFixed(1)} dBTP` +
          (wantI == null ? " (no loudness pass — narration only)" : "")
      );
    }
    if (storyboard.music) {
      const bed = loud.momentaryP10;
      if (bed > -18) {
        add("bed", "warn", `music bed ≈ ${bed.toFixed(1)} LUFS in the gaps — it will fight the voice`);
      } else if (bed < -40) {
        add("bed", "note", `music bed ≈ ${bed.toFixed(1)} LUFS — effectively inaudible`);
      } else {
        add("bed", "pass", `music bed ≈ ${bed.toFixed(1)} LUFS (p10 of the master)`);
      }
    }
  }

  // 5. Hold shares + whatever compose already warned about.
  if (await exists(project.reportPath)) {
    const report = ComposeReportSchema.safeParse(await readJson(project.reportPath));
    if (report.success) {
      for (const s of report.data.scenes) {
        if (s.holdPct > 0.25) {
          add("hold", "warn", `${s.id} held ${Math.round(s.holdPct * 100)}%`);
        }
      }
      for (const w of report.data.warnings) {
        add("hold", "warn", `engine: ${w.code} — ${w.message}`);
      }
      if (!report.data.warnings.length) add("hold", "pass", "no compose warnings");
    }
  }

  // 6. Caption readability (the cue stats the captions step logs).
  if (await exists(project.captionsCuesPath)) {
    const cues = (await readJson(project.captionsCuesPath)) as Array<{
      startMs: number;
      endMs: number;
      text: string;
    }>;
    const short = cues.filter((c) => c.endMs - c.startMs < 1000).length;
    let midClause = 0;
    cues.forEach((c, i) => {
      const next = cues[i + 1];
      if (!next) return;
      if (!/[.!?,;:—–]["'”’)]?$/.test(c.text.trim()) && /^\p{Ll}/u.test(next.text.trim())) {
        midClause++;
      }
    });
    const pct = Math.round((midClause / Math.max(1, cues.length - 1)) * 100);
    if (short > 2 || pct > 25) {
      add("captions", "warn", `${cues.length} cues: ${short} under 1s, ${pct}% mid-clause breaks`);
    } else {
      add("captions", "pass", `${cues.length} cues, ${pct}% mid-clause breaks`);
    }
  }

  // 7. Hygiene the eye catches and the schema can't: an address pill that
  //    names one host while the demo visits several, ASCII-only chapter
  //    titles in a non-English demo.
  const frameUrl = storyboard.frame?.url;
  if (frameUrl && frameUrl !== "auto") {
    const hosts = new Set<string>();
    for (const scene of storyboard.scenes) {
      for (const a of scene.actions) {
        if (a.op === "goto") {
          const h = hostOf(a.url);
          if (h) hosts.add(h);
        }
      }
    }
    const pill = hostOf(frameUrl);
    if (hosts.size > 1 || (pill && hosts.size === 1 && !hosts.has(pill))) {
      add(
        "hygiene",
        "warn",
        `frame.url is the fixed "${frameUrl}" but the demo visits ${[...hosts].join(", ")} — ` +
          `set frame.url: "auto" to track the page`
      );
    }
  }
  const lang = (storyboard.language ?? project.lang ?? "en").toLowerCase().split(/[-_]/)[0];
  if (lang !== "en" && storyboard.output?.chapters) {
    const ascii = storyboard.scenes.filter(
      (s) => (s.title ?? s.id) && !/[^\x20-\x7e]/.test(s.title ?? s.id)
    ).length;
    if (ascii === storyboard.scenes.length) {
      add(
        "hygiene",
        "note",
        `every chapter title is ASCII in a "${lang}" demo — they are probably scene ids, not titles`
      );
    }
  }

  const warnings = checks.filter((c) => c.status === "warn").length;
  const notes = checks.filter((c) => c.status === "note").length;
  return { video, durationMs, checks, warnings, notes };
}

/** Print a QA result the way the rest of the CLI prints stages. */
export function logQa(res: QaResult): void {
  for (const c of res.checks) {
    const glyph = c.status === "pass" ? "✓" : c.status === "warn" ? "W" : "·";
    log(`  ${glyph} ${c.id.padEnd(11)}${c.message}`);
  }
  const line = `${res.warnings} warning(s), ${res.notes} note(s)`;
  if (res.warnings) log(`── ${line}`);
  else ok(line);
}

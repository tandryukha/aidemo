import { spawn } from "node:child_process";

/** Run ffmpeg with the given args; rejects with stderr tail on failure. */
export function runFfmpeg(args: string[]): Promise<void> {
  return run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${bin} exited ${code}\n${stderr.split("\n").slice(-25).join("\n")}`
          )
        );
    });
  });
}

/** Probe a video file's frame dimensions. */
export function probeVideoDims(
  file: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-select_streams",
      "v:0",
      "-show_streams",
      file,
    ]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      try {
        const s = JSON.parse(out).streams?.[0];
        if (!s?.width || !s?.height)
          return reject(new Error(`No video stream in ${file}`));
        resolve({ width: s.width, height: s.height });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Probe a media file's duration in milliseconds. */
export function probeDurationMs(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      file,
    ]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      try {
        const json = JSON.parse(out);
        const sec = parseFloat(json.format?.duration ?? "0");
        resolve(Math.round(sec * 1000));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Thresholds for "this frame shows nothing" — a blank pre-paint, a solid
 * splash — as opposed to a page whose content is merely sparse (issue #78: a
 * dark terminal with one prompt line). A frame is blank only when BOTH hold:
 *
 * 1. `FLAT_SPREAD` — `YHIGH - YLOW` from `signalstats` (luma 90th minus 10th
 *    percentile) is at most 4: one colour covers ≥ 80% of the frame.
 *    Percentiles, not min/max, so a cursor arrow or a stray antialiased pixel
 *    doesn't read as content; `YDEV` would be the natural measure but many
 *    ffmpeg builds don't emit it. On its own this is NOT a blank test: sparse
 *    text never reaches the 10%/90% tails, so a terminal prompt (or a login
 *    box on a big solid background) measured exactly like a white page.
 * 2. `BLANK_EDGE_PX` — `edgedetect` (Canny, binary 0/255 output) +
 *    `signalstats` YAVG gives the fraction of edge pixels; times the frame
 *    area and divided by the device-pixel scale, that is the length of
 *    visible outlines in CSS px. Glyphs are all outline, so this counts text
 *    the percentiles miss. Measured (Chrome screenshots → x264 crf 20, at
 *    1280x720@1x, 1920x1080@1x, 1280x720@2x): the engine's 24 px cursor over
 *    white/grey/black ≈ 54–142; a blank page 0; `user@box:~$ ▌` 14 px on
 *    black ≈ 288–522; `root@ttyd:~# ▌` 16 px ≈ 447–630; a heading + one
 *    sentence ≈ 1210–1560. 200 sits between the cursor and a one-line prompt
 *    with ~1.4x margin each side. Below it — a lone `$ ▌` (≈ 75–150), a bare
 *    32 px spinner (≈ 115–135) — still counts as blank, which for an opening
 *    frame is what a viewer sees too.
 *
 * Both filters are core libavfilter (no external libs), like the
 * `freezedetect`/`signalstats` probes already used here.
 */
const FLAT_SPREAD = 4;
const BLANK_EDGE_PX = 200;
const EDGE_FILTER = "edgedetect=low=0.1:high=0.3";

/** Per-frame stats from one `signalstats,metadata=print` pass, in frame order. */
function signalstatsFrames(
  file: string,
  vf: string,
  ss: number,
  durSec: number | null
): Promise<Array<Record<string, number>> | null> {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        ...(ss > 0 ? ["-ss", ss.toFixed(3)] : []),
        "-i",
        file,
        ...(durSec != null ? ["-t", durSec.toFixed(3)] : []),
        "-vf",
        `${vf}signalstats,metadata=print:file=-`,
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", () => resolvePromise(null));
    proc.on("close", (code) => {
      if (code !== 0) return resolvePromise(null);
      // The metadata muxer emits a header line per frame followed by one line
      // per key:
      //   frame:12  pts:...  pts_time:0.4
      //   lavfi.signalstats.YLOW=16
      //   ...
      const frames: Array<Record<string, number>> = [];
      let cur: Record<string, number> | null = null;
      for (const line of out.split("\n")) {
        const ts = /pts_time:\s*(-?[\d.]+)/.exec(line);
        if (ts) {
          cur = { t: parseFloat(ts[1]) };
          frames.push(cur);
          continue;
        }
        const kv = /lavfi\.signalstats\.(\w+)=\s*(-?[\d.e+-]+)/.exec(line);
        if (kv && cur) cur[kv[1]] = parseFloat(kv[2]);
      }
      resolvePromise(frames);
    });
  });
}

/** Luma flatness per frame of a window; `t` is absolute seconds in `file`. */
async function flatFrames(
  file: string,
  ss: number,
  durSec: number | null
): Promise<Array<{ t: number; flat: boolean }> | null> {
  const frames = await signalstatsFrames(file, "", ss, durSec);
  if (!frames) return null;
  const out: Array<{ t: number; flat: boolean }> = [];
  for (const f of frames) {
    if (f.YLOW == null || f.YHIGH == null) return null;
    out.push({ t: ss + f.t, flat: f.YHIGH - f.YLOW <= FLAT_SPREAD });
  }
  return out;
}

/**
 * Which frames of a contiguous run of flat frames (absolute times, in order)
 * are also free of outlines — i.e. truly blank. The edge pass is the costly
 * one (Canny on every full-size frame), so it runs only over this run, never
 * over a window whose frames already differ. A frame the second pass can't be
 * matched to counts as content: a probe hiccup must never cause a trim.
 */
async function blankInRun(
  file: string,
  run: Array<{ t: number }>,
  pxScale: number
): Promise<boolean[] | null> {
  const step =
    run.length > 1 ? (run[run.length - 1].t - run[0].t) / (run.length - 1) : 1 / 30;
  const half = Math.max(step / 2, 0.001);
  // Seek half a frame early: `-ss` is rounded to ms, and an accurate seek
  // drops a frame whose pts lands a hair before it.
  const ss = Math.max(0, run[0].t - half);
  const [dims, edges] = await Promise.all([
    probeVideoDims(file).catch(() => null),
    signalstatsFrames(file, `${EDGE_FILTER},`, ss, run[run.length - 1].t - ss + step),
  ]);
  if (!dims || !edges) return null;
  const area = dims.width * dims.height;
  const scale = pxScale > 0 ? pxScale : 1;
  const samples = edges
    .filter((e) => e.YAVG != null)
    .map((e) => ({ t: ss + e.t, px: ((e.YAVG / 255) * area) / scale }));
  let j = 0;
  return run.map((f) => {
    while (
      j + 1 < samples.length &&
      Math.abs(samples[j + 1].t - f.t) <= Math.abs(samples[j].t - f.t)
    ) {
      j++;
    }
    const s = samples[j];
    return !!s && Math.abs(s.t - f.t) <= half && s.px < BLANK_EDGE_PX;
  });
}

/**
 * Length (ms) of the *blank* tail of a video — the trailing run of frames
 * that show nothing (one solid colour and no text or outlines; see
 * `FLAT_SPREAD` / `BLANK_EDGE_PX`).
 *
 * Compose freeze-holds a scene's last frame when the narration outruns the
 * recorded action. When the scene ends right before a `goto`, that last frame
 * is the browser's white pre-paint, and the hold clones *white* for as long as
 * the narration runs (issue #36: 37 near-blank seconds out of 209). Trimming
 * the blank tail first makes the hold clone the last frame that actually shows
 * the app. A sparse-but-real page (a terminal prompt on a dark background) is
 * not blank, so its tail is never dropped (issue #78).
 *
 * `pxScale` is device px per CSS px (output width / `video.width`), so the
 * edge threshold means the same on a 1x and a 2x take. Scans at most
 * `windowMs` from the end; returns 0 when the tail has real content, or when
 * the probe fails for any reason (best-effort polish, never a reason to fail a
 * compose).
 */
export async function probeFlatTailMs(
  file: string,
  durMs: number,
  windowMs = 4000,
  pxScale = 1
): Promise<number> {
  const start = Math.max(0, durMs - windowMs) / 1000;
  const frames = await flatFrames(file, start, null);
  if (!frames || !frames.length || !frames[frames.length - 1].flat) return 0;
  let i = frames.length - 1;
  while (i > 0 && frames[i - 1].flat) i--;
  const run = frames.slice(i);
  // A static page (a terminal) is one long flat run: settle it on the last
  // frame alone before paying for the whole run.
  if (!(await blankInRun(file, run.slice(-1), pxScale))?.[0]) return 0;
  const blank = await blankInRun(file, run, pxScale);
  if (!blank || !blank[blank.length - 1]) return 0;
  let k = blank.length - 1;
  while (k > 0 && blank[k - 1]) k--;
  return Math.max(0, Math.round(durMs - run[k].t * 1000));
}

/**
 * Mirror of `probeFlatTailMs` for the HEAD of a file: how many ms after
 * `startMs` are blank frames (the browser's white pre-paint after a `goto`, a
 * solid splash). Used to open the video on the product instead of on a blank
 * page, and to pick a poster frame that isn't a white rectangle (issue #47). A
 * static but populated opening — a dark terminal with a prompt — is content,
 * not blank (issue #78). Best-effort: any probe failure resolves to 0.
 */
export async function probeFlatLeadMs(
  file: string,
  windowMs = 4000,
  startMs = 0,
  pxScale = 1
): Promise<number> {
  const start = startMs / 1000;
  const frames = await flatFrames(file, start, windowMs / 1000);
  if (!frames || !frames.length || !frames[0].flat) return 0;
  let i = 0;
  while (i + 1 < frames.length && frames[i + 1].flat) i++;
  const run = frames.slice(0, i + 1);
  if (!(await blankInRun(file, run.slice(0, 1), pxScale))?.[0]) return 0;
  const blank = await blankInRun(file, run, pxScale);
  if (!blank || !blank[0]) return 0;
  let k = 0;
  while (k + 1 < blank.length && blank[k + 1]) k++;
  return Math.max(0, Math.round((run[k].t - start) * 1000));
}

/** A motionless span found by `freezedetect`, in ms from the file's start. */
export interface FreezeSpan {
  startMs: number;
  endMs: number;
}

/**
 * Spans of `file` where nothing on screen moves for at least `minMs`
 * (ffmpeg `freezedetect`). Used by compose's `autoIdle` to trim dead air the
 * storyboard never annotated — a slow XHR, a fixed `pause`, a video the page
 * hasn't started yet.
 *
 * Best-effort like `probeFlatTailMs`: any probe failure resolves to `[]`, so a
 * missing filter or an odd container is a no-op, never a failed compose.
 */
export function probeFreezeSpans(
  file: string,
  minMs = 1500,
  noise = 0.003
): Promise<FreezeSpan[]> {
  const d = Math.max(0.1, minMs / 1000);
  return new Promise((resolvePromise) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        file,
        "-vf",
        `freezedetect=n=${noise}:d=${d.toFixed(3)},metadata=print:file=-`,
        "-an",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    proc.stdout.on("data", (d2) => (out += d2.toString()));
    proc.on("error", () => resolvePromise([]));
    proc.on("close", () => {
      // freezedetect emits, per detected span:
      //   lavfi.freezedetect.freeze_start=12.34
      //   lavfi.freezedetect.freeze_duration=2.5
      //   lavfi.freezedetect.freeze_end=14.84
      // A span still frozen at EOF has a start with no end.
      const spans: FreezeSpan[] = [];
      let start: number | null = null;
      for (const line of out.split("\n")) {
        const s = /freeze_start=\s*([\d.]+)/.exec(line);
        if (s) {
          start = parseFloat(s[1]);
          continue;
        }
        const e = /freeze_end=\s*([\d.]+)/.exec(line);
        if (e && start != null) {
          spans.push({ startMs: Math.round(start * 1000), endMs: Math.round(parseFloat(e[1]) * 1000) });
          start = null;
        }
      }
      if (start != null) spans.push({ startMs: Math.round(start * 1000), endMs: Number.MAX_SAFE_INTEGER });
      resolvePromise(spans.filter((s) => s.endMs > s.startMs));
    });
  });
}

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
 * Length (ms) of the *flat* tail of a video — the trailing run of frames that
 * are a single solid color.
 *
 * Compose freeze-holds a scene's last frame when the narration outruns the
 * recorded action. When the scene ends right before a `goto`, that last frame
 * is the browser's white pre-paint, and the hold clones *white* for as long as
 * the narration runs (issue #36: 37 near-blank seconds out of 209). Trimming
 * the flat tail first makes the hold clone the last frame that actually shows
 * the app.
 *
 * Flatness is `YHIGH - YLOW` from `signalstats` — the spread between the luma
 * 90th and 10th percentiles. Percentiles rather than min/max so a cursor arrow
 * or a stray antialiased pixel doesn't make a blank page look like content;
 * `YDEV` would be the natural measure but many ffmpeg builds don't emit it.
 *
 * Scans at most `windowMs` from the end; returns 0 when the tail has real
 * content, or when the probe fails for any reason (best-effort polish, never a
 * reason to fail a compose).
 */
export function probeFlatTailMs(
  file: string,
  durMs: number,
  windowMs = 4000
): Promise<number> {
  const start = Math.max(0, durMs - windowMs) / 1000;
  return new Promise((resolvePromise) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-ss",
        start.toFixed(3),
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
    proc.on("error", () => resolvePromise(0));
    proc.on("close", () => {
      // The metadata muxer emits a header line per frame followed by one line
      // per key:
      //   frame:12  pts:...  pts_time:0.4
      //   lavfi.signalstats.YLOW=16
      //   ...
      const frames: Array<{ t: number; spread: number }> = [];
      let t = NaN;
      let low = NaN;
      let high = NaN;
      const flush = (): void => {
        if (!Number.isNaN(t) && !Number.isNaN(low) && !Number.isNaN(high)) {
          frames.push({ t, spread: high - low });
        }
        low = NaN;
        high = NaN;
      };
      for (const line of out.split("\n")) {
        const ts = /pts_time:\s*([\d.]+)/.exec(line);
        if (ts) {
          flush();
          t = parseFloat(ts[1]);
          continue;
        }
        const lo = /YLOW=\s*([\d.]+)/.exec(line);
        if (lo) low = parseFloat(lo[1]);
        const hi = /YHIGH=\s*([\d.]+)/.exec(line);
        if (hi) high = parseFloat(hi[1]);
      }
      flush();
      if (frames.length === 0) return resolvePromise(0);
      // Walk back while frames stay flat. A real page — even a mostly-empty
      // one — has chrome, text and edges, so its spread is far above this.
      const FLAT_SPREAD = 4;
      let i = frames.length - 1;
      if (frames[i].spread > FLAT_SPREAD) return resolvePromise(0);
      while (i > 0 && frames[i - 1].spread <= FLAT_SPREAD) i--;
      resolvePromise(Math.max(0, Math.round(durMs - (start + frames[i].t) * 1000)));
    });
  });
}

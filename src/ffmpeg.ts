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

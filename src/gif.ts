import { promises as fs } from "node:fs";
import { resolve, isAbsolute, dirname } from "node:path";
import { Project } from "./project.js";
import { runFfmpeg } from "./ffmpeg.js";
import { ensureDir, exists, ok, step } from "./util.js";

export interface GifOptions {
  /** Output width in px (height keeps aspect). Default 960. */
  width?: number;
  /** GIF frame rate. Default 12. */
  fps?: number;
  /** Output path. Default <dir>/output/final-demo.gif. */
  out?: string;
}

/**
 * Convert the composed MP4 into a README-ready GIF (GIFs autoplay on GitHub;
 * MP4s don't). Classic high-quality two-pass: palettegen → paletteuse, with
 * ordered bayer dithering — flat UI colors stay clean instead of getting the
 * error-diffusion "crawl". Both filters are baseline ffmpeg.
 */
export async function exportGif(
  project: Project,
  opts: GifOptions = {}
): Promise<string> {
  const input = project.outputPath;
  if (!(await exists(input))) {
    throw new Error(
      `No final video at ${input} — run \`aidemo compose ${project.dir}\` first.`
    );
  }
  const width = opts.width ?? 960;
  const fps = opts.fps ?? 12;
  const out = opts.out
    ? isAbsolute(opts.out)
      ? opts.out
      : resolve(process.cwd(), opts.out)
    : project.gifPath;
  await ensureDir(dirname(out));

  step(`Exporting GIF (${width}px @ ${fps}fps, two-pass palette)`);
  const tmp = project.gifTmpDir;
  await fs.rm(tmp, { recursive: true, force: true });
  await ensureDir(tmp);
  const palette = resolve(tmp, "palette.png");
  const frames = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  await runFfmpeg(["-i", input, "-vf", `${frames},palettegen`, palette]);
  await runFfmpeg([
    "-i",
    input,
    "-i",
    palette,
    "-filter_complex",
    `${frames}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
    out,
  ]);
  // AIDEMO_KEEP_TMP=1 keeps .gif-tmp (palette) for debugging, like compose.
  if (!process.env.AIDEMO_KEEP_TMP) {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  const { size } = await fs.stat(out);
  ok(`gif → ${out} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return out;
}

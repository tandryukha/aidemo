/**
 * Multi-artifact export from one take: a keyboard-navigable HTML walkthrough
 * (one card per scene: payoff frame + narration + timestamp), a Markdown
 * guide (README/SOP-ready), the SRT/VTT captions, and a JSON manifest — all
 * derived from the FINAL video and compose's report.json, so the frames show
 * exactly what the video shows (zoom, cursor, overlays, frame). No re-take,
 * no re-encode: one `ffmpeg -ss` per scene.
 */

import { promises as fs } from "node:fs";
import { resolve, isAbsolute, basename } from "node:path";
import { Project } from "./project.js";
import { ComposeReportSchema, type Storyboard } from "./types.js";
import { runFfmpeg } from "./ffmpeg.js";
import { ensureDir, exists, readJson, writeJson, log, step } from "./util.js";

export interface WalkthroughOptions {
  /** Output directory. Default <dir>/output/walkthrough (walkthrough.<lang> for variants). */
  outDir?: string;
  /** Frame width in px (aspect kept). Default 960. */
  width?: number;
}

export interface WalkthroughScene {
  index: number;
  id: string;
  title: string;
  narration: string;
  /** Content time in the final video, ms. */
  startMs: number;
  endMs: number;
  /** Frame file (relative to the walkthrough dir). */
  image: string;
}

export interface WalkthroughResult {
  dir: string;
  index: string;
  guide: string;
  manifest: string;
  scenes: WalkthroughScene[];
  captions: { srt?: string; vtt?: string };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const mmss = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export async function exportWalkthrough(
  project: Project,
  storyboard: Storyboard,
  opts: WalkthroughOptions = {}
): Promise<WalkthroughResult> {
  const video = project.outputPath;
  if (!(await exists(video))) {
    throw new Error(`no video at ${video} — run 'aidemo render ${project.dir}' (or compose) first`);
  }
  if (!(await exists(project.reportPath))) {
    throw new Error(`no report at ${project.reportPath} — re-run 'aidemo compose ${project.dir}'`);
  }
  const report = ComposeReportSchema.parse(await readJson(project.reportPath));
  const width = Math.max(240, Math.round(opts.width ?? 960));
  const dir = opts.outDir
    ? isAbsolute(opts.outDir)
      ? opts.outDir
      : resolve(process.cwd(), opts.outDir)
    : project.p("output", project.lang ? `walkthrough.${project.lang}` : "walkthrough");
  await ensureDir(dir);
  step(`Exporting walkthrough (${report.scenes.length} scene(s), ${width}px frames)`);

  const byId = new Map(storyboard.scenes.map((s) => [s.id, s]));
  const introMs = storyboard.intro?.durationMs ?? 0;
  const scenes: WalkthroughScene[] = [];
  let t = introMs;
  for (let i = 0; i < report.scenes.length; i++) {
    const r = report.scenes[i];
    const sb = byId.get(r.id);
    const startMs = t;
    const endMs = t + r.targetMs;
    t = endMs;
    // Payoff frame: near the end of the scene (actions done, overlays and
    // holds visible), never the first frames (which still show the previous
    // screen while a navigation lands).
    const seekMs = Math.max(startMs, endMs - Math.min(600, Math.max(100, r.targetMs * 0.25)));
    const image = `scene-${String(i + 1).padStart(2, "0")}-${r.id.replace(/[^\w.-]+/g, "_")}.png`;
    await runFfmpeg([
      "-ss",
      (seekMs / 1000).toFixed(3),
      "-i",
      video,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:-2`,
      "-update",
      "1",
      resolve(dir, image),
    ]);
    scenes.push({
      index: i + 1,
      id: r.id,
      title: sb?.title ?? r.id,
      narration: sb?.narration ?? "",
      startMs,
      endMs,
      image,
    });
    log(`scene ${r.id}: ${mmss(startMs)} → ${image}`);
  }

  // Captions travel with the walkthrough (players and LMSs want the files).
  const captions: { srt?: string; vtt?: string } = {};
  for (const [key, src] of [
    ["srt", project.captionsSrtPath],
    ["vtt", project.captionsVttPath],
  ] as const) {
    if (await exists(src)) {
      const dst = resolve(dir, basename(src));
      await fs.copyFile(src, dst);
      captions[key] = dst;
    }
  }

  const videoRel = `../${basename(video)}`;
  const title = storyboard.title;
  const guide = resolve(dir, "guide.md");
  await fs.writeFile(
    guide,
    [
      `# ${title}`,
      "",
      `Video: [${basename(video)}](${videoRel}) · ${mmss(report.durationMs)}`,
      "",
      ...scenes.flatMap((s) => [
        `## ${s.index}. ${s.title}`,
        "",
        `![${s.title}](${s.image})`,
        "",
        s.narration,
        "",
        `_${mmss(s.startMs)}–${mmss(s.endMs)}_`,
        "",
      ]),
    ].join("\n")
  );

  const index = resolve(dir, "index.html");
  await fs.writeFile(index, renderHtml(title, videoRel, scenes, report.durationMs));
  const manifest = resolve(dir, "walkthrough.json");
  await writeJson(manifest, {
    title,
    video: videoRel,
    durationMs: report.durationMs,
    scenes,
    captions: Object.fromEntries(Object.entries(captions).map(([k, v]) => [k, basename(v)])),
  });
  log(`walkthrough → ${index}`);
  return { dir, index, guide, manifest, scenes, captions };
}

function renderHtml(
  title: string,
  videoRel: string,
  scenes: WalkthroughScene[],
  durationMs: number
): string {
  const cards = scenes
    .map(
      (s) => `
    <section class="scene" id="s${s.index}" data-start="${(s.startMs / 1000).toFixed(2)}">
      <img src="${esc(s.image)}" alt="${esc(s.title)}" loading="lazy">
      <div class="meta">
        <div class="step">${s.index} / ${scenes.length}</div>
        <h2>${esc(s.title)}</h2>
        <p>${esc(s.narration)}</p>
        <button class="jump" type="button">▶ ${mmss(s.startMs)}</button>
      </div>
    </section>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — walkthrough</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --muted: #666; --bg: #fff; --card: #f6f7f9; --accent: #3b82f6; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eef; --muted: #aab; --bg: #0e1118; --card: #171b26; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  header { padding: 24px 24px 8px; max-width: 1100px; margin: 0 auto; }
  header h1 { margin: 0 0 4px; font-size: 24px; }
  header .hint { color: var(--muted); font-size: 13px; }
  video { display: block; width: 100%; max-width: 1100px; margin: 12px auto 24px; border-radius: 10px; background: #000; }
  main { max-width: 1100px; margin: 0 auto; padding: 0 24px 48px; display: grid; gap: 20px; }
  .scene { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 20px; background: var(--card); border-radius: 12px; padding: 14px; scroll-margin-top: 16px; outline: 2px solid transparent; }
  .scene.active { outline-color: var(--accent); }
  .scene img { width: 100%; height: auto; border-radius: 8px; display: block; }
  .meta { display: flex; flex-direction: column; gap: 6px; }
  .step { color: var(--muted); font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
  h2 { margin: 0; font-size: 18px; }
  p { margin: 0; }
  .jump { align-self: flex-start; margin-top: auto; border: 1px solid var(--accent); color: var(--accent); background: transparent; border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; font-size: 13px; }
  @media (max-width: 720px) { .scene { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <div class="hint">${scenes.length} steps · ${mmss(durationMs)} · ← → to move between steps, Enter to play from a step</div>
</header>
<video id="v" src="${esc(videoRel)}" controls preload="metadata"></video>
<main>${cards}
</main>
<script>
(() => {
  const v = document.getElementById("v");
  const scenes = Array.from(document.querySelectorAll(".scene"));
  let cur = 0;
  const activate = (i, scroll) => {
    cur = Math.max(0, Math.min(scenes.length - 1, i));
    scenes.forEach((s, k) => s.classList.toggle("active", k === cur));
    if (scroll) scenes[cur].scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const play = (i) => { activate(i, false); v.currentTime = Number(scenes[cur].dataset.start || 0); v.play().catch(() => {}); v.scrollIntoView({ behavior: "smooth", block: "start" }); };
  scenes.forEach((s, i) => { s.addEventListener("click", () => activate(i, false)); s.querySelector(".jump").addEventListener("click", (e) => { e.stopPropagation(); play(i); }); });
  document.addEventListener("keydown", (e) => {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "j") { activate(cur + 1, true); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "k") { activate(cur - 1, true); e.preventDefault(); }
    else if (e.key === "Enter") { play(cur); e.preventDefault(); }
  });
  v.addEventListener("timeupdate", () => {
    const t = v.currentTime;
    let i = 0;
    scenes.forEach((s, k) => { if (t >= Number(s.dataset.start || 0)) i = k; });
    if (i !== cur) activate(i, false);
  });
  activate(0, false);
})();
</script>
</body>
</html>
`;
}

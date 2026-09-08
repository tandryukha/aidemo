import { chromium } from "playwright";
import { resolve } from "node:path";
import type { Cue } from "./captions.js";
import type { CaptionsConfig } from "./types.js";
import { ensureDir } from "./util.js";

export interface RenderedCue {
  png: string;
  startMs: number;
  endMs: number;
  height: number;
}

/** Fixed caption strip height (px) at the video's native width. */
const STRIP_HEIGHT = 160;

/**
 * Rasterizes each caption cue to a transparent PNG using headless Chrome. We do
 * this because this ffmpeg build lacks libass/libfreetype (no subtitles/drawtext
 * filters) — but `overlay` is always available, and CSS gives nicer captions.
 * Each PNG is <videoWidth> x STRIP_HEIGHT with a centered pill near the bottom.
 */
export async function renderCaptionPngs(
  cues: Cue[],
  outDir: string,
  videoWidth: number,
  scale = 1,
  look: CaptionsConfig & { font?: string } = {}
): Promise<RenderedCue[]> {
  await ensureDir(outDir);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  // Layout at the storyboard's logical width; deviceScaleFactor matches the
  // raw video's pixel density (1 for Playwright capture, 2 for native/OBS
  // retina capture) so the PNG overlays the frame 1:1.
  const context = await browser.newContext({
    viewport: { width: videoWidth, height: STRIP_HEIGHT },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();

  const rendered: RenderedCue[] = [];
  try {
    for (const cue of cues) {
      await page.setContent(html(cue.text, look), { waitUntil: "load" });
      const png = resolve(outDir, `cue-${String(cue.index).padStart(3, "0")}.png`);
      await page.screenshot({ path: png, omitBackground: true });
      rendered.push({ png, startMs: cue.startMs, endMs: cue.endMs, height: STRIP_HEIGHT });
    }
  } finally {
    await browser.close();
  }
  return rendered;
}

function html(text: string, look: CaptionsConfig & { font?: string }): string {
  const safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const font = look.font ?? '-apple-system,"Helvetica Neue",Arial,sans-serif';
  const size = look.size ?? 30;
  const color = look.color ?? "#fff";
  const bg = look.background ?? "rgba(12,14,22,.66)";
  const bar = look.style === "bar";
  // "bar": a full-width band flush with the strip's bottom edge; "pill": the
  // default centered rounded box 22 px above it (compose positions the strip).
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;width:100%;height:100%;}
    .wrap{position:absolute;inset:0;display:flex;align-items:flex-end;
      justify-content:center;padding-bottom:${bar ? 0 : 22}px;}
    .cap{max-width:${bar ? "100%" : "80%"};${bar ? "width:100%;" : ""}font-family:${font};
      font-size:${size}px;line-height:1.3;font-weight:650;color:${color};text-align:center;
      background:${bg};padding:${bar ? "14px 40px" : "10px 20px"};border-radius:${bar ? 0 : 12}px;
      -webkit-font-smoothing:antialiased;
      text-shadow:0 1px 3px rgba(0,0,0,.55);
      ${bar ? "" : "box-shadow:0 4px 18px rgba(0,0,0,.35);"}}
  </style></head><body><div class="wrap"><div class="cap">${safe}</div></div></body></html>`;
}

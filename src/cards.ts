import { chromium } from "playwright";
import type { Card } from "./types.js";

/**
 * Rasterizes an intro/outro title card to a PNG with headless Chrome — same
 * trick as the caption renderer (this ffmpeg build has no drawtext, and CSS
 * typography beats it anyway). The page is laid out at the storyboard's
 * logical size and screenshotted at `scale` (the raw video's pixel density),
 * so the PNG always matches the video frame 1:1.
 */
export async function renderCardPng(
  card: Card,
  outPath: string,
  logicalW: number,
  logicalH: number,
  scale: number
): Promise<void> {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: logicalW, height: logicalH },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();
  try {
    await page.setContent(html(card, logicalW), { waitUntil: "load" });
    await page.screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function html(card: Card, logicalW: number): string {
  const background =
    card.background ??
    "radial-gradient(120% 140% at 20% 0%, #182036 0%, #0b0d16 55%, #07080f 100%)";
  const accent = card.accent ?? "#6c8cff";
  const titleSize = Math.round(logicalW / 17);
  const subSize = Math.round(logicalW / 40);
  const subtitle = card.subtitle
    ? `<div class="sub">${esc(card.subtitle)}</div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:100%;height:100%;}
    body{background:${background};display:flex;align-items:center;justify-content:center;}
    .box{max-width:78%;text-align:center;
      font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;
      -webkit-font-smoothing:antialiased;}
    .rule{width:${Math.round(logicalW / 22)}px;height:5px;border-radius:3px;
      background:${accent};margin:0 auto ${Math.round(subSize * 1.2)}px;}
    .title{font-size:${titleSize}px;line-height:1.12;font-weight:750;
      letter-spacing:-0.015em;color:#f4f6fb;
      text-shadow:0 2px 24px rgba(0,0,0,.45);}
    .sub{margin-top:${Math.round(subSize * 0.9)}px;font-size:${subSize}px;
      line-height:1.4;font-weight:450;color:rgba(226,231,244,.72);}
  </style></head><body><div class="box">
    <div class="rule"></div>
    <div class="title">${esc(card.title)}</div>
    ${subtitle}
  </div></body></html>`;
}

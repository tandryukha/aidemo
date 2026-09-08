/**
 * Produced-look frame: padding, background, rounded corners, drop shadow and
 * an optional browser/mac chrome bar around the content — the "Screen Studio"
 * look, done with the same portable trick as cards and captions. Headless
 * Chrome rasterizes ONE canvas-sized PNG whose video area is a transparent
 * rounded hole (CSS mask); compose pads the content onto a solid canvas and
 * overlays that PNG. Two baseline filters (`pad`, `overlay`), no drawbox.
 */

import { chromium } from "playwright";
import type { Brand, Frame } from "./types.js";

export interface FrameLayout {
  /** Canvas size in output px (even). */
  canvasW: number;
  canvasH: number;
  /** Where the content lands on the canvas, output px. */
  offsetX: number;
  offsetY: number;
  /** Solid fallback color used under the PNG (matches the background's base). */
  padColor: string;
}

const CHROME_H = 40;
/** Device bezel thickness (logical px) for phone chrome. */
const BEZEL = 14;
const DEFAULT_BG =
  "linear-gradient(135deg, #1b2440 0%, #0e1322 55%, #0a0d18 100%)";

export function isDeviceChrome(chrome: Frame["chrome"]): boolean {
  return chrome === "iphone" || chrome === "android";
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Geometry only (no browser) — compose needs it before rendering. */
export function frameLayout(
  frame: Frame,
  videoW: number,
  videoH: number,
  pxScale: number,
  aspect?: number
): FrameLayout {
  const device = isDeviceChrome(frame.chrome);
  // A bezel needs room; the default padding already has it.
  const pad = Math.max(frame.padding ?? 48, device ? BEZEL + 8 : 0);
  const chromeH = frame.chrome && frame.chrome !== "none" && !device ? CHROME_H : 0;
  const even = (n: number) => Math.round(n) & ~1;
  // Logical canvas; when the output has a target aspect (preset or explicit
  // size) grow the padding on one axis so the canvas already matches it and
  // the final resize is a pure scale — no letterbox bars around a frame.
  let W = videoW + 2 * pad;
  let H = videoH + 2 * pad + chromeH;
  if (aspect && aspect > 0) {
    if (W / H < aspect) W = H * aspect;
    else H = W / aspect;
  }
  const padX = (W - videoW) / 2;
  const padY = (H - videoH - chromeH) / 2;
  return {
    canvasW: even(W * pxScale),
    canvasH: even(H * pxScale),
    offsetX: Math.round(padX * pxScale),
    offsetY: Math.round((padY + chromeH) * pxScale),
    padColor: "#0e1322",
  };
}

/**
 * Rasterize the frame PNG: canvas background + shadow + chrome, with a
 * rounded transparent hole exactly where the video sits.
 */
export async function renderFramePng(
  frame: Frame,
  brand: Brand | undefined,
  outPath: string,
  videoW: number,
  videoH: number,
  pxScale: number,
  aspect?: number
): Promise<FrameLayout> {
  const layout = frameLayout(frame, videoW, videoH, pxScale, aspect);
  const chrome = frame.chrome ?? "none";
  const device = isDeviceChrome(chrome);
  const radius = frame.radius ?? (device ? 40 : 14);
  const chromeH = chrome !== "none" && !device ? CHROME_H : 0;
  const accent = brand?.accent ?? "#6c8cff";
  const background =
    frame.background ??
    (brand?.accent
      ? `linear-gradient(135deg, ${accent} 0%, #0e1322 70%, #0a0d18 100%)`
      : DEFAULT_BG);
  const font = brand?.font ?? '-apple-system,"Helvetica Neue",Arial,sans-serif';
  const W = Math.round(layout.canvasW / pxScale);
  const H = Math.round(layout.canvasH / pxScale);
  // Hole = the video rect; the chrome bar sits directly above it, sharing the
  // window's rounded top corners (the video keeps the rounded bottom ones).
  const winX = Math.round(layout.offsetX / pxScale);
  const winY = Math.round(layout.offsetY / pxScale) - chromeH;
  const winW = videoW;
  const winH = videoH + chromeH;
  const holeY = winY + chromeH;
  const rTop = chromeH ? 0 : radius;
  // SVG mask (alpha): opaque everywhere except the rounded video rect.
  const hole =
    `M${winX} ${holeY + rTop} ` +
    `a${rTop} ${rTop} 0 0 1 ${rTop} -${rTop} h${winW - 2 * rTop} ` +
    `a${rTop} ${rTop} 0 0 1 ${rTop} ${rTop} v${videoH - rTop - radius} ` +
    `a${radius} ${radius} 0 0 1 -${radius} ${radius} h-${winW - 2 * radius} ` +
    `a${radius} ${radius} 0 0 1 -${radius} -${radius} z`;
  const mask =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'>` +
    `<path fill='white' fill-rule='evenodd' d='M0 0h${W}v${H}H0z ${hole}'/></svg>`;
  const maskUrl = `url("data:image/svg+xml;utf8,${encodeURIComponent(mask)}")`;
  const shadow =
    frame.shadow === false ? "none" : "0 24px 60px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35)";
  let chromeHtml = "";
  let deviceHtml = "";
  let deviceCss = "";
  if (device) {
    // Bezel behind the hole (masked with the canvas) + an unmasked camera
    // cut-out drawn over the video: a dynamic island or a punch-hole.
    const bx = winX - BEZEL;
    const by = winY - BEZEL;
    deviceCss =
      `.bezel{position:absolute;left:${bx}px;top:${by}px;width:${winW + 2 * BEZEL}px;height:${winH + 2 * BEZEL}px;` +
      `border-radius:${radius + BEZEL}px;background:#0b0b0d;border:2px solid #2b2d33;box-shadow:${shadow};}` +
      `.cam{position:absolute;background:#000;}` +
      (chrome === "iphone"
        ? `.island{left:${winX + winW / 2 - 55}px;top:${winY + 12}px;width:110px;height:32px;border-radius:16px;}`
        : `.hole{left:${winX + winW / 2 - 7}px;top:${winY + 14}px;width:14px;height:14px;border-radius:50%;}`);
    deviceHtml = `<div class="cam ${chrome === "iphone" ? "island" : "hole"}"></div>`;
  }
  if (chromeH) {
    const lights =
      chrome === "mac"
        ? `<span class="l" style="background:#ff5f57"></span><span class="l" style="background:#febc2e"></span><span class="l" style="background:#28c840"></span>`
        : `<span class="l" style="background:#3a4157"></span><span class="l" style="background:#3a4157"></span><span class="l" style="background:#3a4157"></span>`;
    const label = frame.url ?? frame.title ?? "";
    chromeHtml =
      `<div class="bar"><div class="lights">${lights}</div>` +
      (label ? `<div class="pill">${esc(label)}</div>` : "") +
      `</div>`;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;width:${W}px;height:${H}px;overflow:hidden;}
    *{box-sizing:border-box;font-family:${font};-webkit-font-smoothing:antialiased;}
    .canvas{position:absolute;inset:0;background:${background};
      -webkit-mask-image:${maskUrl};mask-image:${maskUrl};}
    .win{position:absolute;left:${winX}px;top:${winY}px;width:${winW}px;height:${winH}px;
      border-radius:${radius}px;box-shadow:${device ? "none" : shadow};background:#0b0e18;}
    ${deviceCss}
    .bar{position:absolute;left:${winX}px;top:${winY}px;width:${winW}px;height:${chromeH}px;
      border-radius:${radius}px ${radius}px 0 0;background:#1a1f2e;
      display:flex;align-items:center;padding:0 14px;gap:14px;
      border-bottom:1px solid rgba(255,255,255,.06);}
    .lights{display:flex;gap:8px;}
    .l{width:12px;height:12px;border-radius:50%;display:inline-block;}
    .pill{flex:1;max-width:60%;margin:0 auto;height:24px;line-height:24px;border-radius:7px;
      background:rgba(255,255,255,.07);color:rgba(230,234,245,.75);font-size:13px;
      text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:0 12px;}
  </style></head><body>
    <div class="canvas">${device ? '<div class="bezel"></div>' : ""}<div class="win"></div>${chromeHtml}</div>${deviceHtml}
  </body></html>`;

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: pxScale,
  });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: outPath, omitBackground: true });
  } finally {
    await browser.close();
  }
  return layout;
}

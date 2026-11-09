import { promises as fs } from "node:fs";
import { extname } from "node:path";
import type { Browser } from "playwright";
import { launchChrome } from "../browser.js";
import { runFfmpeg } from "../ffmpeg.js";
import type { StoreBrand } from "../types.js";

/**
 * Store overlays, end cards, screenshots and the feature graphic are HTML
 * rasterized by headless Chrome — the engine's portable trick (no drawtext,
 * real typography, any script via a brand font file). Text is data, so a new
 * language is a text swap. Layout math is pure and exported for tests.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

// ---------------------------------------------------------------------------
// Video layout
// ---------------------------------------------------------------------------

export type ResolvedLayout = "fill" | "band" | "side";
export interface VideoLayout {
  mode: ResolvedLayout;
  canvas: { w: number; h: number };
  /** Where the (scaled) device video sits. In `fill` it may exceed the canvas (cropped). */
  video: Rect;
  /** Caption text box. */
  caption: Rect;
  /** Corner radius of the video window (band/side). */
  radius: number;
}

export function videoLayout(
  canvasW: number,
  canvasH: number,
  deviceW: number,
  deviceH: number,
  mode: "auto" | ResolvedLayout = "auto",
  captionPosition: "top" | "bottom" = "top"
): VideoLayout {
  const ca = canvasW / canvasH;
  const da = deviceW / deviceH;
  let m: ResolvedLayout;
  if (mode !== "auto") m = mode;
  else if (Math.abs(da - ca) / ca < 0.04) m = "fill";
  else m = ca < 1 ? "band" : "side";
  const W = canvasW;
  const H = canvasH;
  if (m === "fill") {
    const s = Math.max(W / deviceW, H / deviceH);
    const w = even(deviceW * s);
    const h = even(deviceH * s);
    const capH = Math.round(H * 0.15);
    return {
      mode: m,
      canvas: { w: W, h: H },
      video: { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h },
      caption: {
        x: Math.round(W * 0.05),
        y: captionPosition === "top" ? Math.round(H * 0.055) : Math.round(H - H * 0.055 - capH),
        w: Math.round(W * 0.9),
        h: capH,
      },
      radius: 0,
    };
  }
  if (m === "band") {
    const band = Math.round(H * 0.19);
    const bottom = Math.round(H * 0.03);
    const s = Math.min((W * 0.9) / deviceW, (H - band - bottom) / deviceH);
    const w = even(deviceW * s);
    const h = even(deviceH * s);
    return {
      mode: m,
      canvas: { w: W, h: H },
      video: { x: Math.round((W - w) / 2), y: band, w, h },
      caption: { x: Math.round(W * 0.06), y: Math.round(H * 0.03), w: Math.round(W * 0.88), h: band - Math.round(H * 0.045) },
      radius: Math.round(w * 0.06),
    };
  }
  // side: caption panel on the left, device on the right
  const panel = Math.round(W * 0.44);
  const s = Math.min((W - panel - W * 0.06) / deviceW, (H * 0.92) / deviceH);
  const w = even(deviceW * s);
  const h = even(deviceH * s);
  return {
    mode: m,
    canvas: { w: W, h: H },
    video: { x: Math.round(panel + (W - panel - w) / 2), y: Math.round((H - h) / 2), w, h },
    caption: { x: Math.round(W * 0.06), y: Math.round(H * 0.1), w: panel - Math.round(W * 0.08), h: Math.round(H * 0.8) },
    radius: Math.round(w * 0.06),
  };
}

// ---------------------------------------------------------------------------
// Screenshot layout
// ---------------------------------------------------------------------------

export type DeviceStyle = "iphone" | "android" | "tablet" | "none";
export interface ShotLayout {
  canvas: { w: number; h: number };
  text: Rect;
  device: Rect;
  bezel: number;
  radius: number;
  screen: Rect;
  /** Raw-frame px cut from the top of the screen image. */
  cropTopPx: number;
  /** Screen width / canvas width — how much of the listing the UI fills. */
  screenFraction: number;
  /** Screen px per raw device px (≥ ~0.8 keeps UI text near its native size). */
  uiScale: number;
}

export function shotLayout(
  canvasW: number,
  canvasH: number,
  rawW: number,
  rawH: number,
  opts: { zoom?: number; bleed?: "bottom" | "top" | "none"; device?: DeviceStyle; cropTop?: number } = {}
): ShotLayout {
  const W = canvasW;
  const H = canvasH;
  const style = opts.device ?? "iphone";
  const bleed = opts.bleed ?? "bottom";
  const landscape = W > H;
  const textH = Math.round(H * (landscape ? 0.26 : 0.2));
  const margin = Math.round(H * 0.035);
  let deviceW = W * (opts.zoom ?? 0.92);
  const bezelFrac = style === "none" ? 0 : style === "tablet" ? 0.02 : 0.028;
  const cropTop = opts.cropTop ?? 0;
  const cropTopPx = Math.round(rawH * cropTop);
  const screenAspect = rawW / (rawH - cropTopPx);
  const deviceHFor = (dw: number) => {
    const b = dw * bezelFrac;
    return (dw - 2 * b) / screenAspect + 2 * b;
  };
  if (bleed === "none") {
    // Whole device visible between the text and the bottom margin.
    const room = H - textH - 2 * margin;
    while (deviceHFor(deviceW) > room) deviceW *= 0.98;
  }
  const bezel = Math.round(deviceW * bezelFrac);
  const dw = Math.round(deviceW);
  const dh = Math.round(deviceHFor(deviceW));
  const x = Math.round((W - dw) / 2);
  let y: number;
  let text: Rect;
  if (bleed === "top") {
    text = { x: Math.round(W * 0.07), y: H - textH - margin, w: Math.round(W * 0.86), h: textH };
    y = text.y - margin - dh;
  } else {
    text = { x: Math.round(W * 0.07), y: margin + Math.round(H * 0.015), w: Math.round(W * 0.86), h: textH - margin };
    y = textH + margin;
  }
  const radiusFrac = style === "iphone" ? 0.13 : style === "android" ? 0.09 : style === "tablet" ? 0.05 : 0.05;
  const radius = Math.round(dw * radiusFrac);
  const screen = { x: x + bezel, y: y + bezel, w: dw - 2 * bezel, h: dh - 2 * bezel };
  return {
    canvas: { w: W, h: H },
    text,
    device: { x, y, w: dw, h: dh },
    bezel,
    radius,
    screen,
    cropTopPx,
    screenFraction: screen.w / W,
    uiScale: screen.w / rawW,
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export const DEFAULT_STORE_BRAND = {
  background: "linear-gradient(160deg, #13203a 0%, #0b1222 60%, #070b16 100%)",
  text: "#ffffff",
  accent: "#7ee08a",
  muted: "rgba(235,240,250,.72)",
  font: '-apple-system, "SF Pro Display", "Helvetica Neue", Inter, Arial, sans-serif',
  weight: 800,
};

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Escape, then `*word*` → accent span. */
export function markup(text: string): string {
  return esc(text).replace(/\*([^*]+)\*/g, '<span class="acc">$1</span>');
}

export async function dataUri(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  const mime =
    ext === ".png" ? "image/png"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".svg" ? "image/svg+xml"
    : ext === ".webp" ? "image/webp"
    : ext === ".ttf" ? "font/ttf"
    : ext === ".otf" ? "font/otf"
    : ext === ".woff2" ? "font/woff2"
    : ext === ".woff" ? "font/woff"
    : "application/octet-stream";
  return `data:${mime};base64,${(await fs.readFile(path)).toString("base64")}`;
}

export interface BrandCss {
  background: string;
  text: string;
  accent: string;
  muted: string;
  font: string;
  weight: number;
  fontFace: string;
}

export async function brandCss(brand: StoreBrand | undefined, resolvePath: (p: string) => string): Promise<BrandCss> {
  const b = { ...DEFAULT_STORE_BRAND, ...Object.fromEntries(Object.entries(brand ?? {}).filter(([, v]) => v != null)) };
  let fontFace = "";
  let font = b.font;
  if (brand?.fontFile) {
    fontFace = `@font-face{font-family:"StoreBrand";src:url("${await dataUri(resolvePath(brand.fontFile))}");font-weight:100 1000;}`;
    font = `"StoreBrand", ${b.font}`;
  }
  return { background: b.background, text: b.text, accent: b.accent, muted: b.muted, font, weight: b.weight, fontFace };
}

/** Shrinks every `.fit` element's font until its text fits its box. */
const FIT_SCRIPT = `window.__fit = () => {
  for (const el of document.querySelectorAll('.fit')) {
    let size = parseFloat(getComputedStyle(el).fontSize);
    const min = size * 0.45;
    while ((el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) && size > min) {
      size *= 0.95;
      el.style.fontSize = size + 'px';
    }
  }
};`;

function page(b: BrandCss, w: number, h: number, css: string, body: string, transparent = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${b.fontFace}
html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;}
body{position:relative;${transparent ? "background:transparent;" : `background:${b.background};`}
  font-family:${b.font};color:${b.text};-webkit-font-smoothing:antialiased;}
.acc{color:${b.accent};}
.abs{position:absolute;}
.fit{overflow:hidden;}
${css}
</style><script>${FIT_SCRIPT}</script></head><body>${body}</body></html>`;
}

function roundedHolePath(W: number, H: number, r: Rect, rad: number): string {
  const { x, y, w, h } = r;
  const k = Math.min(rad, w / 2, h / 2);
  return (
    `M0 0H${W}V${H}H0Z ` +
    `M${x + k} ${y}H${x + w - k}A${k} ${k} 0 0 1 ${x + w} ${y + k}V${y + h - k}A${k} ${k} 0 0 1 ${x + w - k} ${y + h}` +
    `H${x + k}A${k} ${k} 0 0 1 ${x} ${y + h - k}V${y + k}A${k} ${k} 0 0 1 ${x + k} ${y}Z`
  );
}

/** Transparent overlay for one scene: caption (+ background with a video hole for band/side). */
export function videoOverlayHtml(b: BrandCss, L: VideoLayout, caption?: string): string {
  const { w: W, h: H } = L.canvas;
  const c = L.caption;
  let css = "";
  let body = "";
  if (L.mode !== "fill") {
    const mask = `url("data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'><path fill-rule='evenodd' d='${roundedHolePath(W, H, L.video, L.radius)}'/></svg>`
    )}")`;
    css += `.bg{left:0;top:0;width:${W}px;height:${H}px;background:${b.background};-webkit-mask-image:${mask};mask-image:${mask};}
.ring{left:${L.video.x - 3}px;top:${L.video.y - 3}px;width:${L.video.w}px;height:${L.video.h}px;border:3px solid rgba(255,255,255,.14);border-radius:${L.radius + 3}px;}`;
    body += `<div class="abs bg"></div><div class="abs ring"></div>`;
  }
  if (caption) {
    const size = Math.round(L.mode === "side" ? W * 0.048 : W * 0.085);
    const plate =
      L.mode === "fill"
        ? `background:rgba(8,12,22,.80);border-radius:${Math.round(W * 0.04)}px;padding:${Math.round(W * 0.035)}px ${Math.round(W * 0.05)}px;box-sizing:border-box;`
        : "";
    css += `.cap{left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;display:flex;align-items:center;
  justify-content:${L.mode === "side" ? "flex-start" : "center"};text-align:${L.mode === "side" ? "left" : "center"};
  font-size:${size}px;line-height:1.08;font-weight:${b.weight};letter-spacing:-0.02em;${plate}
  text-shadow:0 2px 18px rgba(0,0,0,.35);}`;
    body += `<div class="abs cap fit">${markup(caption)}</div>`;
  }
  return page(b, W, H, css, body, true);
}

export function endCardHtml(
  b: BrandCss,
  W: number,
  H: number,
  card: { appName: string; line?: string; iconUri?: string }
): string {
  const unit = Math.min(W, H);
  const icon = card.iconUri
    ? `<img class="icon" src="${card.iconUri}" alt="">`
    : "";
  const css = `.wrap{left:0;top:0;width:${W}px;height:${H}px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;}
.icon{width:${Math.round(unit * 0.28)}px;height:${Math.round(unit * 0.28)}px;border-radius:22.5%;box-shadow:0 ${Math.round(unit * 0.02)}px ${Math.round(unit * 0.06)}px rgba(0,0,0,.35);margin-bottom:${Math.round(unit * 0.06)}px;}
.name{font-size:${Math.round(unit * 0.12)}px;font-weight:${b.weight};letter-spacing:-0.02em;line-height:1.05;max-width:${Math.round(W * 0.86)}px;}
.line{margin-top:${Math.round(unit * 0.035)}px;font-size:${Math.round(unit * 0.06)}px;color:${b.muted};font-weight:600;max-width:${Math.round(W * 0.8)}px;line-height:1.2;}`;
  const body = `<div class="abs wrap">${icon}<div class="name">${markup(card.appName)}</div>${
    card.line ? `<div class="line">${markup(card.line)}</div>` : ""
  }</div>`;
  return page(b, W, H, css, body);
}

export function screenshotHtml(
  b: BrandCss,
  L: ShotLayout,
  shot: { headline: string; subhead?: string; frameUri: string; device: DeviceStyle; rawH: number }
): string {
  const { w: W, h: H } = L.canvas;
  const t = L.text;
  const head = Math.round(Math.min(W, H) * (W > H ? 0.075 : 0.088));
  const sub = Math.round(head * 0.42);
  const screenR = Math.max(0, L.radius - L.bezel);
  const scale = L.uiScale;
  const island =
    L.cropTopPx === 0 && shot.device === "iphone"
      ? `<div class="abs island" style="left:${L.screen.x + L.screen.w * 0.35}px;top:${L.screen.y + L.screen.w * 0.03}px;width:${L.screen.w * 0.3}px;height:${L.screen.w * 0.085}px;border-radius:${L.screen.w * 0.05}px"></div>`
      : L.cropTopPx === 0 && shot.device === "android"
        ? `<div class="abs island" style="left:${L.screen.x + L.screen.w / 2 - L.screen.w * 0.025}px;top:${L.screen.y + L.screen.w * 0.03}px;width:${L.screen.w * 0.05}px;height:${L.screen.w * 0.05}px;border-radius:50%"></div>`
        : "";
  const css = `.text{left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;}
.head{font-size:${head}px;font-weight:${b.weight};line-height:1.06;letter-spacing:-0.025em;max-height:${t.h}px;}
.sub{margin-top:${Math.round(sub * 0.6)}px;font-size:${sub}px;line-height:1.25;color:${b.muted};font-weight:600;}
.device{left:${L.device.x}px;top:${L.device.y}px;width:${L.device.w}px;height:${L.device.h}px;border-radius:${L.radius}px;
  background:${shot.device === "none" ? "transparent" : "#0a0a0d"};box-shadow:0 ${Math.round(W * 0.03)}px ${Math.round(W * 0.08)}px rgba(0,0,0,.38), inset 0 0 0 ${Math.max(2, Math.round(L.bezel * 0.18))}px #2a2a31;}
.screen{left:${L.screen.x}px;top:${L.screen.y}px;width:${L.screen.w}px;height:${L.screen.h}px;border-radius:${screenR}px;overflow:hidden;background:#000;}
.screen img{display:block;width:${L.screen.w}px;height:${Math.round(shot.rawH * scale)}px;margin-top:${-Math.round(L.cropTopPx * scale)}px;}
.island{background:#000;}`;
  const body = `<div class="abs text"><div class="head fit">${markup(shot.headline)}</div>${
    shot.subhead ? `<div class="sub">${markup(shot.subhead)}</div>` : ""
  }</div><div class="abs device"></div><div class="abs screen"><img src="${shot.frameUri}" alt=""></div>${island}`;
  return page(b, W, H, css, body);
}

export function featureGraphicHtml(
  b: BrandCss,
  fg: { headline: string; appName?: string; iconUri?: string; frameUri?: string; rawW?: number; rawH?: number }
): string {
  const W = 1024;
  const H = 500;
  const hasDevice = !!fg.frameUri && !!fg.rawW && !!fg.rawH;
  const textW = hasDevice ? 560 : 860;
  let device = "";
  let deviceCss = "";
  if (hasDevice) {
    const dw = 300;
    const bezel = 9;
    const sw = dw - 2 * bezel;
    const sh = Math.round((sw * fg.rawH!) / fg.rawW!);
    deviceCss = `.dev{left:${W - dw - 70}px;top:58px;width:${dw}px;height:${sh + 2 * bezel}px;border-radius:40px;background:#0a0a0d;box-shadow:0 20px 60px rgba(0,0,0,.4), inset 0 0 0 2px #2a2a31;}
.scr{left:${W - dw - 70 + bezel}px;top:${58 + bezel}px;width:${sw}px;height:${sh}px;border-radius:31px;overflow:hidden;}
.scr img{width:${sw}px;height:${sh}px;display:block;}`;
    device = `<div class="abs dev"></div><div class="abs scr"><img src="${fg.frameUri}" alt=""></div>`;
  }
  const icon = fg.iconUri ? `<img class="icon" src="${fg.iconUri}" alt="">` : "";
  const css = `.txt{left:64px;top:60px;width:${textW}px;height:380px;display:flex;flex-direction:column;justify-content:center;}
.brandrow{display:flex;align-items:center;gap:20px;margin-bottom:26px;}
.icon{width:84px;height:84px;border-radius:19px;box-shadow:0 8px 24px rgba(0,0,0,.3);}
.name{font-size:40px;font-weight:${b.weight};letter-spacing:-0.02em;}
.head{font-size:62px;line-height:1.06;font-weight:${b.weight};letter-spacing:-0.025em;max-height:240px;}
${deviceCss}`;
  const body = `<div class="abs txt"><div class="brandrow">${icon}${fg.appName ? `<div class="name">${markup(fg.appName)}</div>` : ""}</div><div class="head fit">${markup(fg.headline)}</div></div>${device}`;
  return page(b, W, H, css, body);
}

// ---------------------------------------------------------------------------
// Rasterizer
// ---------------------------------------------------------------------------

/** One headless Chrome for a batch of renders. */
export class Rasterizer {
  private browser: Browser | null = null;

  async render(html: string, w: number, h: number, out: string, opts: { transparent?: boolean } = {}): Promise<void> {
    this.browser ??= await launchChrome({ headless: true });
    const ctx = await this.browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    try {
      const pg = await ctx.newPage();
      await pg.setContent(html, { waitUntil: "load" });
      await pg.evaluate(async () => {
        await document.fonts.ready;
        (window as unknown as { __fit?: () => void }).__fit?.();
      });
      await pg.screenshot({ path: out, omitBackground: !!opts.transparent, clip: { x: 0, y: 0, width: w, height: h } });
    } finally {
      await ctx.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}

/** Re-encode a PNG as opaque 24-bit RGB (stores reject alpha). */
export async function toOpaqueRgbPng(src: string, out: string): Promise<void> {
  await runFfmpeg(["-i", src, "-frames:v", "1", "-pix_fmt", "rgb24", "-update", "1", out]);
}

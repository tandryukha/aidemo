/**
 * Attention overlays — compose-time drawing of the beats the player measured
 * (timeline `attentionEvents`, `keyEvents`, `redactSpans`, click points).
 *
 * Same portability trick as captions and cards: every mark is a transparent
 * PNG rasterized by headless Chrome (CSS gives us rings, pills, arrows and
 * soft shadows for free) and overlaid with a time-gated `enable` — the
 * baseline `overlay` filter only, no drawtext/drawbox. Redaction is
 * `crop` + `boxblur` + `overlay`, also baseline.
 *
 * Positions arrive in viewport CSS px and are mapped to output px by pxScale;
 * every PNG is rendered at deviceScaleFactor = pxScale so it lands 1:1.
 */

import { chromium, type Page } from "playwright";
import { resolve } from "node:path";
import type { AttentionEvent, AttentionStyle, RedactSpan } from "./types.js";
import { ensureDir } from "./util.js";

/** One PNG to overlay at (x, y) output px during [a, b] content seconds. */
export interface OverlayItem {
  png: string;
  x: number;
  y: number;
  a: number;
  b: number;
}

/** An attention event already mapped into content time (seconds). */
export interface PlacedAttention extends AttentionEvent {
  a: number;
  b: number;
}

/** A key chip already mapped into content time. */
export interface PlacedKey {
  keys: string;
  a: number;
  b: number;
}

/** A click already mapped into content time (viewport CSS px). */
export interface PlacedClick {
  x: number;
  y: number;
  t: number;
}

/** A redact span already mapped into content time (viewport CSS px). */
export interface PlacedRedact extends RedactSpan {
  a: number;
  b: number;
}

export const DEFAULT_ACCENT = "#ff5a5f";
const SHADOW_MARGIN = 10;
/** How long a keystroke chip stays up, ms. */
export const KEY_CHIP_MS = 900;
/** Click ring: three stepped frames (diameter logical px, opacity, ms). */
const CLICK_RING_STEPS: Array<{ d: number; o: number; ms: number }> = [
  { d: 18, o: 0.9, ms: 90 },
  { d: 30, o: 0.6, ms: 90 },
  { d: 44, o: 0.3, ms: 110 },
];

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function styleOf(ev: AttentionEvent, accent: string): Required<AttentionStyle> {
  const s: AttentionStyle = ev.style ?? {};
  return {
    color: s.color ?? accent,
    thickness: s.thickness ?? 3,
    padding: s.padding ?? 6,
    shape: s.shape ?? "box",
  };
}

const PAGE_CSS = `html,body{margin:0;padding:0;background:transparent;}
  *{box-sizing:border-box;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;
    -webkit-font-smoothing:antialiased;}`;

/** Screenshot the element `#m` of the current page to `png`; returns its size. */
async function shotElement(
  page: Page,
  png: string
): Promise<{ w: number; h: number }> {
  const el = page.locator("#m");
  const box = await el.boundingBox();
  if (!box) throw new Error("attention: overlay element has no box");
  await el.screenshot({ path: png, omitBackground: true });
  return { w: Math.round(box.width), h: Math.round(box.height) };
}

/**
 * Rasterize highlight / spotlight / callout events into positioned overlay
 * items (output px, content seconds). One headless Chrome for the whole batch.
 */
export async function renderAttentionPngs(
  events: PlacedAttention[],
  outDir: string,
  videoW: number,
  videoH: number,
  pxScale: number,
  accent: string = DEFAULT_ACCENT
): Promise<OverlayItem[]> {
  if (events.length === 0) return [];
  await ensureDir(outDir);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: videoW, height: videoH },
    deviceScaleFactor: pxScale,
  });
  const page = await context.newPage();
  const items: OverlayItem[] = [];
  try {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const st = styleOf(ev, accent);
      const png = resolve(outDir, `${ev.kind}-${String(i).padStart(3, "0")}.png`);
      const radius = st.shape === "ring" ? 999 : 10;
      if (ev.kind === "highlight") {
        const inset = st.padding + st.thickness;
        const w = ev.w + 2 * inset + 2 * SHADOW_MARGIN;
        const h = ev.h + 2 * inset + 2 * SHADOW_MARGIN;
        await page.setContent(
          `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}
            #m{position:absolute;left:0;top:0;width:${w}px;height:${h}px;}
            .r{position:absolute;left:${SHADOW_MARGIN}px;top:${SHADOW_MARGIN}px;
              width:${w - 2 * SHADOW_MARGIN}px;height:${h - 2 * SHADOW_MARGIN}px;
              border:${st.thickness}px solid ${st.color};border-radius:${radius}px;
              box-shadow:0 0 0 2px rgba(255,255,255,.35),0 4px 16px rgba(0,0,0,.28);}
          </style></head><body><div id="m"><div class="r"></div></div></body></html>`,
          { waitUntil: "load" }
        );
        await shotElement(page, png);
        items.push({
          png,
          x: Math.round((ev.x - inset - SHADOW_MARGIN) * pxScale),
          y: Math.round((ev.y - inset - SHADOW_MARGIN) * pxScale),
          a: ev.a,
          b: ev.b,
        });
      } else if (ev.kind === "spotlight") {
        const pad = ev.padding ?? 10;
        const dim = ev.dimTo ?? 0.55;
        const hx = Math.max(0, ev.x - pad);
        const hy = Math.max(0, ev.y - pad);
        const hw = Math.min(videoW - hx, ev.w + 2 * pad);
        const hh = Math.min(videoH - hy, ev.h + 2 * pad);
        await page.setContent(
          `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}
            #m{position:absolute;left:0;top:0;width:${videoW}px;height:${videoH}px;overflow:hidden;}
            .h{position:absolute;left:${hx}px;top:${hy}px;width:${hw}px;height:${hh}px;
              border-radius:${radius}px;box-shadow:0 0 0 ${videoW + videoH}px rgba(0,0,0,${dim});
              border:${st.thickness}px solid ${st.color};opacity:1;}
          </style></head><body><div id="m"><div class="h"></div></div></body></html>`,
          { waitUntil: "load" }
        );
        await shotElement(page, png);
        items.push({ png, x: 0, y: 0, a: ev.a, b: ev.b });
      } else {
        // callout: a pill with a small arrow facing the element.
        const gap = 12;
        const cx = ev.x + ev.w / 2;
        const cy = ev.y + ev.h / 2;
        let placement = ev.placement ?? "auto";
        if (placement === "auto") {
          placement = ev.y + ev.h + 90 < videoH ? "bottom" : ev.y - 90 > 0 ? "top" : "right";
        }
        const arrowSide = { bottom: "top", top: "bottom", left: "right", right: "left" }[
          placement as "bottom" | "top" | "left" | "right"
        ];
        const tri = 9;
        const arrowCss = {
          top: `left:50%;top:-${tri}px;margin-left:-${tri}px;border-width:0 ${tri}px ${tri}px ${tri}px;border-color:transparent transparent ${st.color} transparent;`,
          bottom: `left:50%;bottom:-${tri}px;margin-left:-${tri}px;border-width:${tri}px ${tri}px 0 ${tri}px;border-color:${st.color} transparent transparent transparent;`,
          left: `top:50%;left:-${tri}px;margin-top:-${tri}px;border-width:${tri}px ${tri}px ${tri}px 0;border-color:transparent ${st.color} transparent transparent;`,
          right: `top:50%;right:-${tri}px;margin-top:-${tri}px;border-width:${tri}px 0 ${tri}px ${tri}px;border-color:transparent transparent transparent ${st.color};`,
        }[arrowSide];
        await page.setContent(
          `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}
            #m{position:absolute;left:0;top:0;padding:${tri + SHADOW_MARGIN}px;display:inline-block;}
            .p{position:relative;display:inline-block;max-width:${Math.round(videoW * 0.5)}px;
              padding:10px 16px;border-radius:12px;background:${st.color};color:#fff;
              font-size:22px;line-height:1.25;font-weight:650;white-space:nowrap;
              box-shadow:0 6px 20px rgba(0,0,0,.35);}
            .p:after{content:"";position:absolute;width:0;height:0;border-style:solid;${arrowCss}}
          </style></head><body><div id="m"><div class="p">${esc(ev.text ?? "")}</div></div></body></html>`,
          { waitUntil: "load" }
        );
        const size = await shotElement(page, png);
        // Size includes the transparent padding; the pill itself is inset.
        const inset = tri + SHADOW_MARGIN;
        const pw = size.w - 2 * inset;
        const ph = size.h - 2 * inset;
        let px = cx - pw / 2;
        let py = cy - ph / 2;
        if (placement === "bottom") py = ev.y + ev.h + gap;
        else if (placement === "top") py = ev.y - gap - ph;
        else if (placement === "left") px = ev.x - gap - pw;
        else px = ev.x + ev.w + gap;
        px = Math.max(4, Math.min(videoW - pw - 4, px));
        py = Math.max(4, Math.min(videoH - ph - 4, py));
        items.push({
          png,
          x: Math.round((px - inset) * pxScale),
          y: Math.round((py - inset) * pxScale),
          a: ev.a,
          b: ev.b,
        });
      }
    }
  } finally {
    await browser.close();
  }
  return items;
}

/**
 * Keystroke chips: one PNG per distinct label, positioned bottom-right above
 * the caption band. Returns overlay items in content time.
 */
export async function renderKeyChipPngs(
  keys: PlacedKey[],
  outDir: string,
  videoW: number,
  videoH: number,
  pxScale: number
): Promise<OverlayItem[]> {
  if (keys.length === 0) return [];
  await ensureDir(outDir);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 600, height: 120 },
    deviceScaleFactor: pxScale,
  });
  const page = await context.newPage();
  const byLabel = new Map<string, { png: string; w: number; h: number }>();
  const items: OverlayItem[] = [];
  try {
    for (const k of keys) {
      let r = byLabel.get(k.keys);
      if (!r) {
        const png = resolve(outDir, `key-${byLabel.size}.png`);
        const parts = k.keys
          .split(" ")
          .map((p) => `<kbd>${esc(p)}</kbd>`)
          .join("<span class=plus>+</span>");
        await page.setContent(
          `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}
            #m{position:absolute;left:0;top:0;display:inline-flex;align-items:center;gap:6px;
              padding:8px 12px;border-radius:12px;background:rgba(12,14,22,.78);
              box-shadow:0 4px 16px rgba(0,0,0,.35);}
            kbd{display:inline-block;min-width:36px;padding:4px 10px;border-radius:8px;
              background:#f4f5f8;color:#111;font-size:22px;font-weight:700;text-align:center;
              box-shadow:inset 0 -2px 0 rgba(0,0,0,.25);}
            .plus{color:#fff;font-size:18px;font-weight:600;}
          </style></head><body><div id="m">${parts}</div></body></html>`,
          { waitUntil: "load" }
        );
        const size = await shotElement(page, png);
        r = { png, ...size };
        byLabel.set(k.keys, r);
      }
      items.push({
        png: r.png,
        x: Math.round((videoW - r.w - 28) * pxScale),
        y: Math.round((videoH - r.h - 200) * pxScale),
        a: k.a,
        b: k.b,
      });
    }
  } finally {
    await browser.close();
  }
  return items;
}

/** Click rings: three stepped ring PNGs per click (a compose-time click pulse). */
export async function renderClickRingPngs(
  clicks: PlacedClick[],
  outDir: string,
  pxScale: number,
  color: string = DEFAULT_ACCENT
): Promise<OverlayItem[]> {
  if (clicks.length === 0) return [];
  await ensureDir(outDir);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 64, height: 64 },
    deviceScaleFactor: pxScale,
  });
  const page = await context.newPage();
  const pngs: string[] = [];
  try {
    for (let i = 0; i < CLICK_RING_STEPS.length; i++) {
      const s = CLICK_RING_STEPS[i];
      const png = resolve(outDir, `ring-${i}.png`);
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}
          #m{position:absolute;left:0;top:0;width:${s.d}px;height:${s.d}px;border-radius:50%;
            border:3px solid ${color};opacity:${s.o};background:rgba(255,255,255,${s.o * 0.25});}
        </style></head><body><div id="m"></div></body></html>`,
        { waitUntil: "load" }
      );
      await shotElement(page, png);
      pngs.push(png);
    }
  } finally {
    await browser.close();
  }
  const items: OverlayItem[] = [];
  for (const c of clicks) {
    let t = c.t;
    CLICK_RING_STEPS.forEach((s, i) => {
      items.push({
        png: pngs[i],
        x: Math.round((c.x - s.d / 2) * pxScale),
        y: Math.round((c.y - s.d / 2) * pxScale),
        a: t,
        b: t + s.ms / 1000,
      });
      t += s.ms / 1000;
    });
  }
  return items;
}

/** Max redact spans per ffmpeg pass (each is a split + crop + blur + overlay). */
export const REDACT_BATCH = 12;

/**
 * Build one `-filter_complex` blurring `spans` over input 0. Boxes are clamped
 * to the frame and the blur radius to what boxblur accepts for the crop size.
 */
export function buildRedactFilter(
  spans: PlacedRedact[],
  outW: number,
  outH: number,
  pxScale: number
): string | null {
  if (spans.length === 0) return null;
  const chain: string[] = [];
  let prev = "0:v";
  spans.forEach((s, i) => {
    const x = Math.max(0, Math.round(s.x * pxScale));
    const y = Math.max(0, Math.round(s.y * pxScale));
    // Even crop dims (yuv420p chroma is half-size); luma radius < min(w,h)/2,
    // chroma radius < min(w,h)/4 — boxblur rejects anything larger.
    const w = Math.max(4, Math.min(outW - x, Math.round(s.w * pxScale)) & ~1);
    const h = Math.max(4, Math.min(outH - y, Math.round(s.h * pxScale)) & ~1);
    const r = Math.max(1, Math.min(Math.round(s.blur * pxScale), Math.floor(Math.min(w, h) / 2) - 1));
    const cr = Math.max(0, Math.min(Math.floor(r / 2), Math.floor(Math.min(w, h) / 4) - 1));
    const label = i === spans.length - 1 ? "vout" : `r${i}`;
    chain.push(
      `[${prev}]split[a${i}][b${i}];` +
        `[b${i}]crop=${w}:${h}:${x}:${y},boxblur=lr=${r}:lp=2:cr=${cr}:cp=2[bb${i}];` +
        `[a${i}][bb${i}]overlay=${x}:${y}:enable='between(t,${s.a.toFixed(3)},${s.b.toFixed(3)})'[${label}]`
    );
    prev = label;
  });
  return chain.join(";");
}

import type { StoreScreenshotPresetId, StoreVideoPresetId } from "../types.js";

/**
 * Store export specs. Sources (checked 2026-11-09):
 *  - Apple "App preview specifications": iPhone 6.9"/6.7" (Dynamic Island,
 *    large) accepts 886x1920 portrait / 1920x886 landscape; 15–30 s; ≤ 30 fps;
 *    H.264 ≤ High@4.0 at 10–12 Mbps (or ProRes 422 HQ); stereo AAC 256 kbps
 *    44.1/48 kHz with every track enabled; ≤ 500 MB; .mov/.m4v/.mp4.
 *  - Google Play promo video: a YouTube URL (no ads, not age-restricted, not a
 *    playlist). Play shows it muted in the listing; 30 s–2 min is Google's
 *    recommendation, not a hard limit — so short is a warning, not an error.
 *  - Apple screenshots: 6.9" 1320x2868 (also 1290x2796), 6.5" 1242x2688, iPad
 *    13" 2064x2752; PNG/JPEG, RGB (no alpha).
 *  - Play screenshots: 320–3840 px per side, long side ≤ 2× short side, ≤ 8 MB,
 *    24-bit PNG or JPEG; 1080x1920 qualifies for promotional placements.
 *    Feature graphic 1024x500, no alpha, ≤ 15 MB.
 */

export interface StoreVideoPreset {
  id: StoreVideoPresetId;
  store: "app-store" | "google-play";
  width: number;
  height: number;
  fps: number;
  /** Hard duration limits, seconds (errors). */
  minSec?: number;
  maxSec?: number;
  /** Recommended range, seconds (warnings). */
  recommendMinSec?: number;
  recommendMaxSec?: number;
  videoBitrate: string;
  maxrate: string;
  bufsize: string;
  /** H.264 profile + level ceiling (ffprobe `level` is ×10: 40 = 4.0). */
  profile: "high";
  maxLevel: number;
  audioBitrate: string;
  sampleRate: 44100 | 48000;
  maxBytes: number;
  note: string;
}

export const STORE_VIDEO_PRESETS: Record<StoreVideoPresetId, StoreVideoPreset> = {
  "app-store-preview": {
    id: "app-store-preview",
    store: "app-store",
    width: 886,
    height: 1920,
    fps: 30,
    minSec: 15,
    maxSec: 30,
    videoBitrate: "10M",
    maxrate: "12M",
    bufsize: "20M",
    profile: "high",
    maxLevel: 40,
    audioBitrate: "256k",
    sampleRate: 48000,
    maxBytes: 500 * 1024 * 1024,
    note: 'App Preview for the iPhone 6.9"/6.7" slot (ASC previewType IPHONE_67)',
  },
  "app-store-preview-landscape": {
    id: "app-store-preview-landscape",
    store: "app-store",
    width: 1920,
    height: 886,
    fps: 30,
    minSec: 15,
    maxSec: 30,
    videoBitrate: "10M",
    maxrate: "12M",
    bufsize: "20M",
    profile: "high",
    maxLevel: 40,
    audioBitrate: "256k",
    sampleRate: 48000,
    maxBytes: 500 * 1024 * 1024,
    note: 'Landscape App Preview for the iPhone 6.9"/6.7" slot',
  },
  "play-promo-portrait": {
    id: "play-promo-portrait",
    store: "google-play",
    width: 1080,
    height: 1920,
    fps: 30,
    maxSec: 600,
    recommendMinSec: 30,
    recommendMaxSec: 120,
    videoBitrate: "12M",
    maxrate: "16M",
    bufsize: "24M",
    profile: "high",
    maxLevel: 42,
    audioBitrate: "192k",
    sampleRate: 48000,
    maxBytes: 2 * 1024 * 1024 * 1024,
    note: "Google Play promo video — upload to YouTube (public or unlisted, no ads) and paste the URL",
  },
  "play-promo-landscape": {
    id: "play-promo-landscape",
    store: "google-play",
    width: 1920,
    height: 1080,
    fps: 30,
    maxSec: 600,
    recommendMinSec: 30,
    recommendMaxSec: 120,
    videoBitrate: "12M",
    maxrate: "16M",
    bufsize: "24M",
    profile: "high",
    maxLevel: 42,
    audioBitrate: "192k",
    sampleRate: 48000,
    maxBytes: 2 * 1024 * 1024 * 1024,
    note: "Google Play promo video (landscape) — upload to YouTube and paste the URL",
  },
};

export interface StoreImagePreset {
  id: StoreScreenshotPresetId | "play-feature-graphic";
  store: "app-store" | "google-play";
  width: number;
  height: number;
  maxBytes: number;
  device: "iphone" | "android" | "tablet";
  note: string;
}

export const STORE_SCREENSHOT_PRESETS: Record<StoreScreenshotPresetId, StoreImagePreset> = {
  "ios-6.9": {
    id: "ios-6.9",
    store: "app-store",
    width: 1320,
    height: 2868,
    maxBytes: 10 * 1024 * 1024,
    device: "iphone",
    note: 'iPhone 6.9" (APP_IPHONE_67) — Apple scales it for every smaller iPhone',
  },
  "ios-6.5": {
    id: "ios-6.5",
    store: "app-store",
    width: 1242,
    height: 2688,
    maxBytes: 10 * 1024 * 1024,
    device: "iphone",
    note: 'iPhone 6.5" (APP_IPHONE_65) — only when you want a separate 6.5" set',
  },
  "ipad-13": {
    id: "ipad-13",
    store: "app-store",
    width: 2064,
    height: 2752,
    maxBytes: 10 * 1024 * 1024,
    device: "tablet",
    note: 'iPad 13" (APP_IPAD_PRO_3GEN_129)',
  },
  "play-phone": {
    id: "play-phone",
    store: "google-play",
    width: 1080,
    height: 1920,
    maxBytes: 8 * 1024 * 1024,
    device: "android",
    note: "Play phone screenshot, 9:16 (eligible for promotional placements)",
  },
  "play-tablet": {
    id: "play-tablet",
    store: "google-play",
    width: 1600,
    height: 2560,
    maxBytes: 8 * 1024 * 1024,
    device: "tablet",
    note: "Play 10\" tablet screenshot",
  },
};

export const PLAY_FEATURE_GRAPHIC: StoreImagePreset = {
  id: "play-feature-graphic",
  store: "google-play",
  width: 1024,
  height: 500,
  maxBytes: 15 * 1024 * 1024,
  device: "android",
  note: "Play feature graphic",
};

export function storeVideoPreset(id: string): StoreVideoPreset {
  const p = (STORE_VIDEO_PRESETS as Record<string, StoreVideoPreset>)[id];
  if (!p) throw new Error(`unknown store video preset "${id}" (${Object.keys(STORE_VIDEO_PRESETS).join(", ")})`);
  return p;
}

export function storeImagePreset(id: string): StoreImagePreset {
  if (id === PLAY_FEATURE_GRAPHIC.id) return PLAY_FEATURE_GRAPHIC;
  const p = (STORE_SCREENSHOT_PRESETS as Record<string, StoreImagePreset>)[id];
  if (!p)
    throw new Error(
      `unknown store screenshot preset "${id}" (${[...Object.keys(STORE_SCREENSHOT_PRESETS), PLAY_FEATURE_GRAPHIC.id].join(", ")})`
    );
  return p;
}

/** ASC's poster-frame timecode format (HH:MM:SS:FF at the preset's fps). */
export function posterTimeCode(ms: number, fps = 30): string {
  const totalFrames = Math.round((ms / 1000) * fps);
  const ff = totalFrames % fps;
  const totalSec = Math.floor(totalFrames / fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}:${pad(ff)}`;
}

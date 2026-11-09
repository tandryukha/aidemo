import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import type { StoreImagePreset, StoreVideoPreset } from "./presets.js";

/**
 * Store-spec validation. Pure checks over ffprobe JSON / PNG headers so the
 * rules are unit-tested without ffmpeg, plus thin probe wrappers. A store
 * upload that fails here would be rejected by App Store Connect or Play
 * Console — `store-video` / `store-screenshots` throw on any error.
 */

export interface SpecReport {
  file: string;
  preset: string;
  errors: string[];
  warnings: string[];
  facts: Record<string, string | number>;
}

export class StoreSpecError extends Error {
  constructor(readonly report: SpecReport) {
    super(
      `${report.file} fails the ${report.preset} spec:\n` + report.errors.map((e) => `  - ${e}`).join("\n")
    );
  }
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  pix_fmt?: string;
  field_order?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: Record<string, number>;
}
export interface ProbeJson {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string; bit_rate?: string; format_name?: string };
}

function rate(r?: string): number {
  if (!r) return NaN;
  const [n, d] = r.split("/").map(Number);
  return d ? n / d : n;
}

/** Check a probed video against a store preset. */
export function checkStoreVideo(probe: ProbeJson, preset: StoreVideoPreset, file = "video"): SpecReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const facts: Record<string, string | number> = {};
  const streams = probe.streams ?? [];
  const video = streams.filter((s) => s.codec_type === "video");
  const audio = streams.filter((s) => s.codec_type === "audio");
  if (video.length !== 1) errors.push(`expected exactly 1 video stream, found ${video.length}`);
  const v = video[0];
  if (v) {
    facts.codec = v.codec_name ?? "?";
    facts.size = `${v.width}x${v.height}`;
    facts.profile = v.profile ?? "?";
    facts.level = v.level ?? 0;
    facts.pixFmt = v.pix_fmt ?? "?";
    if (v.codec_name !== "h264") errors.push(`video codec ${v.codec_name} — must be H.264`);
    if (v.width !== preset.width || v.height !== preset.height)
      errors.push(`video is ${v.width}x${v.height} — must be exactly ${preset.width}x${preset.height}`);
    if (v.pix_fmt !== "yuv420p") errors.push(`pixel format ${v.pix_fmt} — must be yuv420p`);
    if (v.profile && !/^(high|main|constrained baseline|baseline)$/i.test(v.profile))
      errors.push(`H.264 profile ${v.profile} — must be High or lower`);
    if (typeof v.level === "number" && v.level > preset.maxLevel)
      errors.push(`H.264 level ${v.level / 10} — must be ≤ ${preset.maxLevel / 10}`);
    if (v.field_order && !/^(progressive|unknown)$/.test(v.field_order))
      errors.push(`interlaced (${v.field_order}) — must be progressive`);
    const r = rate(v.r_frame_rate);
    const avg = rate(v.avg_frame_rate);
    facts.fps = Number.isFinite(avg) ? Math.round(avg * 1000) / 1000 : r;
    if (!(Math.abs(r - preset.fps) < 0.01)) errors.push(`frame rate ${v.r_frame_rate} — must be ${preset.fps} fps CFR`);
    else if (Number.isFinite(avg) && Math.abs(avg - preset.fps) > 0.1)
      errors.push(`average frame rate ${avg.toFixed(2)} — not constant ${preset.fps} fps`);
  }
  if (audio.length < 1) errors.push("no audio track — both stores' players expect one (a silent stereo AAC track is fine)");
  for (const [i, a] of audio.entries()) {
    if (a.codec_name !== "aac") errors.push(`audio track ${i}: codec ${a.codec_name} — must be AAC`);
    if (a.channels !== 2) errors.push(`audio track ${i}: ${a.channels} channel(s) — must be stereo`);
    const sr = Number(a.sample_rate);
    if (sr !== 44100 && sr !== 48000) errors.push(`audio track ${i}: ${sr} Hz — must be 44.1 or 48 kHz`);
    if (a.disposition && a.disposition.default === 0 && audio.length === 1 && preset.store === "app-store")
      warnings.push("the only audio track is not marked default");
  }
  const durSec = Number(probe.format?.duration ?? NaN);
  facts.durationSec = Math.round(durSec * 100) / 100;
  if (!Number.isFinite(durSec)) errors.push("unknown duration");
  else {
    if (preset.minSec != null && durSec < preset.minSec - 0.01)
      errors.push(`duration ${durSec.toFixed(2)} s — must be at least ${preset.minSec} s`);
    if (preset.maxSec != null && durSec > preset.maxSec + 0.01)
      errors.push(`duration ${durSec.toFixed(2)} s — must be at most ${preset.maxSec} s`);
    if (preset.recommendMinSec != null && durSec < preset.recommendMinSec)
      warnings.push(`duration ${durSec.toFixed(1)} s is under the recommended ${preset.recommendMinSec} s`);
    if (preset.recommendMaxSec != null && durSec > preset.recommendMaxSec)
      warnings.push(`duration ${durSec.toFixed(1)} s is over the recommended ${preset.recommendMaxSec} s`);
  }
  const bytes = Number(probe.format?.size ?? NaN);
  facts.bytes = bytes;
  if (Number.isFinite(bytes) && bytes > preset.maxBytes)
    errors.push(`file is ${(bytes / 1048576).toFixed(1)} MB — limit ${(preset.maxBytes / 1048576).toFixed(0)} MB`);
  return { file, preset: preset.id, errors, warnings, facts };
}

/** PNG header facts (IHDR). JPEG returns its SOF dimensions with colorType "jpeg". */
export interface ImageHeader {
  format: "png" | "jpeg";
  width: number;
  height: number;
  /** PNG colour type: 2 = RGB, 6 = RGBA, 4 = grey+alpha, 3 = palette. */
  colorType?: number;
  bitDepth?: number;
  hasAlpha: boolean;
}

export function readImageHeader(buf: Buffer): ImageHeader {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const bitDepth = buf[24];
    const colorType = buf[25];
    // Palette PNGs carry alpha in a tRNS chunk.
    const hasAlpha = colorType === 4 || colorType === 6 || (colorType === 3 && buf.includes(Buffer.from("tRNS")));
    return { format: "png", width, height, colorType, bitDepth, hasAlpha };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), hasAlpha: false };
      }
      i += 2 + len;
    }
  }
  throw new Error("not a PNG or JPEG");
}

export function checkStoreImage(
  header: ImageHeader,
  bytes: number,
  preset: StoreImagePreset,
  file = "image"
): SpecReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const facts: Record<string, string | number> = {
    size: `${header.width}x${header.height}`,
    format: header.format,
    bytes,
  };
  if (header.width !== preset.width || header.height !== preset.height)
    errors.push(`image is ${header.width}x${header.height} — must be exactly ${preset.width}x${preset.height}`);
  if (header.hasAlpha) errors.push("image has an alpha channel — stores require opaque RGB");
  if (header.format === "png" && header.bitDepth !== 8) errors.push(`PNG bit depth ${header.bitDepth} — must be 8 (24-bit RGB)`);
  if (bytes > preset.maxBytes)
    errors.push(`file is ${(bytes / 1048576).toFixed(1)} MB — limit ${(preset.maxBytes / 1048576).toFixed(0)} MB`);
  const long = Math.max(header.width, header.height);
  const short = Math.min(header.width, header.height);
  if (preset.store === "google-play" && preset.id !== "play-feature-graphic") {
    if (short < 320 || long > 3840) errors.push("Play screenshots must be 320–3840 px per side");
    if (long > 2 * short) errors.push("Play screenshots: the long side may be at most twice the short side");
  }
  return { file, preset: preset.id, errors, warnings, facts };
}

export function ffprobeJson(file: string): Promise<ProbeJson> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe ${file} exited ${code}: ${err.trim()}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export async function validateStoreVideoFile(file: string, preset: StoreVideoPreset): Promise<SpecReport> {
  return checkStoreVideo(await ffprobeJson(file), preset, file);
}

export async function validateStoreImageFile(file: string, preset: StoreImagePreset): Promise<SpecReport> {
  const buf = await fs.readFile(file);
  return checkStoreImage(readImageHeader(buf), buf.length, preset, file);
}

/** Throw a StoreSpecError when the report has errors. */
export function assertSpec(report: SpecReport): SpecReport {
  if (report.errors.length) throw new StoreSpecError(report);
  return report;
}

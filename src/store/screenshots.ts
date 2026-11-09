import { promises as fs } from "node:fs";
import type { Project } from "../project.js";
import { runFfmpeg } from "../ffmpeg.js";
import type { StoreScreenshotPresetId, StoreShot } from "../types.js";
import { ensureDir, log, ok, step, writeJson } from "../util.js";
import { PLAY_FEATURE_GRAPHIC, storeImagePreset, type StoreImagePreset } from "./presets.js";
import { loadNativeTimeline, loadStoreProject, localized, resolveIn, storePaths } from "./project.js";
import {
  brandCss,
  dataUri,
  featureGraphicHtml,
  Rasterizer,
  screenshotHtml,
  shotLayout,
  toOpaqueRgbPng,
} from "./render-html.js";
import { readImageHeader, StoreSpecError, validateStoreImageFile, type SpecReport } from "./validate.js";
import { frameTime } from "./plan.js";

/**
 * `store-screenshots`: raw device frames → store screenshot sets. Each shot
 * gets a headline (≤ 5 words reads at search size), and a device frame big
 * enough — or bleeding off the edge — that the UI text stays readable when the
 * store shrinks the image to a search-result thumbnail. Fonts and colours come
 * from `brand`; text is data, so a locale is `--lang xx` with `localized`.
 * Every file is checked against the preset (exact size, opaque RGB, byte cap).
 */

export interface StoreScreenshotOptions {
  presets?: StoreScreenshotPresetId[];
  lang?: string;
}

export interface ShotResult {
  preset: string;
  id: string;
  file: string;
  screenFraction: number;
  uiScale: number;
  report: SpecReport;
}

/** Below this share of the canvas width the UI text turns to mush in search results. */
export const MIN_SCREEN_FRACTION = 0.7;

async function rawFrame(
  project: Project,
  src: { frame?: string; still?: string; fromScene?: { scene: string; atMs?: number; label?: string; command?: string; afterMs?: number } },
  id: string
): Promise<string> {
  const paths = storePaths(project);
  if (src.frame) return resolveIn(project, src.frame);
  if (src.still) {
    const p = paths.still(src.still);
    try {
      await fs.access(p);
    } catch {
      throw new Error(`still "${src.still}" not captured yet — run \`aidemo native-record <dir>\` (scene with still: "${src.still}")`);
    }
    return p;
  }
  const fs0 = src.fromScene!;
  const timeline = await loadNativeTimeline(project);
  const rec = timeline?.scenes.find((s) => s.id === fs0.scene);
  if (!rec) throw new Error(`shot "${id}": scene "${fs0.scene}" has no clip — run native-record first`);
  const out = paths.tmp(`frame-${id}.png`);
  const atMs = frameTime(fs0, rec.marks, fs0.scene, rec.durationMs || undefined);
  await runFfmpeg(["-ss", (atMs / 1000).toFixed(3), "-i", rec.clip, "-frames:v", "1", "-update", "1", out]);
  return out;
}

export async function storeScreenshots(project: Project, opts: StoreScreenshotOptions = {}): Promise<ShotResult[]> {
  const store = await loadStoreProject(project);
  const cfg = store.screenshots;
  if (!cfg) throw new Error("store.json has no `screenshots` section");
  const paths = storePaths(project);
  const lang = opts.lang;
  const presetIds = opts.presets?.length ? opts.presets : (cfg.presets ?? ["ios-6.9", "play-phone"]);
  const brand = await brandCss(store.brand, (p) => resolveIn(project, p));
  const raster = new Rasterizer();
  const results: ShotResult[] = [];
  await ensureDir(paths.tmpDir);
  try {
    // Resolve every raw frame once.
    const frames = new Map<string, { path: string; uri: string; w: number; h: number }>();
    for (const shot of cfg.shots) {
      const path = await rawFrame(project, shot, shot.id);
      const h = readImageHeader(await fs.readFile(path));
      frames.set(shot.id, { path, uri: await dataUri(path), w: h.width, h: h.height });
    }
    for (const pid of presetIds) {
      const preset = storeImagePreset(pid);
      const dir = paths.shotsDir(pid, lang);
      await fs.rm(dir, { recursive: true, force: true });
      await ensureDir(dir);
      step(`${pid}: ${preset.width}x${preset.height}, ${cfg.shots.length} shots`);
      for (const [i, shot] of cfg.shots.entries()) {
        results.push(await renderShot(raster, brand, preset, shot, frames.get(shot.id)!, dir, i, paths.tmp(`${pid}-${shot.id}.png`), lang));
      }
    }
    if (cfg.featureGraphic) {
      const fg = cfg.featureGraphic;
      const dir = paths.shotsDir(PLAY_FEATURE_GRAPHIC.id, lang);
      await ensureDir(dir);
      let frame: { uri: string; w: number; h: number } | undefined;
      if (fg.frame || fg.still) {
        const p = await rawFrame(project, fg, "feature-graphic");
        const h = readImageHeader(await fs.readFile(p));
        frame = { uri: await dataUri(p), w: h.width, h: h.height };
      }
      const tmp = paths.tmp("feature-graphic.png");
      await raster.render(
        featureGraphicHtml(brand, {
          headline: localized(fg.headline, fg.localized, "headline", lang)!,
          appName: fg.appName ?? store.endCard?.appName,
          iconUri: fg.icon ? await dataUri(resolveIn(project, fg.icon)) : store.endCard?.icon ? await dataUri(resolveIn(project, store.endCard.icon)) : undefined,
          frameUri: frame?.uri,
          rawW: frame?.w,
          rawH: frame?.h,
        }),
        PLAY_FEATURE_GRAPHIC.width,
        PLAY_FEATURE_GRAPHIC.height,
        tmp
      );
      const file = `${dir}/feature-graphic.png`;
      await toOpaqueRgbPng(tmp, file);
      const report = await validateStoreImageFile(file, PLAY_FEATURE_GRAPHIC);
      if (report.errors.length) throw new StoreSpecError(report);
      ok(`feature graphic → ${file}`);
      results.push({ preset: PLAY_FEATURE_GRAPHIC.id, id: "feature-graphic", file, screenFraction: 0, uiScale: 0, report });
    }
  } finally {
    await raster.close();
    if (!process.env.AIDEMO_KEEP_TMP) await fs.rm(paths.tmpDir, { recursive: true, force: true });
  }
  await writeJson(`${paths.outDir}/screenshots/report${lang ? `.${lang}` : ""}.json`, results);
  return results;
}

async function renderShot(
  raster: Rasterizer,
  brand: Awaited<ReturnType<typeof brandCss>>,
  preset: StoreImagePreset,
  shot: StoreShot,
  frame: { uri: string; w: number; h: number },
  dir: string,
  index: number,
  tmp: string,
  lang?: string
): Promise<ShotResult> {
  const device = shot.device ?? preset.device;
  const L = shotLayout(preset.width, preset.height, frame.w, frame.h, {
    zoom: shot.zoom,
    bleed: shot.bleed,
    device,
    cropTop: shot.cropTop,
  });
  await raster.render(
    screenshotHtml(brand, L, {
      headline: localized(shot.headline, shot.localized, "headline", lang)!,
      subhead: localized(shot.subhead, shot.localized, "subhead", lang),
      frameUri: frame.uri,
      device,
      rawH: frame.h,
    }),
    preset.width,
    preset.height,
    tmp
  );
  const file = `${dir}/${String(index + 1).padStart(2, "0")}-${shot.id}.png`;
  await toOpaqueRgbPng(tmp, file);
  const report = await validateStoreImageFile(file, preset);
  if (L.screenFraction < MIN_SCREEN_FRACTION)
    report.warnings.push(
      `the screen fills ${(L.screenFraction * 100).toFixed(0)}% of the width — under ${MIN_SCREEN_FRACTION * 100}% its text is unreadable in search results (raise zoom)`
    );
  const words = (localized(shot.headline, shot.localized, "headline", lang) ?? "").replace(/\*/g, "").trim().split(/\s+/).length;
  if (words > 5) report.warnings.push(`headline has ${words} words — 5 or fewer read at search size`);
  for (const w of report.warnings) log(`⚠ ${preset.id}/${shot.id}: ${w}`);
  if (report.errors.length) throw new StoreSpecError(report);
  ok(`${preset.id}/${shot.id} → ${file}`);
  return { preset: preset.id, id: shot.id, file, screenFraction: L.screenFraction, uiScale: L.uiScale, report };
}

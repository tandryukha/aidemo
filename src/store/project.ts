import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Project } from "../project.js";
import { NativeTimelineSchema, StoreProjectSchema, type NativeTimeline, type StoreProject } from "../types.js";
import { log, readJson } from "../util.js";

/**
 * Store-media artifact layout inside a demo dir:
 *
 *   generated/store.json            the store project (scenes → Maestro flows, captions, shots)
 *   generated/native-timeline.json  written by native-record (clips + command marks)
 *   recordings/native/<scene>.mp4   one clip per scene
 *   recordings/native/stills/*.png  full-resolution device screenshots
 *   output/store/<preset>[.<lang>].mp4 (+ .poster.png, .report.json)
 *   output/store/screenshots/<preset>[.<lang>]/<id>.png
 */
export const storePaths = (project: Project) => ({
  store: project.p("generated", "store.json"),
  timeline: project.p("generated", "native-timeline.json"),
  nativeDir: project.p("recordings", "native"),
  clip: (id: string) => project.p("recordings", "native", `${id}.mp4`),
  stillsDir: project.p("recordings", "native", "stills"),
  still: (name: string) => project.p("recordings", "native", "stills", `${name}.png`),
  debugDir: (id: string) => project.p("logs", "maestro", id),
  outDir: project.p("output", "store"),
  video: (preset: string, lang?: string) => project.p("output", "store", `${preset}${lang ? `.${lang}` : ""}.mp4`),
  shotsDir: (preset: string, lang?: string) =>
    project.p("output", "store", "screenshots", `${preset}${lang ? `.${lang}` : ""}`),
  tmp: (name: string) => project.p(".store-tmp", name),
  tmpDir: project.p(".store-tmp"),
});

export function resolveIn(project: Project, path: string): string {
  return isAbsolute(path) ? path : resolve(project.dir, path);
}

export interface StoreIssue {
  path: string;
  message: string;
}

/** Schema + cross-reference checks (files exist, ids unique, shot sources resolve). */
export function checkStoreProject(
  raw: unknown,
  project: Project
): { ok: true; store: StoreProject; warnings: StoreIssue[] } | { ok: false; issues: StoreIssue[]; warnings: StoreIssue[] } {
  const parsed = StoreProjectSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      warnings: [],
    };
  }
  const s = parsed.data;
  const issues: StoreIssue[] = [];
  const warnings: StoreIssue[] = [];
  const ids = new Set<string>();
  const stills = new Set<string>();
  const fileRef = (path: string | undefined, at: string) => {
    if (path && !existsSync(resolveIn(project, path))) issues.push({ path: at, message: `file not found: ${path}` });
  };
  fileRef(s.setup, "setup");
  s.scenes.forEach((sc, i) => {
    if (ids.has(sc.id)) issues.push({ path: `scenes.${i}.id`, message: `duplicate scene id "${sc.id}"` });
    ids.add(sc.id);
    if (sc.still) {
      if (stills.has(sc.still)) issues.push({ path: `scenes.${i}.still`, message: `duplicate still name "${sc.still}"` });
      stills.add(sc.still);
    }
    fileRef(sc.flow, `scenes.${i}.flow`);
    fileRef(sc.setup, `scenes.${i}.setup`);
    fileRef(sc.clip, `scenes.${i}.clip`);
    if (sc.steps?.length && s.device.platform === "ios" && sc.steps.some((st) => ["tap", "swipe", "text"].includes(st.op)))
      warnings.push({
        path: `scenes.${i}.steps`,
        message: "iOS tap/swipe/text steps need idb at record time — a Maestro `flow` is the portable choice",
      });
  });
  if (s.endCard?.icon) fileRef(s.endCard.icon, "endCard.icon");
  if (s.brand?.fontFile) fileRef(s.brand.fontFile, "brand.fontFile");
  s.screenshots?.shots.forEach((sh, i) => {
    fileRef(sh.frame, `screenshots.shots.${i}.frame`);
    if (sh.still && !stills.has(sh.still) && !existsSync(project.p("recordings", "native", "stills", `${sh.still}.png`)))
      issues.push({ path: `screenshots.shots.${i}.still`, message: `no scene declares still "${sh.still}"` });
    if (sh.fromScene && !ids.has(sh.fromScene.scene))
      issues.push({ path: `screenshots.shots.${i}.fromScene.scene`, message: `unknown scene "${sh.fromScene.scene}"` });
  });
  const fg = s.screenshots?.featureGraphic;
  if (fg) {
    fileRef(fg.frame, "screenshots.featureGraphic.frame");
    fileRef(fg.icon, "screenshots.featureGraphic.icon");
  }
  return issues.length ? { ok: false, issues, warnings } : { ok: true, store: s, warnings };
}

export async function loadStoreProject(project: Project): Promise<StoreProject> {
  const p = storePaths(project).store;
  if (!existsSync(p)) throw new Error(`no store project at ${p} — see \`aidemo guide --topic store\``);
  const res = checkStoreProject(await readJson<unknown>(p), project);
  for (const w of res.warnings) log(`⚠ store.json ${w.path}: ${w.message}`);
  if (!res.ok)
    throw new Error(`Invalid store.json:\n${res.issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`);
  return res.store;
}

export async function loadNativeTimeline(project: Project): Promise<NativeTimeline | null> {
  const p = storePaths(project).timeline;
  if (!existsSync(p)) return null;
  return NativeTimelineSchema.parse(await readJson<unknown>(p));
}

/** The text for `field` in `lang`, falling back to the base text. */
export function localized(
  base: string | undefined,
  table: Record<string, Record<string, string | undefined>> | undefined,
  field: "caption" | "headline" | "subhead" | "line",
  lang?: string
): string | undefined {
  if (lang && table?.[lang]?.[field] != null) return table[lang][field];
  return base;
}

import { resolve, isAbsolute } from "node:path";
import { StoryboardSchema, type Storyboard } from "./types.js";
import { applyParams } from "./params.js";
import { ensureDir, exists, readJson, writeJson, log } from "./util.js";

/**
 * Resolves and creates the standard artifact layout for one demo project.
 *
 *   <dir>/
 *     input/brief.md
 *     generated/storyboard.json  timeline.json  captions.srt  captions.vtt
 *     recordings/raw.webm
 *     audio/scene-*.mp3  narration.mp3  voice.json
 *     output/final-demo.mp4
 *     logs/
 */
export class Project {
  readonly dir: string;
  /**
   * Optional language code for a multi-language render (see src/i18n.ts). When
   * set, the per-LANGUAGE artifacts move under a language namespace so they
   * don't clobber the default: audio → audio/<lang>/, captions →
   * captions.<lang>.*, output → final-demo.<lang>.mp4. The SHARED take
   * (recordings/raw.*, generated/timeline.json, generated/storyboard.json) is
   * language-independent and stays put — that's what lets one recording feed N
   * language renders. Unset → byte-for-byte the original single-language layout.
   */
  readonly lang?: string;
  constructor(dir: string, lang?: string) {
    this.dir = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
    this.lang = lang || undefined;
  }

  p(...parts: string[]): string {
    return resolve(this.dir, ...parts);
  }

  /** Language-scoped audio dir (audio/<lang>/ for a variant; audio/ by default). */
  private audioDir(): string {
    return this.lang ? this.p("audio", this.lang) : this.p("audio");
  }

  /** captions.<lang>.<ext> for a variant; captions.<ext> by default. */
  private captionPath(ext: string): string {
    return this.p("generated", this.lang ? `captions.${this.lang}.${ext}` : `captions.${ext}`);
  }

  get storyboardPath() {
    return this.p("generated", "storyboard.json");
  }
  get timelinePath() {
    return this.p("generated", "timeline.json");
  }
  /**
   * Resolved template params of the last load are persisted here so a later
   * stage-only re-run (e.g. `aidemo compose <dir>` after a parameterized record)
   * reuses the SAME values — keeping narration, captions and the take in sync.
   */
  get paramsPath() {
    return this.p("generated", "params.json");
  }
  get captionsSrtPath() {
    return this.captionPath("srt");
  }
  get captionsVttPath() {
    return this.captionPath("vtt");
  }
  get captionsCuesPath() {
    return this.captionPath("cues.json");
  }
  /** Caption reuse manifest (per-scene input hashes + stored word timings). */
  get captionsManifestPath() {
    return this.p("generated", "captions.manifest.json");
  }
  /** Checked-in golden baseline for `aidemo probe --golden` regression checks. */
  get goldenProbePath() {
    return this.p("golden", "probe.json");
  }
  get rawVideoPath() {
    return this.p("recordings", "raw.webm");
  }
  /** Native/OBS captures are transcoded here (Playwright records .webm). */
  get rawVideoMp4Path() {
    return this.p("recordings", "raw.mp4");
  }
  /**
   * One preserved previous-take generation: `record` rotates the existing
   * take (raw video + timeline) to these paths instead of deleting it, so a
   * bad new take never destroys the last good one. Roll back by copying the
   * .prev files over the current ones.
   */
  get rawVideoPrevPath() {
    return this.p("recordings", "raw.prev.webm");
  }
  get rawVideoMp4PrevPath() {
    return this.p("recordings", "raw.prev.mp4");
  }
  get timelinePrevPath() {
    return this.p("generated", "timeline.prev.json");
  }
  /** The raw recording to compose from, whichever capture path produced it. */
  async resolveRawVideo(): Promise<string> {
    return (await exists(this.rawVideoMp4Path))
      ? this.rawVideoMp4Path
      : this.rawVideoPath;
  }
  get narrationPath() {
    return resolve(this.audioDir(), "narration.mp3");
  }
  get voiceManifestPath() {
    return resolve(this.audioDir(), "voice.json");
  }
  sceneAudioPath(id: string) {
    return resolve(this.audioDir(), `scene-${id}.mp3`);
  }
  get outputPath() {
    return this.p("output", this.lang ? `final-demo.${this.lang}.mp4` : "final-demo.mp4");
  }
  get gifPath() {
    return this.p("output", this.lang ? `final-demo.${this.lang}.gif` : "final-demo.gif");
  }
  /** Directory for screenshot-mode stills (one PNG per named `still` marker). */
  get stillsDir() {
    return this.p("output", "stills");
  }
  get composeTmpDir() {
    return this.p(this.lang ? `.compose-tmp-${this.lang}` : ".compose-tmp");
  }
  get gifTmpDir() {
    return this.p(".gif-tmp");
  }

  async ensureDirs(): Promise<void> {
    for (const d of [
      "input",
      "generated",
      "recordings",
      "audio",
      "output",
      "logs",
    ]) {
      await ensureDir(this.p(d));
    }
    // Language-scoped audio lives in a per-lang subdir (audio/<lang>/).
    if (this.lang) await ensureDir(this.audioDir());
  }

  /**
   * Load + validate the storyboard. `relaxed` (for `aidemo probe`) makes
   * narration optional — a record-only dry run to verify selectors/timing
   * doesn't need a script — by injecting an empty narration where missing
   * before validating against the one schema.
   *
   * `params` are explicit template overrides (CLI `--param`, MCP `params`,
   * variant params); they take precedence and are typo-guarded. When none are
   * given, the last run's persisted params (generated/params.json) are reused
   * so stage-only re-runs stay consistent. The resolved set is persisted here.
   */
  async loadStoryboard(
    opts: { relaxed?: boolean; params?: Record<string, string> } = {}
  ): Promise<Storyboard> {
    const raw = await readJson<unknown>(this.storyboardPath);
    const explicit =
      opts.params && Object.keys(opts.params).length ? opts.params : undefined;
    const provided = explicit ?? (await this.readPersistedParams());
    const parsed = parseStoryboard(raw, {
      relaxed: opts.relaxed,
      params: provided,
      // Typo-guard only explicit user input; persisted params are filtered.
      strict: explicit != null,
    });
    if (!parsed.ok) {
      throw new Error(
        `Invalid storyboard.json:\n${parsed.issues
          .map((i) => `  - ${i.path}: ${i.message}`)
          .join("\n")}`
      );
    }
    for (const w of parsed.warnings) log(w);
    if (Object.keys(parsed.resolved).length) {
      await this.persistParams(parsed.resolved);
    }
    return parsed.storyboard;
  }

  /** Last run's resolved template params, or undefined if none were persisted. */
  async readPersistedParams(): Promise<Record<string, string> | undefined> {
    if (!(await exists(this.paramsPath))) return undefined;
    try {
      const data = await readJson<{ params?: Record<string, string> }>(
        this.paramsPath
      );
      return data && typeof data.params === "object" ? data.params : undefined;
    } catch {
      return undefined;
    }
  }

  /** Persist the resolved template params for later stage-only re-runs. */
  async persistParams(resolved: Record<string, string>): Promise<void> {
    await ensureDir(this.p("generated"));
    await writeJson(this.paramsPath, { params: resolved });
  }
}

export interface StoryboardIssue {
  path: string;
  message: string;
  code: string;
}

export type StoryboardParse =
  | {
      ok: true;
      storyboard: Storyboard;
      /** Resolved template params after applying declared defaults + overrides. */
      resolved: Record<string, string>;
      warnings: string[];
    }
  | { ok: false; issues: StoryboardIssue[] };

/**
 * Validate a raw storyboard value against the schema, returning structured
 * issues instead of throwing. `relaxed` (probe) makes narration optional by
 * injecting an empty one where missing before validating — a record-only dry
 * run doesn't need a script.
 *
 * `params` are template overrides; substitution runs AFTER zod validation on
 * the typed storyboard (so placeholders only reach string fields) and reports
 * unresolved/undeclared placeholders as a `params` issue.
 */
export function parseStoryboard(
  raw: unknown,
  opts: { relaxed?: boolean; params?: Record<string, string>; strict?: boolean } = {}
): StoryboardParse {
  if (
    opts.relaxed &&
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { scenes?: unknown }).scenes)
  ) {
    for (const s of (raw as { scenes: Array<Record<string, unknown>> }).scenes) {
      if (s && typeof s === "object" && s.narration == null) s.narration = "";
    }
  }
  const parsed = StoryboardSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        code: i.code,
      })),
    };
  }
  // Resolve + substitute {{template}} params on the typed storyboard.
  const applied = applyParams(parsed.data, {
    provided: opts.params,
    strict: opts.strict,
  });
  if (!applied.ok) {
    return {
      ok: false,
      issues: [{ path: "params", message: applied.message, code: "params" }],
    };
  }
  return {
    ok: true,
    storyboard: applied.storyboard,
    resolved: applied.resolved,
    warnings: storyboardWarnings(applied.storyboard),
  };
}

/** Surface silent no-ops in the storyboard so they aren't a surprise. */
export function storyboardWarnings(sb: Storyboard): string[] {
  const warnings: string[] = [];
  const withCue = sb.scenes.filter((s) => s.music?.cue).map((s) => s.id);
  if (withCue.length) {
    warnings.push(
      `⚠ per-scene music.cue is informational only and currently ignored ` +
        `(scenes: ${withCue.join(", ")})`
    );
  }
  return warnings;
}

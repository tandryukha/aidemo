import { resolve, isAbsolute } from "node:path";
import { StoryboardSchema, type Storyboard } from "./types.js";
import { ensureDir, exists, readJson, log } from "./util.js";

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
  constructor(dir: string) {
    this.dir = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  }

  p(...parts: string[]): string {
    return resolve(this.dir, ...parts);
  }

  get storyboardPath() {
    return this.p("generated", "storyboard.json");
  }
  get timelinePath() {
    return this.p("generated", "timeline.json");
  }
  get captionsSrtPath() {
    return this.p("generated", "captions.srt");
  }
  get captionsVttPath() {
    return this.p("generated", "captions.vtt");
  }
  get captionsCuesPath() {
    return this.p("generated", "captions.cues.json");
  }
  get rawVideoPath() {
    return this.p("recordings", "raw.webm");
  }
  /** Native/OBS captures are transcoded here (Playwright records .webm). */
  get rawVideoMp4Path() {
    return this.p("recordings", "raw.mp4");
  }
  /** The raw recording to compose from, whichever capture path produced it. */
  async resolveRawVideo(): Promise<string> {
    return (await exists(this.rawVideoMp4Path))
      ? this.rawVideoMp4Path
      : this.rawVideoPath;
  }
  get narrationPath() {
    return this.p("audio", "narration.mp3");
  }
  get voiceManifestPath() {
    return this.p("audio", "voice.json");
  }
  sceneAudioPath(id: string) {
    return this.p("audio", `scene-${id}.mp3`);
  }
  get outputPath() {
    return this.p("output", "final-demo.mp4");
  }
  get composeTmpDir() {
    return this.p(".compose-tmp");
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
  }

  /**
   * Load + validate the storyboard. `relaxed` (for `aidemo probe`) makes
   * narration optional — a record-only dry run to verify selectors/timing
   * doesn't need a script — by injecting an empty narration where missing
   * before validating against the one schema.
   */
  async loadStoryboard(opts: { relaxed?: boolean } = {}): Promise<Storyboard> {
    const raw = await readJson<unknown>(this.storyboardPath);
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
      throw new Error(
        `Invalid storyboard.json:\n${parsed.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n")}`
      );
    }
    warnStoryboard(parsed.data);
    return parsed.data;
  }
}

/** Surface silent no-ops in the storyboard so they aren't a surprise. */
function warnStoryboard(sb: Storyboard): void {
  const withCue = sb.scenes.filter((s) => s.music?.cue).map((s) => s.id);
  if (withCue.length) {
    log(
      `⚠ per-scene music.cue is informational only and currently ignored ` +
        `(scenes: ${withCue.join(", ")})`
    );
  }
}

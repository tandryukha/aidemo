import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { Project } from "./project.js";
import {
  requireOpenAiKey,
  openAiBaseUrl,
  STT_MODEL,
  explainAudioEndpointError,
} from "./config.js";
import {
  VoiceManifestSchema,
  CaptionsManifestSchema,
  type CaptionsManifest,
  type Storyboard,
} from "./types.js";
import { resolveNarrationLanguage } from "./i18n.js";
import {
  srtTime,
  readJson,
  writeJson,
  exists,
  ok,
  step,
  log,
  type SceneProgress,
} from "./util.js";

export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

interface Word {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

const MAX_WORDS = 6;
const MAX_CUE_MS = 3000;

/** Whisper's `prompt` is only used to bias roughly its first ~224 tokens of
 *  context; cap what we send so a long demo's script doesn't balloon the
 *  request for no benefit beyond that window. */
const MAX_PROMPT_CHARS = 900;

/** Explicit per-run STT overrides (CLI `--stt-lang`, future MCP param) plus
 *  the shared per-scene progress hooks. */
export interface CaptionsSttOptions extends SceneProgress {
  /** ISO-639-1/BCP-47 language hint for Whisper, overriding --lang / storyboard.language. */
  language?: string;
}

/**
 * Transcribes the composed narration track with word-level timestamps and
 * writes captions.srt + captions.vtt + captions.cues.json. Using the real audio
 * (not the script) means caption timing matches the actual voiceover.
 *
 * When `storyboard` is given (the already-localized storyboard for this
 * render), the request is biased toward the known script: the narration text
 * is sent as Whisper's `prompt` (nudges the transcript to converge on the
 * scripted words/spelling instead of guessing from audio alone — this is the
 * fix for non-English narration getting mangled, e.g. Estonian "algab"
 * transcribed as "aldab") and a language hint is sent when known (an active
 * `--lang` render, `opts.language`, or the storyboard's own `language`
 * field). See docs/AUTHORING.md "Captions: Whisper STT vs. offline".
 *
 * This path is a single Whisper/STT call, not a per-scene loop — so progress
 * is coarse (best-effort): `onSceneStart` fires once up-front with the full
 * scene count (so a poller at least sees scenesTotal), and `onSceneComplete`
 * fires once per scene, all at once, right after transcription lands.
 */
export async function generateCaptions(
  project: Project,
  storyboard?: Storyboard,
  opts: CaptionsSttOptions = {}
): Promise<void> {
  const base = openAiBaseUrl();
  step(
    base
      ? `Generating captions (STT @ ${base})`
      : "Generating captions (Whisper word timestamps)"
  );

  // Scene boundaries (ms) in the narration track keep a cue from spanning two
  // scenes, so caption breaks line up with the on-screen beats.
  const sceneEnds = await sceneEndTimes(project);
  const ids = await sceneIdsFor(project);
  const total = ids.length || sceneEnds.length;
  const reportDone = () => {
    for (let i = 0; i < total; i++) opts.onSceneComplete?.(ids[i] ?? "", i, total);
  };
  if (total > 0) opts.onSceneStart?.(ids[0] ?? "", 0, total);
  const config = captionConfig(await loadGapMs(project));

  const prompt = storyboard ? buildSttPrompt(storyboard) : undefined;
  const language = opts.language ?? resolveNarrationLanguage(storyboard, project.lang);
  if (language && !/^en\b/i.test(language)) {
    log(
      `⚠ non-English narration ("${language}") — Whisper is biased with the ` +
        `script + language hint, but if burned-in captions still look wrong, ` +
        `\`aidemo captions ${project.dir} --offline\` is the guaranteed-correct ` +
        `fallback (cues derived from the storyboard script, no STT).`
    );
  }

  // Content-hash reuse (mirrors voice.ts): transcription is a pure function of
  // the narration audio + model + endpoint + scene boundaries + grouping config
  // + prompt bias + language hint. Unchanged → reuse the stored cues and skip
  // the Whisper/STT call entirely.
  const model = STT_MODEL();
  const endpoint = base ?? "openai";
  const narrationHash = await fileHash(project.narrationPath);
  const inputHash = hashOf({
    mode: "stt",
    narrationHash,
    model,
    endpoint,
    sceneEnds,
    config,
    prompt,
    language,
  });
  const prior = await readCaptionsManifest(project);
  if (prior && prior.mode === "stt" && prior.inputHash === inputHash) {
    await writeCaptionFiles(project, prior.cues);
    ok(`captions unchanged, reusing (cached; skipped transcription)`);
    reportDone();
    return;
  }

  // Lazy import: the offline path below must work without touching the SDK.
  const { default: OpenAI } = await import("openai");
  // baseURL undefined → api.openai.com; set → any OpenAI-compatible server.
  const client = new OpenAI({ apiKey: requireOpenAiKey(), baseURL: base });

  const res = await client.audio.transcriptions
    .create({
      file: createReadStream(project.narrationPath),
      model,
      response_format: "verbose_json",
      timestamp_granularities: ["word"],
      ...(prompt ? { prompt } : {}),
      ...(language ? { language } : {}),
    })
    .catch((err) => explainAudioEndpointError(err, "stt"));

  const words: Word[] = (res as unknown as { words?: Word[] }).words ?? [];
  if (words.length === 0) {
    log("no word timestamps returned; captions may be empty");
  }
  const cues = groupWords(words, sceneEnds);
  await writeCaptionFiles(project, cues);
  await writeCaptionsManifest(project, { mode: "stt", inputHash, config, cues });
  reportDone();
}

/**
 * Whisper prompt bias: the known narration script, in scene order, so the
 * transcript converges on the correctly-spelled words instead of guessing
 * from audio phonetics alone. Capped to MAX_PROMPT_CHARS (see above).
 */
function buildSttPrompt(storyboard: Storyboard): string | undefined {
  const text = storyboard.scenes
    .map((s) => s.narration.trim())
    .filter(Boolean)
    .join(" ");
  if (!text) return undefined;
  return text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) : text;
}

/**
 * Offline fallback: builds captions from the storyboard script + voice.json
 * timings instead of transcribing the audio — no network, no STT. Timing is
 * exact at scene boundaries (each scene's measured narration duration) but
 * approximate within a scene: words are spread across it proportional to
 * their length, not the actual speech rhythm.
 */
export async function generateCaptionsOffline(
  project: Project,
  storyboard: Storyboard,
  opts: SceneProgress = {}
): Promise<void> {
  step("Generating captions (offline, from script + voice.json timings)");
  const voice = VoiceManifestSchema.parse(
    await readJson(project.voiceManifestPath)
  );
  const durById = new Map(voice.scenes.map((s) => [s.id, s.durationMs]));
  const config = captionConfig(voice.gapMs);

  // Per-scene caption identity = narration + this scene's measured duration (+
  // grouping config). The scene-relative word timings depend on nothing else, so
  // a scene whose identity is unchanged reuses its stored words — only a changed
  // scene is re-derived (mirrors voice.ts's per-scene reuse).
  type SceneMeta = { id: string; hash: string; durationMs: number };
  const meta: SceneMeta[] = storyboard.scenes.map((scene) => {
    const durationMs = durById.get(scene.id);
    if (durationMs == null) {
      throw new Error(
        `voice.json has no scene "${scene.id}" — re-run: aidemo voice ${project.dir}`
      );
    }
    return {
      id: scene.id,
      durationMs,
      hash: hashOf({ narration: scene.narration, durationMs, config }),
    };
  });

  const prior = await readCaptionsManifest(project);
  const priorOffline = prior && prior.mode === "offline" ? prior : null;
  const inputHash = hashOf({ mode: "offline", config, meta });
  const total = meta.length;

  // Fast path: every scene identical → reuse the stored cues verbatim, no
  // derivation at all. This is the "cached; skipped transcription" 2nd-run case.
  if (priorOffline && priorOffline.inputHash === inputHash) {
    await writeCaptionFiles(project, priorOffline.cues);
    ok(`captions unchanged, reusing (cached; skipped transcription)`);
    meta.forEach((m, i) => opts.onSceneComplete?.(m.id, i, total));
    return;
  }

  const priorById = new Map(
    (priorOffline?.scenes ?? []).map((s) => [s.id, s])
  );
  const narrationById = new Map(
    storyboard.scenes.map((s) => [s.id, s.narration])
  );

  const manifestScenes: NonNullable<CaptionsManifest["scenes"]> = [];
  let derived = 0;
  let reused = 0;
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i];
    opts.onSceneStart?.(m.id, i, total);
    const prev = priorById.get(m.id);
    if (prev && prev.hash === m.hash) {
      manifestScenes.push({ ...m, words: prev.words });
      log(`scene ${m.id}: unchanged, reusing caption timing`);
      reused++;
    } else {
      const words = deriveSceneWords(narrationById.get(m.id) ?? "", m.durationMs);
      manifestScenes.push({ ...m, words });
      log(`scene ${m.id}: deriving caption timing`);
      derived++;
    }
    opts.onSceneComplete?.(m.id, i, total);
  }

  // Assemble scene-relative words into the absolute narration timeline. Scene
  // durations + gaps come from voice.json, so a change in one scene's duration
  // correctly shifts later scenes without re-deriving their word *content*.
  const words: Word[] = [];
  const sceneEnds: number[] = [];
  let cursor = 0; // ms into the assembled narration track
  for (const s of manifestScenes) {
    for (const w of s.words) {
      words.push({
        word: w.word,
        start: cursor / 1000 + w.start,
        end: cursor / 1000 + w.end,
      });
    }
    cursor += s.durationMs;
    sceneEnds.push(cursor);
    cursor += voice.gapMs;
  }

  const cues = groupWords(words, sceneEnds);
  await writeCaptionFiles(project, cues);
  await writeCaptionsManifest(project, {
    mode: "offline",
    inputHash,
    config,
    scenes: manifestScenes,
    cues,
  });
  log(`captions: ${derived} derived, ${reused} reused`);
}

/**
 * Scene-relative word timings for the offline path: each word starts at 0 within
 * its scene. Weight by length (+1 for the following pause) so long words get
 * proportionally more of the scene's measured duration.
 */
function deriveSceneWords(narration: string, durationMs: number): Word[] {
  const tokens = narration.split(/\s+/).filter(Boolean);
  const weights = tokens.map((t) => t.length + 1);
  const total = weights.reduce((a, w) => a + w, 0) || 1;
  const words: Word[] = [];
  let at = 0; // ms, relative to the scene start
  tokens.forEach((t, i) => {
    const wordMs = (weights[i] / total) * durationMs;
    words.push({ word: t, start: at / 1000, end: (at + wordMs) / 1000 });
    at += wordMs;
  });
  return words;
}

/** Shared tail of both paths — same files, same formats, either way. */
async function writeCaptionFiles(project: Project, cues: Cue[]): Promise<void> {
  await fs.writeFile(project.captionsSrtPath, toSrt(cues));
  await fs.writeFile(project.captionsVttPath, toVtt(cues));
  await writeJson(project.captionsCuesPath, cues);
  ok(`captions → ${project.captionsSrtPath} (${cues.length} cues)`);
  ok(`captions → ${project.captionsCuesPath}`);
}

// ---------------------------------------------------------------------------
// Content-hash reuse (mirrors voice.ts): a caption manifest records the hash of
// every caption-affecting input + the transcription result, so a re-run whose
// inputs are unchanged skips Whisper/local transcription and reuses stored word
// timings. A UI-only re-render (recompose) no longer re-transcribes.
// ---------------------------------------------------------------------------

/** Grouping parameters that affect cue segmentation — part of the cache key. */
function captionConfig(gapMs: number): CaptionsManifest["config"] {
  return { gapMs, maxWords: MAX_WORDS, maxCueMs: MAX_CUE_MS };
}

/** Inter-scene gap from voice.json (0 when absent — captions need voice.json). */
async function loadGapMs(project: Project): Promise<number> {
  if (!(await exists(project.voiceManifestPath))) return 0;
  const v = VoiceManifestSchema.safeParse(
    await readJson(project.voiceManifestPath)
  );
  return v.success ? v.data.gapMs : 0;
}

/** Short stable hash of any JSON-serializable input identity. */
function hashOf(identity: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 16);
}

/** sha256 of a file's bytes — the narration audio's content identity (STT path). */
async function fileHash(path: string): Promise<string> {
  const buf = await fs.readFile(path);
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

async function readCaptionsManifest(
  project: Project
): Promise<CaptionsManifest | null> {
  if (!(await exists(project.captionsManifestPath))) return null;
  const parsed = CaptionsManifestSchema.safeParse(
    await readJson(project.captionsManifestPath)
  );
  return parsed.success ? parsed.data : null;
}

async function writeCaptionsManifest(
  project: Project,
  manifest: CaptionsManifest
): Promise<void> {
  await writeJson(project.captionsManifestPath, manifest);
}

/** Cumulative end time (ms) of each scene's narration in the assembled track. */
async function sceneEndTimes(project: Project): Promise<number[]> {
  if (!(await exists(project.voiceManifestPath))) return [];
  const voice = VoiceManifestSchema.parse(
    await readJson(project.voiceManifestPath)
  );
  const ends: number[] = [];
  let cum = 0;
  for (const s of voice.scenes) {
    cum += s.durationMs;
    ends.push(cum);
    cum += voice.gapMs;
  }
  return ends;
}

/** Scene ids from voice.json, in order — used for the STT path's best-effort
 *  progress reporting (there's no natural per-scene loop, unlike offline). */
async function sceneIdsFor(project: Project): Promise<string[]> {
  if (!(await exists(project.voiceManifestPath))) return [];
  const voice = VoiceManifestSchema.safeParse(
    await readJson(project.voiceManifestPath)
  );
  return voice.success ? voice.data.scenes.map((s) => s.id) : [];
}

function groupWords(words: Word[], sceneEnds: number[]): Cue[] {
  const cues: Cue[] = [];
  let cur: Word[] = [];
  let sceneIdx = 0;
  const flush = () => {
    if (cur.length === 0) return;
    cues.push({
      index: cues.length + 1,
      startMs: Math.round(cur[0].start * 1000),
      endMs: Math.round(cur[cur.length - 1].end * 1000),
      // trim each word: faster-whisper servers pad words with leading spaces
      text: cur.map((w) => w.word.trim()).join(" ").replace(/\s+([,.!?])/g, "$1").trim(),
    });
    cur = [];
  };
  for (const w of words) {
    const startMs = w.start * 1000;
    // Crossed into a later scene? Break the cue there.
    while (
      sceneIdx < sceneEnds.length - 1 &&
      startMs >= sceneEnds[sceneIdx]
    ) {
      flush();
      sceneIdx++;
    }
    cur.push(w);
    const durMs = (w.end - cur[0].start) * 1000;
    const endsSentence = /[.!?]$/.test(w.word.trim());
    if (cur.length >= MAX_WORDS || durMs >= MAX_CUE_MS || endsSentence) flush();
  }
  flush();
  return cues;
}

function toSrt(cues: Cue[]): string {
  return (
    cues
      .map(
        (c) =>
          `${c.index}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${c.text}\n`
      )
      .join("\n") + "\n"
  );
}

function toVtt(cues: Cue[]): string {
  const vt = (ms: number) => srtTime(ms).replace(",", ".");
  return (
    "WEBVTT\n\n" +
    cues.map((c) => `${vt(c.startMs)} --> ${vt(c.endMs)}\n${c.text}\n`).join("\n")
  );
}

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
  type CaptionsConfig,
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

/**
 * Cue-segmentation defaults (issue #48). The old 6-word / 3 s hard cap split
 * half of all cue breaks mid-clause ("…nobody has / filled in a form, and no /
 * account exists yet"), which is harder to read than the narration. Broadcast
 * practice is ~2 lines x ~37 characters, 1–6 s per cue, broken at punctuation
 * or a conjunction. Override per storyboard via the `captions` block.
 */
const DEFAULT_SEG: Required<
  Pick<CaptionsConfig, "maxWords" | "maxCueMs" | "minCueMs" | "maxLines" | "maxCharsPerLine">
> = {
  maxWords: 12,
  maxCueMs: 6000,
  minCueMs: 1000,
  maxLines: 2,
  maxCharsPerLine: 38,
};

/** Conjunctions/discourse markers that make a decent break point, by language. */
const CONJUNCTIONS = new Set([
  // en
  "and", "but", "so", "or", "then", "because", "while", "when", "which", "that", "if",
  // et
  "ja", "aga", "või", "siis", "kui", "sest", "mis", "ning", "kuid",
  // de / nl / sv
  "und", "aber", "oder", "dann", "weil", "wenn", "och", "men", "eller", "en", "maar",
  // fr / es / it / pt
  "et", "mais", "ou", "donc", "parce", "quand", "y", "pero", "o", "entonces", "porque",
  "e", "ma", "oppure", "quindi", "perché", "mas", "então",
]);

type SegConfig = typeof DEFAULT_SEG;

function segConfig(storyboard?: Storyboard): SegConfig {
  return { ...DEFAULT_SEG, ...cleanSeg(storyboard?.captions) };
}

function cleanSeg(c: CaptionsConfig | undefined): Partial<SegConfig> {
  if (!c) return {};
  const out: Partial<SegConfig> = {};
  if (c.maxWords != null) out.maxWords = c.maxWords;
  if (c.maxCueMs != null) out.maxCueMs = c.maxCueMs;
  if (c.minCueMs != null) out.minCueMs = c.minCueMs;
  if (c.maxLines != null) out.maxLines = c.maxLines;
  if (c.maxCharsPerLine != null) out.maxCharsPerLine = c.maxCharsPerLine;
  return out;
}

/** Whisper's `prompt` is only used to bias roughly its first ~224 tokens of
 *  context; cap what we send so a long demo's script doesn't balloon the
 *  request for no benefit beyond that window. */
const MAX_PROMPT_CHARS = 900;

/** Explicit per-run STT overrides (CLI `--stt-lang`, future MCP param) plus
 *  the shared per-scene progress hooks. */
export interface CaptionsSttOptions extends SceneProgress {
  /** ISO-639-1/BCP-47 language hint for Whisper, overriding --lang / storyboard.language. */
  language?: string;
  /** Use storyboard spelling/punctuation while retaining STT word timing. */
  alignScript?: boolean;
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
  const seg = segConfig(storyboard);
  const config = captionConfig(await loadGapMs(project), seg);

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
    ...(opts.alignScript ? { alignScript: true } : {}),
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
  const sceneWords = splitWordsByScene(words, ids, sceneEnds, config.gapMs);
  let captionWords = words;
  if (storyboard && sceneEnds.length === storyboard.scenes.length) {
    const aligned: Word[] = [];
    let sceneStartMs = 0;
    for (let i = 0; i < storyboard.scenes.length; i++) {
      const scene = storyboard.scenes[i];
      const timed = sceneWords[i]?.words ?? [];
      const result = alignCaptionWords(scene.narration, timed, sceneEnds[i] - sceneStartMs);
      if (result.driftPct >= 20) {
        log(`⚠ caption drift in scene ${scene.id}: ${result.driftPct}% of script words differ from STT; ${opts.alignScript ? "script text aligned to STT timing — review against the audio" : "review captions or use --align-script"}`);
      }
      for (const w of result.words) aligned.push({ ...w, start: w.start + sceneStartMs / 1000, end: w.end + sceneStartMs / 1000 });
      sceneStartMs = sceneEnds[i] + config.gapMs;
    }
    if (opts.alignScript) captionWords = aligned;
  } else if (opts.alignScript) {
    throw new Error("--align-script requires a storyboard and matching voice scene timings");
  }
  const cues = groupWords(captionWords, sceneEnds, seg);
  await writeCaptionFiles(project, cues);
  await writeCaptionsManifest(project, {
    mode: "stt",
    inputHash,
    config,
    scenes: opts.alignScript ? splitWordsByScene(captionWords, ids, sceneEnds, config.gapMs) : sceneWords,
    cues,
  });
  reportDone();
}

/**
 * Split an absolute transcript into scene-relative words (for narration
 * anchors and per-scene reuse). Scene i spans [prevEnd + gap, sceneEnds[i]];
 * a word is assigned by its start time.
 */
function splitWordsByScene(
  words: Word[],
  ids: string[],
  sceneEnds: number[],
  gapMs: number
): NonNullable<CaptionsManifest["scenes"]> {
  const out: NonNullable<CaptionsManifest["scenes"]> = [];
  let startMs = 0;
  for (let i = 0; i < sceneEnds.length; i++) {
    const endMs = sceneEnds[i];
    const mine = words
      .filter((w) => {
        const t = w.start * 1000;
        return t >= startMs - 1 && (i === sceneEnds.length - 1 || t < endMs + gapMs / 2);
      })
      .map((w) => ({
        word: w.word.trim(),
        start: Math.max(0, w.start - startMs / 1000),
        end: Math.max(0, w.end - startMs / 1000),
      }));
    out.push({
      id: ids[i] ?? String(i),
      hash: hashOf({ stt: true, startMs, endMs }),
      durationMs: endMs - startMs,
      words: mine,
    });
    startMs = endMs + gapMs;
  }
  return out;
}

/** Align written words to measured STT timestamps. Inserted script words share
 * the space between their nearest timed neighbours; STT-only words are dropped. */
export function alignCaptionWords(
  narration: string,
  spoken: Word[],
  durationMs: number
): { words: Word[]; driftPct: number } {
  const script = narration.split(/\s+/).filter(Boolean);
  if (!script.length) return { words: [], driftPct: spoken.length ? 100 : 0 };
  if (!spoken.length) return { words: deriveSceneWords(narration, durationMs), driftPct: 100 };
  const norm = (s: string) => s.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const n = script.length, m = spoken.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    dp[i][j] = Math.min(
      dp[i - 1][j - 1] + (norm(script[i - 1]) === norm(spoken[j - 1].word) ? 0 : 1),
      dp[i - 1][j] + 1,
      dp[i][j - 1] + 1
    );
  }
  const matched: Array<number | undefined> = Array(n).fill(undefined);
  let i = n, j = m;
  while (i && j) {
    const cost = norm(script[i - 1]) === norm(spoken[j - 1].word) ? 0 : 1;
    if (dp[i][j] === dp[i - 1][j - 1] + cost) {
      matched[--i] = --j;
    } else if (dp[i][j] === dp[i - 1][j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  const duration = Math.max(0, durationMs / 1000);
  const words: Word[] = script.map((word, k) => {
    const at = matched[k];
    return at === undefined ? { word, start: 0, end: 0 } : {
      word, start: Math.max(0, spoken[at].start), end: Math.min(duration, spoken[at].end),
    };
  });
  for (let k = 0; k < n;) {
    if (matched[k] !== undefined) { k++; continue; }
    const first = k;
    while (k < n && matched[k] === undefined) k++;
    const start = first ? words[first - 1].end : 0;
    const end = k < n ? words[k].start : duration;
    const span = Math.max(0, end - start);
    for (let t = first; t < k; t++) {
      words[t].start = start + span * (t - first) / (k - first);
      words[t].end = start + span * (t - first + 1) / (k - first);
    }
  }
  return { words, driftPct: Math.round(100 * dp[n][m] / Math.max(n, m)) };
}

/** Scene-relative words for a scene; script-timed fallback when the manifest has none. */
export async function sceneWordsFor(
  project: Project,
  sceneId: string,
  narration: string,
  durationMs: number
): Promise<Word[]> {
  const manifest = await readCaptionsManifest(project);
  const stored = manifest?.scenes?.find((s) => s.id === sceneId);
  if (stored && stored.words.length) return stored.words;
  return deriveSceneWords(narration, durationMs);
}

/**
 * Whisper prompt bias: any `knownTerms` glossary first (product names and
 * jargon Whisper mis-hears — it only biases on roughly its first 224 tokens,
 * so the terms must lead), then the known narration script in scene order, so
 * the transcript converges on correctly-spelled words instead of guessing from
 * audio phonetics alone. Capped to MAX_PROMPT_CHARS (see above).
 */
function buildSttPrompt(storyboard: Storyboard): string | undefined {
  const terms = (storyboard.knownTerms ?? [])
    .map((t) => t.trim())
    .filter(Boolean);
  const glossary = terms.length ? `${terms.join(", ")}. ` : "";
  const text = storyboard.scenes
    .map((s) => s.narration.trim())
    .filter(Boolean)
    .join(" ");
  const prompt = glossary + text;
  if (!prompt.trim()) return undefined;
  return prompt.length > MAX_PROMPT_CHARS
    ? prompt.slice(0, MAX_PROMPT_CHARS)
    : prompt;
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
  const seg = segConfig(storyboard);
  const config = captionConfig(voice.gapMs, seg);

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

  const cues = groupWords(words, sceneEnds, seg);
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
  // Readability, so an agent sees it without opening the SRT (issue #48).
  const stats = cueStats(cues);
  log(
    `cues: ${cues.length}, ${stats.midClausePct}% mid-clause breaks, ` +
      `${stats.short} shorter than 1s`
  );
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
function captionConfig(gapMs: number, cfg: SegConfig = DEFAULT_SEG): CaptionsManifest["config"] {
  return { gapMs, maxWords: cfg.maxWords, maxCueMs: cfg.maxCueMs };
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

/** Text of a run of words, with punctuation re-attached. */
function cueText(ws: Word[]): string {
  // trim each word: faster-whisper servers pad words with leading spaces
  return ws
    .map((w) => w.word.trim())
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

/** A word that ends a clause (punctuation) — the best place to break. */
function endsClause(w: Word): boolean {
  return /[,;:—–]$/.test(w.word.trim());
}

function endsSentence(w: Word): boolean {
  return /[.!?]["'”’)]?$/.test(w.word.trim());
}

/**
 * Split a run of words into cues at the most readable boundaries: sentence
 * ends first, then clause punctuation, then a conjunction, and only then on
 * pure length. Never leaves a 2–3 word tail dangling when the previous
 * boundary can absorb it.
 */
function splitRun(ws: Word[], cfg: SegConfig): Word[][] {
  const capChars = cfg.maxLines * cfg.maxCharsPerLine;
  const fits = (run: Word[]): boolean =>
    run.length <= cfg.maxWords &&
    cueText(run).length <= capChars &&
    (run[run.length - 1].end - run[0].start) * 1000 <= cfg.maxCueMs;
  if (ws.length === 0) return [];
  if (fits(ws)) return [ws];
  // The furthest index that still fits, then walk back to a real boundary.
  let end = 1;
  while (end < ws.length && fits(ws.slice(0, end + 1))) end++;
  const floor = Math.max(1, Math.ceil(end * 0.45));
  let cut = end;
  for (let i = end - 1; i >= floor; i--) {
    if (endsSentence(ws[i]) || endsClause(ws[i])) {
      cut = i + 1;
      break;
    }
  }
  if (cut === end) {
    for (let i = end - 1; i >= floor; i--) {
      const next = ws[i + 1];
      if (next && CONJUNCTIONS.has(next.word.trim().toLowerCase().replace(/[^\p{L}]/gu, ""))) {
        cut = i + 1;
        break;
      }
    }
  }
  return [ws.slice(0, cut), ...splitRun(ws.slice(cut), cfg)];
}

/** Merge a too-short cue into the neighbour it still fits in. */
function mergeShort(runs: Word[][], cfg: SegConfig): Word[][] {
  const capChars = cfg.maxLines * cfg.maxCharsPerLine;
  const room = (a: Word[], b: Word[]): boolean =>
    a.length + b.length <= cfg.maxWords &&
    cueText([...a, ...b]).length <= capChars &&
    (b[b.length - 1].end - a[0].start) * 1000 <= cfg.maxCueMs;
  const out: Word[][] = [];
  for (const run of runs) {
    const durMs = (run[run.length - 1].end - run[0].start) * 1000;
    const prev = out[out.length - 1];
    if (durMs < cfg.minCueMs && prev && room(prev, run)) {
      out[out.length - 1] = [...prev, ...run];
      continue;
    }
    out.push(run);
  }
  return out;
}

function groupWords(words: Word[], sceneEnds: number[], cfg: SegConfig = DEFAULT_SEG): Cue[] {
  // Scene boundaries and sentence ends are hard breaks; inside those runs the
  // split is clause-aware.
  const runs: Word[][] = [];
  let cur: Word[] = [];
  let sceneIdx = 0;
  const cut = (): void => {
    if (cur.length) runs.push(cur);
    cur = [];
  };
  for (const w of words) {
    const startMs = w.start * 1000;
    while (sceneIdx < sceneEnds.length - 1 && startMs >= sceneEnds[sceneIdx]) {
      cut();
      sceneIdx++;
    }
    cur.push(w);
    if (endsSentence(w)) cut();
  }
  cut();
  const split = runs.flatMap((r) => splitRun(r, cfg));
  return mergeShort(split, cfg).map((ws, i) => ({
    index: i + 1,
    startMs: Math.round(ws[0].start * 1000),
    endMs: Math.round(ws[ws.length - 1].end * 1000),
    text: cueText(ws),
  }));
}

/** Readability stats for the log: mid-clause breaks and too-short cues. */
export function cueStats(cues: Cue[], minCueMs = DEFAULT_SEG.minCueMs): {
  short: number;
  midClause: number;
  midClausePct: number;
} {
  let short = 0;
  let midClause = 0;
  cues.forEach((c, i) => {
    if (c.endMs - c.startMs < minCueMs) short++;
    const next = cues[i + 1];
    if (!next) return;
    const cleanBreak = /[.!?,;:—–]["'”’)]?$/.test(c.text.trim());
    const startsLower = /^\p{Ll}/u.test(next.text.trim());
    if (!cleanBreak && startsLower) midClause++;
  });
  const breaks = Math.max(1, cues.length - 1);
  return { short, midClause, midClausePct: Math.round((midClause / breaks) * 100) };
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

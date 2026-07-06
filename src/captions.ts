import { createReadStream, promises as fs } from "node:fs";
import { Project } from "./project.js";
import { requireOpenAiKey, openAiBaseUrl, STT_MODEL } from "./config.js";
import { VoiceManifestSchema, type Storyboard } from "./types.js";
import { srtTime, readJson, writeJson, exists, ok, step, log } from "./util.js";

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

/**
 * Transcribes the composed narration track with word-level timestamps and
 * writes captions.srt + captions.vtt + captions.cues.json. Using the real audio
 * (not the script) means caption timing matches the actual voiceover.
 */
export async function generateCaptions(project: Project): Promise<void> {
  const base = openAiBaseUrl();
  step(
    base
      ? `Generating captions (STT @ ${base})`
      : "Generating captions (Whisper word timestamps)"
  );
  // Lazy import: the offline path below must work without touching the SDK.
  const { default: OpenAI } = await import("openai");
  // baseURL undefined → api.openai.com; set → any OpenAI-compatible server.
  const client = new OpenAI({ apiKey: requireOpenAiKey(), baseURL: base });

  const res = await client.audio.transcriptions.create({
    file: createReadStream(project.narrationPath),
    model: STT_MODEL(),
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });

  const words: Word[] = (res as unknown as { words?: Word[] }).words ?? [];
  if (words.length === 0) {
    log("no word timestamps returned; captions may be empty");
  }
  // Scene boundaries (ms) in the narration track keep a cue from spanning two
  // scenes, so caption breaks line up with the on-screen beats.
  const sceneEnds = await sceneEndTimes(project);
  const cues = groupWords(words, sceneEnds);
  await writeCaptionFiles(project, cues);
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
  storyboard: Storyboard
): Promise<void> {
  step("Generating captions (offline, from script + voice.json timings)");
  const voice = VoiceManifestSchema.parse(
    await readJson(project.voiceManifestPath)
  );
  const durById = new Map(voice.scenes.map((s) => [s.id, s.durationMs]));

  const words: Word[] = [];
  const sceneEnds: number[] = [];
  let cursor = 0; // ms into the assembled narration track
  for (const scene of storyboard.scenes) {
    const durationMs = durById.get(scene.id);
    if (durationMs == null) {
      throw new Error(
        `voice.json has no scene "${scene.id}" — re-run: aidemo voice ${project.dir}`
      );
    }
    const tokens = scene.narration.split(/\s+/).filter(Boolean);
    // Weight each word by length (+1 for the following pause) so long words
    // get proportionally more of the scene's duration.
    const weights = tokens.map((t) => t.length + 1);
    const total = weights.reduce((a, w) => a + w, 0);
    let at = cursor;
    tokens.forEach((t, i) => {
      const wordMs = (weights[i] / total) * durationMs;
      words.push({ word: t, start: at / 1000, end: (at + wordMs) / 1000 });
      at += wordMs;
    });
    cursor += durationMs;
    sceneEnds.push(cursor);
    cursor += voice.gapMs;
  }

  const cues = groupWords(words, sceneEnds);
  await writeCaptionFiles(project, cues);
}

/** Shared tail of both paths — same files, same formats, either way. */
async function writeCaptionFiles(project: Project, cues: Cue[]): Promise<void> {
  await fs.writeFile(project.captionsSrtPath, toSrt(cues));
  await fs.writeFile(project.captionsVttPath, toVtt(cues));
  await writeJson(project.captionsCuesPath, cues);
  ok(`captions → ${project.captionsSrtPath} (${cues.length} cues)`);
  ok(`captions → ${project.captionsCuesPath}`);
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

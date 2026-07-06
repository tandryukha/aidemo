import OpenAI from "openai";
import { createReadStream, promises as fs } from "node:fs";
import { Project } from "./project.js";
import { requireOpenAiKey, STT_MODEL } from "./config.js";
import { VoiceManifestSchema } from "./types.js";
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
  step("Generating captions (Whisper word timestamps)");
  const client = new OpenAI({ apiKey: requireOpenAiKey() });

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
      text: cur.map((w) => w.word).join(" ").replace(/\s+([,.!?])/g, "$1").trim(),
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

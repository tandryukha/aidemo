import OpenAI from "openai";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { Storyboard, VoiceManifest, VoicePlan } from "./types.js";
import { VoiceManifestSchema } from "./types.js";
import { Project } from "./project.js";
import {
  requireOpenAiKey,
  openAiBaseUrl,
  TTS_MODEL,
  explainAudioEndpointError,
} from "./config.js";
import { runFfmpeg, probeDurationMs } from "./ffmpeg.js";
import {
  ensureDir,
  writeJson,
  readJson,
  exists,
  log,
  ok,
  step,
  CanceledError,
} from "./util.js";
import { dirname } from "node:path";

/** Silence inserted after each scene in the narration track. */
const GAP_MS = 300;

/**
 * Swap-in point for other TTS backends (ElevenLabs, local Piper). The pipeline
 * only depends on this interface, never on a concrete provider.
 */
export interface VoiceProvider {
  synthesize(input: {
    text: string;
    plan: VoicePlan;
  }): Promise<Buffer>;
}

export class OpenAIVoiceProvider implements VoiceProvider {
  private client: OpenAI;
  constructor() {
    // baseURL undefined → api.openai.com; set → any OpenAI-compatible server.
    this.client = new OpenAI({ apiKey: requireOpenAiKey(), baseURL: openAiBaseUrl() });
  }

  async synthesize({ text, plan }: { text: string; plan: VoicePlan }): Promise<Buffer> {
    const instructions = buildInstructions(plan);
    const res = await this.client.audio.speech
      .create({
        model: TTS_MODEL(),
        voice: plan.voiceId as OpenAI.Audio.SpeechCreateParams["voice"],
        input: text,
        instructions,
        response_format: "mp3",
      })
      .catch((err) => explainAudioEndpointError(err, "tts"));
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Fold the speed hint into the steering instructions (gpt-4o-mini-tts is prompt-steered). */
function buildInstructions(plan: VoicePlan): string {
  const parts: string[] = [];
  if (plan.instructions) parts.push(plan.instructions);
  if (plan.speed && plan.speed > 1.05) parts.push("Speak at a brisk, energetic pace.");
  else if (plan.speed && plan.speed < 0.95) parts.push("Speak slowly and deliberately.");
  return parts.join(" ") || "Clear, friendly, natural narration.";
}

function planFor(storyboard: Storyboard, sceneVoice?: VoicePlan): VoicePlan {
  return {
    voiceId: sceneVoice?.voiceId ?? storyboard.voice?.voiceId ?? "marin",
    instructions: sceneVoice?.instructions ?? storyboard.voice?.instructions,
    speed: sceneVoice?.speed ?? storyboard.voice?.speed,
  };
}

/** Identity of a scene's audio = its narration + the resolved voice plan. */
function voiceHash(text: string, plan: VoicePlan): string {
  return createHash("sha256")
    .update(JSON.stringify({ text, plan }))
    .digest("hex")
    .slice(0, 16);
}

export interface VoiceOptions {
  provider?: VoiceProvider;
  /** Regenerate only this scene id; reuse existing audio for the rest. */
  only?: string;
  /** Re-synthesize every scene even if its narration + voice are unchanged. */
  force?: boolean;
  /** Best-effort cancellation, checked between scenes (MCP job_cancel). */
  signal?: AbortSignal;
}

/**
 * Generates one narration clip per scene, assembles them (with inter-scene
 * gaps) into narration.mp3, and writes voice.json — whose per-scene durations
 * become the compose target length for each scene's video segment.
 *
 * Idempotent: a scene whose narration + voice plan hash matches the prior
 * voice.json (and whose audio file still exists) is reused instead of re-voiced.
 * This makes re-running the pipeline cheap and, crucially, doesn't silently
 * discard a take you already approved. `force` re-voices everything; `only`
 * targets a single scene (reusing the rest regardless of hash).
 */
export async function generateVoice(
  project: Project,
  storyboard: Storyboard,
  opts: VoiceOptions = {}
): Promise<VoiceManifest> {
  const base = openAiBaseUrl();
  step(base ? `Generating narration (TTS @ ${base})` : "Generating narration (OpenAI TTS)");
  await ensureDir(dirname(project.narrationPath));

  // Construct the provider lazily so a fully-cached run needs no API key.
  let providerInst = opts.provider ?? null;
  const provider = () => (providerInst ??= new OpenAIVoiceProvider());

  // Prior manifest lets us reuse audio for unchanged scenes.
  const prior = (await exists(project.voiceManifestPath))
    ? VoiceManifestSchema.safeParse(await readJson(project.voiceManifestPath))
    : null;
  const priorById = new Map(
    prior?.success ? prior.data.scenes.map((s) => [s.id, s]) : []
  );

  const manifest: VoiceManifest = { gapMs: GAP_MS, scenes: [] };
  let made = 0;
  let reused = 0;
  for (const scene of storyboard.scenes) {
    if (opts.signal?.aborted)
      throw new CanceledError(`canceled before voicing scene ${scene.id}`);
    const outPath = project.sceneAudioPath(scene.id);
    const plan = planFor(storyboard, scene.voice);
    const hash = voiceHash(scene.narration, plan);
    const prev = priorById.get(scene.id);
    const scoped = opts.only != null; // --scene mode
    const targeted = scoped && scene.id === opts.only;
    const unchanged = !opts.force && prev?.hash === hash;
    const audioOk = await exists(outPath);
    const reuse = audioOk && (scoped ? !targeted : unchanged);

    if (reuse) {
      const durationMs =
        prev?.durationMs && prev.durationMs > 0
          ? prev.durationMs
          : await probeDurationMs(outPath).catch(() => 0);
      // In --scene mode keep whatever hash was recorded; otherwise it matched.
      manifest.scenes.push({
        id: scene.id,
        file: outPath,
        durationMs,
        hash: scoped ? prev?.hash : hash,
      });
      log(`scene ${scene.id}: unchanged, reusing narration`);
      reused++;
      continue;
    }

    log(
      `scene ${scene.id}: "${scene.narration.slice(0, 48)}${
        scene.narration.length > 48 ? "…" : ""
      }" (${plan.voiceId})`
    );
    const audio = await provider().synthesize({ text: scene.narration, plan });
    await fs.writeFile(outPath, audio);
    const durationMs = await probeDurationMs(outPath);
    manifest.scenes.push({ id: scene.id, file: outPath, durationMs, hash });
    made++;
  }

  await assembleNarration(project, manifest);
  await writeJson(project.voiceManifestPath, manifest);
  const total = manifest.scenes.reduce((a, s) => a + s.durationMs + GAP_MS, 0);
  ok(
    `narration → ${project.narrationPath} (${manifest.scenes.length} scenes, ` +
      `~${Math.round(total / 1000)}s; ${made} voiced, ${reused} reused)`
  );
  ok(`voice.json → ${project.voiceManifestPath}`);
  // Existing captions were timed against the OLD narration; compose would burn
  // mismatched text. Say so now, not after a wasted compose.
  if (made > 0 && (await exists(project.captionsCuesPath))) {
    log(`⚠ narration changed — captions are now stale; re-run: aidemo captions ${project.dir}`);
  }
  return manifest;
}

/** Concatenate scene clips with a trailing gap after each, in one ffmpeg pass. */
async function assembleNarration(project: Project, manifest: VoiceManifest): Promise<void> {
  const gapSec = (manifest.gapMs / 1000).toFixed(3);
  const inputs: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];
  manifest.scenes.forEach((s, i) => {
    inputs.push("-i", s.file);
    filters.push(`[${i}:a]aresample=44100,apad=pad_dur=${gapSec}[a${i}]`);
    labels.push(`[a${i}]`);
  });
  const n = manifest.scenes.length;
  const filterComplex =
    filters.join(";") + ";" + labels.join("") + `concat=n=${n}:v=0:a=1[out]`;
  await runFfmpeg([
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    "-ac",
    "1",
    project.narrationPath,
  ]);
}

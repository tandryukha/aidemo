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
  ttsProvider,
  kokoroDtype,
  requireElevenLabsKey,
  ELEVENLABS_MODEL,
  ELEVENLABS_VOICE,
  explainAudioEndpointError,
} from "./config.js";
import { LocalVoiceProvider } from "./voice-local.js";
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
 * Swap-in point for other TTS backends (local Piper, …). The pipeline only
 * depends on this interface, never on a concrete provider. Selection is via
 * AIDEMO_TTS_PROVIDER (see config.ts); OpenAI remains the default.
 */
export interface VoiceProvider {
  synthesize(input: {
    text: string;
    plan: VoicePlan;
  }): Promise<Buffer>;
  /** Release provider resources (e.g. the local provider's ONNX session).
   *  Called by generateVoice on providers it constructed itself. */
  dispose?(): Promise<void>;
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

export class ElevenLabsVoiceProvider implements VoiceProvider {
  private apiKey: string;
  private warnedInstructions = false;
  constructor() {
    this.apiKey = requireElevenLabsKey();
  }

  async synthesize({ text, plan }: { text: string; plan: VoicePlan }): Promise<Buffer> {
    if (plan.instructions && !this.warnedInstructions) {
      this.warnedInstructions = true;
      log(
        "⚠ voice.instructions is a gpt-4o-mini-tts steering prompt — ElevenLabs ignores it"
      );
    }
    // "marin" is the schema default (an OpenAI voice name); anything else the
    // author chose deliberately and is passed to ElevenLabs verbatim.
    const voiceId = plan.voiceId === "marin" ? ELEVENLABS_VOICE() : plan.voiceId;
    const body: Record<string, unknown> = { text, model_id: ELEVENLABS_MODEL() };
    if (plan.speed && plan.speed !== 1) {
      // Storyboards allow 0.5–2; ElevenLabs accepts 0.7–1.2.
      body.voice_settings = { speed: Math.min(1.2, Math.max(0.7, plan.speed)) };
    }
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `ElevenLabs TTS failed for voice "${voiceId}" (HTTP ${res.status}): ${detail.slice(0, 300)}`
      );
    }
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

/**
 * Identity of a scene's audio = its narration + the resolved voice plan (+ the
 * TTS provider when non-default; for the local provider that includes the
 * model quantization). The provider is folded in only when it isn't "openai"
 * so every pre-existing manifest hash stays valid — but switching providers
 * (or requantizing the local model) still invalidates instead of silently
 * reusing the other backend's audio.
 */
function voiceHash(text: string, plan: VoicePlan, provider: string): string {
  const identity =
    provider === "openai" ? { text, plan } : { text, plan, provider };
  return createHash("sha256")
    .update(JSON.stringify(identity))
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
  const providerName = ttsProvider();
  // The audio identity key: local audio also changes with the quantization.
  const providerKey =
    providerName === "local" ? `local:${kokoroDtype()}` : providerName;
  const base = openAiBaseUrl();
  step(
    providerName === "elevenlabs"
      ? "Generating narration (ElevenLabs TTS)"
      : providerName === "local"
        ? "Generating narration (local Kokoro-82M, in-process)"
        : base
          ? `Generating narration (TTS @ ${base})`
          : "Generating narration (OpenAI TTS)"
  );
  await ensureDir(dirname(project.narrationPath));

  // Construct the provider lazily so a fully-cached run needs no API key
  // (and, for local, doesn't import onnxruntime or touch the model cache).
  let providerInst = opts.provider ?? null;
  const provider = () =>
    (providerInst ??=
      providerName === "elevenlabs"
        ? new ElevenLabsVoiceProvider()
        : providerName === "local"
          ? new LocalVoiceProvider()
          : new OpenAIVoiceProvider());

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
  try {
    for (const scene of storyboard.scenes) {
      if (opts.signal?.aborted)
        throw new CanceledError(`canceled before voicing scene ${scene.id}`);
      const outPath = project.sceneAudioPath(scene.id);
      const plan = planFor(storyboard, scene.voice);
      const hash = voiceHash(scene.narration, plan, providerKey);
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
  } finally {
    // A provider we constructed is ours to clean up. The local provider holds
    // an ONNX session that makes an abrupt process exit abort noisily.
    if (!opts.provider && providerInst?.dispose) {
      await providerInst.dispose().catch(() => {});
    }
  }
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

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
 * model quantization; + the language code for a multi-language render). The
 * provider and lang are folded in only when non-default so every pre-existing
 * manifest hash stays valid — but switching providers (or requantizing the
 * local model, or rendering a different language) still invalidates instead of
 * silently reusing the wrong audio. (Per-language audio also lives in its own
 * audio/<lang>/ dir, so caches can't physically collide; hashing the lang is
 * belt-and-suspenders for two languages that happen to share narration text.)
 */
function voiceHash(
  text: string,
  plan: VoicePlan,
  provider: string,
  lang?: string
): string {
  const base = provider === "openai" ? { text, plan } : { text, plan, provider };
  const identity = lang ? { ...base, lang } : base;
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Local Kokoro ships English voices only (en-US + en-GB accents — verified from
 * kokoro-js's voice table). A non-English `--lang` would still be read by an
 * English voice and mispronounced, so warn (don't fail): the caller may have
 * authored English-appropriate variants, or accept it for a smoke test. Real
 * non-English speech needs AIDEMO_TTS_PROVIDER=elevenlabs (multilingual) or
 * OpenAI TTS.
 */
function warnLocalLangCoverage(lang: string | undefined): void {
  if (!lang) return;
  const family = lang.toLowerCase().split(/[-_]/)[0];
  if (family === "en") return;
  log(
    `⚠ local Kokoro TTS speaks English only (en-US + en-GB accents) — "${lang}" ` +
      `narration will be read by an English voice and mispronounced. For genuine ` +
      `${lang} speech, render with AIDEMO_TTS_PROVIDER=elevenlabs or OpenAI TTS.`
  );
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
  if (providerName === "local") warnLocalLangCoverage(project.lang);
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
      const hash = voiceHash(scene.narration, plan, providerKey, project.lang);
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
    warnTargetLength(storyboard, manifest, total);
    return manifest;
  } finally {
    // A provider we constructed is ours to clean up. The local provider holds
    // an ONNX session that makes an abrupt process exit abort noisily.
    if (!opts.provider && providerInst?.dispose) {
      await providerInst.dispose().catch(() => {});
    }
  }
}

/** Whitespace word count — language-agnostic for the space-delimited scripts
 *  storyboards are authored in (including Estonian, Finnish, German, …). */
function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * `targetLengthSeconds` is an authoring budget nothing else in the pipeline
 * checks — docs/AUTHORING.md's "≈2.5 words/sec" planning figure is
 * English-centric, and non-English OpenAI TTS voices can read 30-40% slower
 * (Estonian `marin` measured at ≈1.8 w/s: 131 planned words, budgeted at 52s,
 * came out at 71.8s — see aidemo#15). voice.json is the first point the
 * pipeline knows the REAL narration length, so warn here — before record +
 * compose spend a full render finding out. Advisory only: never throws, never
 * changes the exit code.
 */
function warnTargetLength(
  storyboard: Storyboard,
  manifest: VoiceManifest,
  narrationTotalMs: number
): void {
  const targetSec = storyboard.targetLengthSeconds;
  if (targetSec == null) return;

  const narrationSec = narrationTotalMs / 1000;
  const introSec = (storyboard.intro?.durationMs ?? 0) / 1000;
  const outroSec = (storyboard.outro?.durationMs ?? 0) / 1000;
  const totalSec = narrationSec + introSec + outroSec;

  const narrationById = new Map(storyboard.scenes.map((s) => [s.id, s.narration]));
  const rows = manifest.scenes.map((s) => {
    const words = countWords(narrationById.get(s.id) ?? "");
    const sec = s.durationMs / 1000;
    const wps = sec > 0 ? words / sec : 0;
    return { id: s.id, words, sec, wps };
  });
  const totalWords = rows.reduce((a, r) => a + r.words, 0);
  // Pace over the narration track itself (scenes + inter-scene gaps), which is
  // what the author's word count actually bought them — cards are fixed
  // overhead, not narration, so they're excluded from the rate.
  const pace = narrationSec > 0 ? totalWords / narrationSec : 0;

  const parts = [`narration ${narrationSec.toFixed(1)}s`];
  if (introSec > 0) parts.push(`intro ${introSec.toFixed(1)}s`);
  if (outroSec > 0) parts.push(`outro ${outroSec.toFixed(1)}s`);
  const summary =
    parts.length > 1 ? `${parts.join(" + ")} = ${totalSec.toFixed(1)}s` : parts[0];

  const TOLERANCE = 1.05; // 5% slack before it's worth interrupting the author
  if (totalSec > targetSec * TOLERANCE) {
    const budgetWords = Math.round(targetSec * pace);
    log(
      `⚠ ${summary} exceeds targetLengthSeconds ${targetSec} ` +
        `(measured pace ${pace.toFixed(1)} w/s — budget ≈ ${budgetWords} words)`
    );
    log(`  ${"scene".padEnd(10)}${"words".padStart(7)}${"sec".padStart(7)}${"w/s".padStart(6)}`);
    for (const r of rows) {
      log(
        `  ${r.id.padEnd(10)}${String(r.words).padStart(7)}${r.sec.toFixed(1).padStart(7)}${r.wps.toFixed(1).padStart(6)}`
      );
    }
  } else if (totalSec < targetSec) {
    log(
      `${summary} is under targetLengthSeconds ${targetSec} ` +
        `(measured pace ${pace.toFixed(1)} w/s) — room to add narration if useful`
    );
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

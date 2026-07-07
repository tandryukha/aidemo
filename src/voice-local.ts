import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { VoicePlan } from "./types.js";
import type { VoiceProvider } from "./voice.js";
import {
  KOKORO_MODEL_ID,
  KOKORO_VOICE,
  kokoroDtype,
  ttsModelCacheDir,
} from "./config.js";
import { runFfmpeg } from "./ffmpeg.js";
import { exists, log } from "./util.js";

/**
 * In-process TTS: Kokoro-82M ONNX on CPU via kokoro-js — no server, no key.
 * kokoro-js is deliberately NOT in package.json (it drags in ~400 MB of
 * onnxruntime); it's an opt-in install, imported lazily through non-literal
 * specifiers so typecheck and every non-local run never touch it.
 */
const KOKORO_PKG: string = "kokoro-js";
const TRANSFORMERS_PKG: string = "@huggingface/transformers";

interface KokoroTtsCtor {
  prototype: unknown;
  from_pretrained(
    modelId: string,
    opts: { dtype: string; device: string }
  ): Promise<KokoroTts>;
}

interface KokoroModules {
  KokoroTTS: KokoroTtsCtor;
  /** transformers.js env — cacheDir/allowRemoteModels knobs. */
  hfEnv: { cacheDir: string; allowRemoteModels: boolean };
}

interface KokoroTts {
  voices: Record<string, { name: string }>;
  model?: { dispose(): Promise<void> };
  generate(
    text: string,
    opts: { voice: string; speed: number }
  ): Promise<{ toWav(): ArrayBuffer }>;
}

/**
 * Resolve kokoro-js from the engine's own node_modules, then from the
 * consumer's cwd (an npx-installed engine lives in the npx cache, so a
 * `npm install kokoro-js` in the consumer repo is only reachable via cwd).
 * @huggingface/transformers is resolved relative to wherever kokoro-js was
 * found — it's kokoro-js's own dependency, needed only to steer its cache.
 */
async function loadKokoro(): Promise<KokoroModules> {
  const attempts: Array<() => Promise<KokoroModules>> = [
    async () => ({
      KokoroTTS: (await import(KOKORO_PKG)).KokoroTTS,
      hfEnv: (await import(TRANSFORMERS_PKG)).env,
    }),
    async () => {
      const req = createRequire(join(process.cwd(), "package.json"));
      const kokoroPath = req.resolve(KOKORO_PKG);
      const sibling = createRequire(kokoroPath);
      return {
        KokoroTTS: (await import(pathToFileURL(kokoroPath).href)).KokoroTTS,
        hfEnv: (await import(pathToFileURL(sibling.resolve(TRANSFORMERS_PKG)).href)).env,
      };
    },
  ];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch {
      // try the next resolution root
    }
  }
  throw new Error(
    `AIDEMO_TTS_PROVIDER=local needs the optional kokoro-js package (not bundled — ` +
      `it installs ~400 MB of onnxruntime). Run: npm install kokoro-js ` +
      `(in the engine checkout, or in the repo you run aidemo from), then retry.`
  );
}

/** True if kokoro-js resolves from the engine or the consumer cwd (no heavy import). */
export function localTtsInstalled(): boolean {
  for (const from of [import.meta.url, pathToFileURL(join(process.cwd(), "package.json")).href]) {
    try {
      createRequire(from).resolve(KOKORO_PKG);
      return true;
    } catch {
      // not resolvable from this root
    }
  }
  return false;
}

/** Doctor's view of the local provider: installed? model cached where, how big? */
export async function localTtsStatus(): Promise<{
  installed: boolean;
  dtype: string;
  cacheDir: string;
  modelDir: string;
  modelCached: boolean;
  cacheSizeMB: number | null;
}> {
  const cacheDir = ttsModelCacheDir();
  const modelDir = join(cacheDir, KOKORO_MODEL_ID);
  const modelCached = await exists(join(modelDir, "onnx"));
  return {
    installed: localTtsInstalled(),
    dtype: kokoroDtype(),
    cacheDir,
    modelDir,
    modelCached,
    cacheSizeMB: modelCached ? await dirSizeMB(modelDir) : null,
  };
}

async function dirSizeMB(dir: string): Promise<number> {
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else bytes += (await fs.stat(p)).size;
    }
  };
  await walk(dir).catch(() => {});
  return Math.round(bytes / 1e6);
}

/**
 * The voice table is a static getter on the prototype (it doesn't need a
 * loaded model) — reading it there lets a wrong voiceId fail BEFORE the
 * ~90 MB first-run model download. Best-effort: null falls back to the
 * post-load instance check.
 */
function staticVoices(KokoroTTS: KokoroTtsCtor): Record<string, unknown> | null {
  try {
    const get = Object.getOwnPropertyDescriptor(KokoroTTS.prototype, "voices")?.get;
    const voices = get?.call(Object.create(KokoroTTS.prototype as object));
    return voices && typeof voices === "object" ? voices : null;
  } catch {
    return null;
  }
}

export class LocalVoiceProvider implements VoiceProvider {
  private mods: Promise<KokoroModules> | null = null;
  private tts: Promise<KokoroTts> | null = null;
  private warnedInstructions = false;

  private modules(): Promise<KokoroModules> {
    return (this.mods ??= loadKokoro());
  }

  private load(): Promise<KokoroTts> {
    return (this.tts ??= (async () => {
      const { KokoroTTS, hfEnv } = await this.modules();
      hfEnv.cacheDir = ttsModelCacheDir();
      // Same switch the Python HF stack honors — proves air-gapped runs work.
      if (process.env.HF_HUB_OFFLINE === "1") hfEnv.allowRemoteModels = false;
      const dtype = kokoroDtype();
      if (!(await localTtsStatus()).modelCached) {
        log(
          `downloading ${KOKORO_MODEL_ID} (${dtype}) from huggingface.co → ` +
            `${hfEnv.cacheDir} — first run only, cached after`
        );
      }
      return KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype, device: "cpu" });
    })());
  }

  async synthesize({ text, plan }: { text: string; plan: VoicePlan }): Promise<Buffer> {
    if (plan.instructions && !this.warnedInstructions) {
      this.warnedInstructions = true;
      log(
        "⚠ voice.instructions is a gpt-4o-mini-tts steering prompt — the local Kokoro provider ignores it"
      );
    }
    // "marin" is the schema default (an OpenAI voice name); anything else the
    // author chose deliberately and must be a Kokoro voice id. Validate here,
    // not in kokoro-js — its own validation console.tables to stdout, which
    // the MCP server reserves for JSON-RPC.
    const voiceId = plan.voiceId === "marin" ? KOKORO_VOICE() : plan.voiceId;
    const voices =
      staticVoices((await this.modules()).KokoroTTS) ?? (await this.load()).voices;
    if (!(voiceId in voices)) {
      throw new Error(
        `"${voiceId}" is not a Kokoro voice — the local provider has: ` +
          `${Object.keys(voices).join(", ")}. Set the storyboard's voice.voiceId ` +
          `(e.g. af_heart) or AIDEMO_KOKORO_VOICE.`
      );
    }
    const tts = await this.load();
    const audio = await tts.generate(text, {
      voice: voiceId,
      // Storyboards allow 0.5–2, matching Kokoro's usable range — pass through.
      speed: plan.speed ?? 1,
    });
    return wavToMp3(Buffer.from(await audio.toWav()));
  }

  /** Release the ONNX session — onnxruntime aborts noisily if the process
   *  exits (especially process.exit) while a session is still alive. */
  async dispose(): Promise<void> {
    if (!this.tts) return;
    const tts = await this.tts.catch(() => null);
    await tts?.model?.dispose().catch(() => {});
    this.tts = null;
  }
}

/** Kokoro emits WAV; sceneAudioPath is .mp3 and downstream assumes it — transcode. */
async function wavToMp3(wav: Buffer): Promise<Buffer> {
  const base = join(tmpdir(), `aidemo-tts-${randomBytes(6).toString("hex")}`);
  const wavPath = `${base}.wav`;
  const mp3Path = `${base}.mp3`;
  try {
    await fs.writeFile(wavPath, wav);
    await runFfmpeg(["-i", wavPath, "-codec:a", "libmp3lame", "-q:a", "2", mp3Path]);
    return await fs.readFile(mp3Path);
  } finally {
    await fs.rm(wavPath, { force: true });
    await fs.rm(mp3Path, { force: true });
  }
}

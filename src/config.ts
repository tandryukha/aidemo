import { promises as fs, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Engine install root = parent of src/. When the engine is run from its own
 * repo this is the repo root; when it's fetched via `npx github:.../aidemo`
 * it's the temp package dir. Either way, package.json / bin / .claude live here.
 */
export const ENGINE_ROOT = resolve(new URL("..", import.meta.url).pathname);
/** Back-compat alias — historically the engine only ran from its own checkout. */
export const REPO_ROOT = ENGINE_ROOT;

/** The engine's own version, read from its bundled package.json (single source). */
export function engineVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ENGINE_ROOT, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Parse one KEY=VALUE .env file into a plain object. No process.env side effects here —
 *  see loadEnv() below for why the two files are read fully before anything is assigned. */
async function readEnvFile(envPath: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  let raw: string;
  try {
    raw = await fs.readFile(envPath, "utf8");
  } catch {
    return values; // no file — nothing to load
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    values[key] = val;
  }
  return values;
}

/**
 * Load .env for the CLI. Reads the *consumer's* cwd/.env (so a repo that installed
 * the skill can keep its own OpenAI key next to its demos) and the engine's own
 * .env, then merges with cwd winning over the engine dir for any key both define.
 *
 * CRITICAL: a value found in EITHER .env file always OVERRIDES whatever is already
 * in process.env — e.g. an OPENAI_API_KEY exported globally in a shell profile
 * (~/.zshrc), possibly shared across several unrelated repos/projects. This is
 * deliberate. The previous version of this function only assigned a var when it
 * was not yet present in process.env at all, which is the exact "ambient wins"
 * default that Node's `dotenv.config()` and Python's `load_dotenv()` also ship
 * with — it LOOKS like a safe merge but actually means a repo's own .env is
 * silently ignored whenever the key already happens to be set in the process
 * environment, and the spend goes to whatever key that ambient value belongs to
 * instead. See scripts/guard-openai-key.ts, which fails the build if this
 * skip-if-already-set shape ever comes back. Ambient only wins here when
 * NEITHER .env file defines the key at all (e.g. a deliberate one-off invocation
 * like `OPENAI_API_KEY=sk-... aidemo record ...`). Called once at CLI startup.
 */
export async function loadEnv(): Promise<void> {
  const cwdEnv = resolve(process.cwd(), ".env");
  const engineEnv = resolve(ENGINE_ROOT, ".env");
  const engineValues = await readEnvFile(engineEnv);
  const cwdValues = cwdEnv === engineEnv ? {} : await readEnvFile(cwdEnv);
  const merged = { ...engineValues, ...cwdValues }; // cwd wins per-key over the engine dir
  for (const [key, val] of Object.entries(merged)) {
    process.env[key] = val;
  }
}

/**
 * Custom endpoint for any OpenAI-compatible server (LocalAI, speaches,
 * Kokoro-FastAPI, …). AIDEMO_OPENAI_BASE_URL wins over the SDK-standard
 * OPENAI_BASE_URL; unset → api.openai.com.
 */
export const openAiBaseUrl = () =>
  process.env.AIDEMO_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || undefined;

export function requireOpenAiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (key) return key;
  // Local OpenAI-compatible servers rarely check auth; a placeholder key keeps
  // the SDK happy without demanding a real one.
  if (openAiBaseUrl()) return "sk-aidemo-local";
  throw new Error(
    "OPENAI_API_KEY is not set. Copy .env.example to .env and add your key, " +
      "or point OPENAI_BASE_URL at a local OpenAI-compatible server."
  );
}

export const TTS_MODEL = () => process.env.AIDEMO_TTS_MODEL || "gpt-4o-mini-tts";
export const STT_MODEL = () => process.env.AIDEMO_STT_MODEL || "whisper-1";

/**
 * TTS backend for `aidemo voice`. Unset → OpenAI (or whatever OPENAI_BASE_URL
 * points at), exactly as before this knob existed. Captions/STT are unaffected —
 * they always use the OpenAI-compatible endpoint (but see captionsAutoOffline).
 */
export const ttsProvider = (): "openai" | "elevenlabs" | "local" => {
  const p = process.env.AIDEMO_TTS_PROVIDER || "openai";
  if (p !== "openai" && p !== "elevenlabs" && p !== "local") {
    throw new Error(
      `AIDEMO_TTS_PROVIDER="${p}" is not a known provider — use "openai" (default), "elevenlabs" or "local".`
    );
  }
  return p;
};

/** The one model the in-process local provider runs — same weights speaches serves. */
export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

const KOKORO_DTYPES = ["fp32", "fp16", "q8", "q4", "q4f16"] as const;
export type KokoroDtype = (typeof KOKORO_DTYPES)[number];
/** Quantization for the local model: q8 ≈ 90 MB (default), fp32 ≈ 330 MB (best). */
export const kokoroDtype = (): KokoroDtype => {
  const d = process.env.AIDEMO_TTS_MODEL_DTYPE || "q8";
  if (!KOKORO_DTYPES.includes(d as KokoroDtype)) {
    throw new Error(
      `AIDEMO_TTS_MODEL_DTYPE="${d}" is not a Kokoro quantization — use one of: ${KOKORO_DTYPES.join(", ")}.`
    );
  }
  return d as KokoroDtype;
};

/**
 * Voice used when the storyboard keeps the schema default ("marin", an OpenAI
 * name Kokoro doesn't know). Any explicitly authored voiceId is passed to the
 * local model verbatim. Same convention as ELEVENLABS_VOICE.
 */
export const KOKORO_VOICE = () => process.env.AIDEMO_KOKORO_VOICE || "af_heart";

/**
 * Where the local provider caches the downloaded model. Defaults inside the
 * HuggingFace home (HF_HOME or ~/.cache/huggingface) so it survives
 * node_modules reinstalls and a pre-seeded copy makes installs air-gapped.
 */
export const ttsModelCacheDir = () =>
  process.env.AIDEMO_TTS_MODEL_CACHE ||
  resolve(
    process.env.HF_HOME || resolve(homedir(), ".cache", "huggingface"),
    "transformersjs"
  );

/**
 * `render` auto-routes captions through the offline (script-timed) derivation
 * when the voice is generated locally and the STT call would fail anyway —
 * local voice shouldn't demand a cloud key just for caption timing.
 */
export const captionsAutoOffline = () =>
  ttsProvider() === "local" && !openAiBaseUrl() && !process.env.OPENAI_API_KEY;

export function requireElevenLabsKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (key) return key;
  throw new Error(
    "ELEVENLABS_API_KEY is not set but AIDEMO_TTS_PROVIDER=elevenlabs. Add the key " +
      "to .env, or unset AIDEMO_TTS_PROVIDER to use the default OpenAI TTS."
  );
}

export const ELEVENLABS_MODEL = () =>
  process.env.AIDEMO_ELEVENLABS_MODEL || "eleven_multilingual_v2";
/**
 * Voice used when the storyboard keeps the schema default ("marin", an OpenAI
 * name that means nothing to ElevenLabs). Any explicitly authored voiceId is
 * passed to ElevenLabs verbatim instead. Default: Rachel.
 */
export const ELEVENLABS_VOICE = () =>
  process.env.AIDEMO_ELEVENLABS_VOICE || "21m00Tcm4TlvDq8ikWAM";

/**
 * LLM-only servers (Ollama, plain llama.cpp/vLLM) speak the OpenAI chat
 * protocol but 404 the audio routes — the only routes this engine calls.
 * Rethrow that specific failure with what's wrong and what to run instead.
 */
export function explainAudioEndpointError(err: unknown, kind: "tts" | "stt"): never {
  const base = openAiBaseUrl();
  const status = (err as { status?: number } | null)?.status;
  if (base && (status === 404 || status === 405)) {
    const endpoint =
      kind === "tts" ? "POST /v1/audio/speech (TTS)" : "POST /v1/audio/transcriptions (STT)";
    throw new Error(
      `${base} doesn't implement ${endpoint}. LLM-only servers like Ollama or plain ` +
        `llama.cpp/vLLM have no OpenAI audio endpoints — point OPENAI_BASE_URL at a ` +
        `speech server such as speaches instead (README → "Local models & offline")` +
        (kind === "stt" ? `, or skip transcription: aidemo captions <dir> --offline` : "") +
        `. Original error: ${(err as Error).message}`
    );
  }
  throw err;
}

/** Dedicated Chrome profile handed to Playwright (logged into ChatGPT). */
export const chromeProfileDir = () =>
  process.env.AIDEMO_CHROME_PROFILE || resolve(REPO_ROOT, "chrome-profile");

/** Default capture path: playwright | native | obs (see src/capture.ts). */
export const defaultCaptureMode = () => process.env.AIDEMO_CAPTURE || "playwright";
/** avfoundation input name for native capture. List devices with:
 *  ffmpeg -f avfoundation -list_devices true -i "" */
export const captureDevice = () =>
  process.env.AIDEMO_CAPTURE_DEVICE || "Capture screen 0";
export const obsUrl = () => process.env.AIDEMO_OBS_URL || "ws://127.0.0.1:4455";
export const obsPassword = () => process.env.AIDEMO_OBS_PASSWORD;
/**
 * Escape hatch for the native/OBS capture crop sanity gate: "1" downgrades
 * the abort-on-geometry-mismatch to a loud warning. A wrong crop can ship the
 * whole desktop into the video — frame-review any take recorded with this set.
 */
export const nativeCropUnsafe = () =>
  process.env.AIDEMO_NATIVE_CROP_UNSAFE === "1";

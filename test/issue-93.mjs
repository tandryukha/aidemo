// Issue #93 — the voice cache must not reuse narration after the TTS endpoint
// or model changes, while the default setup keeps every pre-existing hash.
// Pure (no network, no ffmpeg).
//
//   npx tsx --test test/issue-93.mjs      (part of `npm test`)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, afterEach } from "node:test";
import { audioIdentityKey, voiceHash } from "../src/voice.ts";

const KNOBS = [
  "AIDEMO_OPENAI_BASE_URL",
  "OPENAI_BASE_URL",
  "AIDEMO_TTS_MODEL",
  "AIDEMO_ELEVENLABS_MODEL",
  "AIDEMO_ELEVENLABS_VOICE",
  "AIDEMO_KOKORO_VOICE",
  "AIDEMO_TTS_MODEL_DTYPE",
];
const saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
for (const k of KNOBS) delete process.env[k];
afterEach(() => {
  for (const k of KNOBS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const PLAN = { voiceId: "marin" };
const legacy = (identity) =>
  createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);

test("default setups keep the keys (and hashes) older engines wrote", () => {
  assert.equal(audioIdentityKey("openai"), "openai");
  assert.equal(audioIdentityKey("elevenlabs"), "elevenlabs");
  assert.equal(audioIdentityKey("local"), "local:q8");
  assert.equal(
    voiceHash("Hi.", PLAN, audioIdentityKey("openai")),
    legacy({ text: "Hi.", plan: PLAN })
  );
  assert.equal(
    voiceHash("Hi.", PLAN, audioIdentityKey("local")),
    legacy({ text: "Hi.", plan: PLAN, provider: "local:q8" })
  );
});

test("switching the OpenAI-compatible endpoint changes the hash", () => {
  const def = voiceHash("Hi.", PLAN, audioIdentityKey("openai"));
  process.env.AIDEMO_OPENAI_BASE_URL = "http://127.0.0.1:18701/v1";
  const a = voiceHash("Hi.", PLAN, audioIdentityKey("openai"));
  process.env.AIDEMO_OPENAI_BASE_URL = "http://127.0.0.1:18702/v1";
  const b = voiceHash("Hi.", PLAN, audioIdentityKey("openai"));
  assert.notEqual(a, def);
  assert.notEqual(a, b);
  // A trailing slash is the same server.
  process.env.AIDEMO_OPENAI_BASE_URL = "http://127.0.0.1:18702/v1/";
  assert.equal(voiceHash("Hi.", PLAN, audioIdentityKey("openai")), b);
  // OPENAI_BASE_URL counts too when the aidemo-specific var is unset.
  delete process.env.AIDEMO_OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:18702/v1";
  assert.equal(voiceHash("Hi.", PLAN, audioIdentityKey("openai")), b);
});

test("switching the TTS model changes the hash", () => {
  const def = audioIdentityKey("openai");
  process.env.AIDEMO_TTS_MODEL = "gpt-4o-mini-tts";
  assert.equal(audioIdentityKey("openai"), def, "explicit default is still the default");
  process.env.AIDEMO_TTS_MODEL = "tts-1-hd";
  assert.notEqual(audioIdentityKey("openai"), def);
});

test("ElevenLabs and local fold in their own model/voice knobs", () => {
  process.env.AIDEMO_ELEVENLABS_MODEL = "eleven_flash_v2_5";
  assert.notEqual(audioIdentityKey("elevenlabs"), "elevenlabs");
  process.env.AIDEMO_KOKORO_VOICE = "am_adam";
  assert.notEqual(audioIdentityKey("local"), "local:q8");
  process.env.AIDEMO_TTS_MODEL_DTYPE = "fp32";
  assert.match(audioIdentityKey("local"), /^local:fp32 /);
});

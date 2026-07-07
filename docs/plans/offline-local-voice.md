# Plan: in-process local voice (zero-infrastructure offline mode)

**Status: proposed — not started.** Documented ahead of implementation; nothing
in this file is built yet.

## Where offline stands today

TTS (`voice`) and transcription (`captions`) are the only two network calls in
the pipeline, and both redirect to any OpenAI-compatible server via
`OPENAI_BASE_URL` (see README → "Local models & offline"). The verified stack
is [speaches](https://speaches.ai) serving Kokoro-82M TTS + faster-whisper STT
— the bundled fixture renders end-to-end against it with no API key. For
captions there is already a zero-network path: `aidemo captions <dir>
--offline` derives approximate cues from the script + `voice.json` timings.

The remaining gap: **voice still requires running a local speech server**
(in practice, Docker). "Offline" today means "localhost server", not
"nothing but this repo".

## Goal

`aidemo render` fully self-contained: **Node + Chrome + ffmpeg, no Docker, no
server, no API key** — by running the same Kokoro-82M model *in-process*.

Target UX:

```bash
AIDEMO_VOICE_PROVIDER=local aidemo render <dir> --headless
# captions fall back to --offline mode automatically when the provider is local
# (or the user runs: aidemo captions <dir> --offline)
```

## Design

### Provider selection

`src/voice.ts` already defines the seam — `VoiceProvider` was left open for
exactly this:

```ts
export interface VoiceProvider {
  synthesize(input: { text: string; plan: VoicePlan }): Promise<Buffer>;
}
```

Add `LocalVoiceProvider` (kokoro-js) beside `OpenAIVoiceProvider`, chosen by
`AIDEMO_VOICE_PROVIDER=openai|local` (default `openai` — existing behavior and
storyboards unchanged). `generateVoice()` already constructs the provider
lazily, so cached runs keep needing neither a key nor the model.

### Engine: kokoro-js

[kokoro-js](https://www.npmjs.com/package/kokoro-js) runs Kokoro-82M ONNX via
transformers.js/onnxruntime on CPU. This is the *same model* speaches serves,
so voice quality is already validated. Notes:

- **Quantization**: expose via `AIDEMO_TTS_MODEL_DTYPE` (`q8` default — ~90 MB,
  good quality/speed; `fp32` ~330 MB for best quality). Model id stays
  `onnx-community/Kokoro-82M-v1.0-ONNX`.
- **Model cache**: transformers.js caches under its own dir; respect `HF_HOME`
  and document the path. First run downloads from huggingface.co; every run
  after is air-gapped.
- **Output format**: kokoro-js emits WAV; `sceneAudioPath()` is
  `scene-<id>.mp3` and downstream probes/concats assume it. Transcode WAV→MP3
  inside the provider with the existing `runFfmpeg` helper (one extra pass per
  scene, negligible).
- **Voice plan mapping**: `plan.voiceId` maps 1:1 to Kokoro voices
  (`af_heart`, `am_adam`, …) — same ids as the speaches recipe.
  `plan.speed` maps to kokoro-js's `speed` option. `plan.instructions` has no
  Kokoro equivalent — log a one-line notice that instructions are ignored by
  the local provider, don't fail. The default `voiceId: "marin"` (an OpenAI
  voice) must fail with a clear "pick a Kokoro voice, e.g. af_heart" message,
  not a cryptic model error.

### Captions pairing

Local voice + word-timed captions still needs an STT server, which defeats the
point. So: when `AIDEMO_VOICE_PROVIDER=local` and no `OPENAI_BASE_URL` is set,
`render` should route captions through the existing `--offline` derivation
automatically (with a log line saying so), instead of failing on a missing key.
In-process STT (whisper via transformers.js) is explicitly **out of scope** —
`--offline` captions are close enough for most demos and cost nothing.

### Dependency posture (the sensitive part)

CI policy forbids install scripts and new network endpoints, and kokoro-js
drags in onnxruntime (native binaries, ~100+ MB installed). Do **not** make it
a hard dependency:

- Ship it as an **optionalDependencies-or-nothing**: lazy `import("kokoro-js")`
  inside `LocalVoiceProvider` only (same lazy-import pattern `captions.ts`
  already uses to keep the offline path SDK-free). If the import fails, error
  with the exact install command (`npm install kokoro-js`).
- Verify at PR time that kokoro-js + its transitive deps carry **no install
  scripts** (`npm query ':attr(scripts, [postinstall])'` or
  `--ignore-scripts` install test) — if any appear, pin or reconsider.
- The HuggingFace model download is a **new documented network endpoint**
  (first run only). Update README "What leaves the machine": nothing leaves —
  bytes only come *down*, from huggingface.co, once, and `HF_HOME` can point
  at a pre-seeded cache for true air-gapped installs.

### doctor

`aidemo doctor` learns a `voice provider` line: which provider is selected;
for `local` — is kokoro-js importable, is the model already cached (report the
cache path and size), expected first-run download size if not.

## Verification

- Fixture renders end-to-end with `AIDEMO_VOICE_PROVIDER=local` + offline
  captions on a machine with no `OPENAI_API_KEY` and no server running
  (after one warm-up run for the model download).
- Second run with network disabled (or `HF_HUB_OFFLINE=1`) still renders —
  proves air-gapped.
- Default path (no env vars) renders byte-identically to today — provider
  selection must not disturb existing storyboards (backward-compat invariant).
- Voice hash cache: `voiceHash()` covers text + plan but not the provider —
  switching providers must re-voice. Fold the provider name (and dtype) into
  the hash.

## Non-goals

- In-process STT / word-timed offline captions (revisit if `--offline` cues
  prove too coarse in practice).
- ElevenLabs or other cloud providers (the interface allows them; not this
  plan).
- macOS `say` draft provider — cute, but a second local backend doubles the
  support surface for a voice nobody ships. Skip unless asked.
- Changing any default: OpenAI remains the default provider.

## Milestones

1. **Spike** — kokoro-js in a scratch script: synthesize one scene, check
   quality/speed on CPU (M-series and one x86 datapoint), confirm no install
   scripts, measure installed size. Go/no-go.
2. **Provider** — `LocalVoiceProvider` + selection env + WAV→MP3 + hash fix +
   clear errors (missing package, unknown voice).
3. **Pipeline glue** — auto-offline captions under local voice, doctor line,
   README + `.env.example` + record-demo SKILL.md note (schema untouched, so
   skill changes are docs-only).
4. **Verify & ship** — fixture matrix above, then release per RELEASING.md.

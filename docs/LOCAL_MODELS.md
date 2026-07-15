# Local models & offline rendering

> Part of [aidemo](../README.md). This is the deep reference for running the
> pipeline with **no API key** — either fully in-process, or against your own
> OpenAI-compatible speech server.

TTS (`voice`) and transcription (`captions`) are the **only two network calls
in the pipeline**, and both go through the OpenAI SDK — so both can be pointed
at any OpenAI-compatible server. Everything else — recording, composing, music
synthesis, caption/card rendering — is local Chrome + ffmpeg already.

## Zero infrastructure — in-process TTS (no server, no Docker, no key)

`AIDEMO_TTS_PROVIDER=local` runs
[Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) on the
CPU *inside the engine* via
[kokoro-js](https://www.npmjs.com/package/kokoro-js):

```bash
npm install kokoro-js     # opt-in, deliberately not bundled (~400 MB installed
                          # with onnxruntime; `--ignore-scripts` works too)
AIDEMO_TTS_PROVIDER=local aidemo render <dir> --headless
```

The first `voice` run downloads the model once from huggingface.co (~90 MB at
the default `q8` quantization; `AIDEMO_TTS_MODEL_DTYPE=fp32` gets the ~330 MB
best-quality build) into `~/.cache/huggingface/transformersjs` (`HF_HOME`
respected; override with `AIDEMO_TTS_MODEL_CACHE`). Every run after is fully
air-gapped — `HF_HUB_OFFLINE=1` is honored, and pre-seeding that directory
skips the download entirely. Storyboard `voiceId`s are Kokoro voices
(`af_heart`, `am_adam`, …); a storyboard that doesn't pick one gets
`AIDEMO_KOKORO_VOICE` (default `af_heart`), and `voice.instructions` is
OpenAI-only and ignored. With no STT endpoint or key configured, `render`
derives captions offline from the script automatically — so the whole pipeline
runs on Node + Chrome + ffmpeg alone. Synthesis is ~2.4× realtime on an
M-series CPU; `aidemo doctor` reports whether kokoro-js and the model cache are
in place.

## Or run a local speech server

Point both halves (TTS *and* word-timed STT) at it:

```bash
OPENAI_BASE_URL=http://localhost:8000/v1        # or AIDEMO_OPENAI_BASE_URL
AIDEMO_TTS_MODEL=speaches-ai/Kokoro-82M-v1.0-ONNX   # default: gpt-4o-mini-tts
AIDEMO_STT_MODEL=Systran/faster-whisper-small       # default: whisper-1
```

With a custom base URL set, **no `OPENAI_API_KEY` is needed**. `aidemo doctor`
reports which endpoint is in effect and warns if it's an LLM-only server that
can't serve these calls (it pings only the endpoint you configured).

**Prefer ElevenLabs voices?** Swap just the TTS half with
`AIDEMO_TTS_PROVIDER=elevenlabs` + `ELEVENLABS_API_KEY` — captions keep using
the OpenAI-compatible endpoint above. Your storyboard's `voiceId` is then an
ElevenLabs voice id (pick the default with `AIDEMO_ELEVENLABS_VOICE`, the model
with `AIDEMO_ELEVENLABS_MODEL`; `voice.instructions` is OpenAI-only and is
ignored). Leave the variable unset and nothing changes.

## One-server recipe — [speaches](https://speaches.ai)

Covers both halves (faster-whisper STT with word timestamps + Kokoro TTS):

```bash
docker run --rm --detach --publish 8000:8000 \
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cpu     # :latest-cuda if you have a GPU
uvx speaches-cli model download speaches-ai/Kokoro-82M-v1.0-ONNX
uvx speaches-cli model download Systran/faster-whisper-small
```

Then set the three env vars above and pick a voice the model knows in your
storyboard's voice plan (Kokoro: `af_heart`, `am_adam`, …). This exact stack is
verified: the bundled fixture renders end-to-end against it — real Kokoro
narration, word-timed faster-whisper captions, no API key.
[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) or
[LocalAI](https://localai.io) also work for the TTS half.

## What about Ollama?

Ollama (like plain llama.cpp or vLLM) speaks the OpenAI *chat* protocol but has
no `/v1/audio/*` endpoints
([ollama#5424](https://github.com/ollama/ollama/issues/5424)) — and TTS + STT
are the only AI calls in this pipeline, so there's nothing chat-shaped to point
at it. Author storyboards with whatever agent you like (including one served by
Ollama); for rendering, run a speech server like speaches above. Pointing
`OPENAI_BASE_URL` at Ollama fails fast with an explanation, and `aidemo doctor`
flags it upfront. The day Ollama ships audio endpoints, the same three env vars
will work unchanged.

## Caveat: caption sync needs word-level timestamps

The STT server must support `timestamp_granularities=word` — speaches does;
whisper.cpp's compat layer may not. If yours doesn't (or you want zero network
at all), `aidemo captions <dir> --offline` derives approximate captions from the
script plus the per-scene timings in `voice.json` — no transcription call, close
enough for most demos. (`render` picks this path automatically when
`AIDEMO_TTS_PROVIDER=local` and no STT endpoint or key is configured.)

## What leaves the machine

With the default config, the narration script goes to the TTS endpoint and the
narration audio to the transcription endpoint — that's the whole surface, and
only when you run `voice`/`captions`/`render`. Point the base URL at localhost
and nothing leaves at all. With `AIDEMO_TTS_PROVIDER=local`, nothing leaves
either — bytes only come *down* from huggingface.co, once, for the model
download (pre-seed the cache dir for true air-gapped installs). There's no
telemetry anywhere; `aidemo feedback` and `aidemo skill update` touch GitHub
only when you explicitly invoke them.

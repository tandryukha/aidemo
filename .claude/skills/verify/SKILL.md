---
name: verify
description: >
  Verify an engine change end-to-end by rendering the bundled fixture
  (examples/local-demo) and inspecting the output MP4 and intermediates. Use
  when the user says "verify", "run the smoke test", "e2e this change", "does
  the fixture still render", or before committing a nontrivial engine change.
  Knows the gotchas: OPENAI_API_KEY is needed for voice/captions but not
  probe/record/compose, stage-by-stage re-runs beat full re-renders,
  AIDEMO_KEEP_TMP=1 keeps .compose-tmp for compose debugging, logs/fail-*.png
  from failed takes. Do NOT use for: recording real product demos (use
  record-demo) or doc-only changes with no runtime surface.
allowed-tools: Bash, Read, Glob, Grep
---

# verify — e2e smoke test for engine changes

Your job: prove a change to the engine still renders the self-contained fixture
end-to-end. Be terse; surface only failures + a final status.

## Phases

1. **Typecheck** (always):
   ```bash
   npm run typecheck
   ```

2. **Fixture server** (background; it's a plain static server on :8787):
   ```bash
   node examples/local-demo/serve.mjs &
   curl -sf http://localhost:8787 >/dev/null && echo up
   ```

3. **Full e2e** (needs `OPENAI_API_KEY` in `.env` — check with
   `node bin/aidemo.mjs doctor` first):
   ```bash
   node bin/aidemo.mjs render examples/local-demo --headless
   ```
   If no API key is available, fall back to the keyless path and say so in the
   report: `probe` (selectors) + `record` + `compose` against previously
   generated `audio/`/`generated/` artifacts if present.

4. **Inspect the output** — existence is not enough:
   ```bash
   ffprobe -v error -show_entries format=duration -show_entries stream=codec_type \
     -of default=nw=1 examples/local-demo/output/final-demo.mp4
   ```
   Expect one video + one audio stream and a plausible duration (the fixture is
   ~30–60 s). A suspiciously tiny file or missing audio stream is a failure.

5. **Stage-scoped iteration** — if the change touches one stage, re-run just it
   (`voice`, `record`, `captions`, `compose`, or `probe` for selector work)
   instead of a full re-render; each stage is independently re-runnable.

6. **Cleanup**: kill the serve process from phase 2.

## Gotchas

- Logs: `examples/local-demo/logs/<command>.log`; failed takes leave
  `logs/fail-*.png/json` — read those before re-running blind.
- Compose hangs → look for an unbounded `apad` or `-stream_loop -1` in the
  filtergraph (they never EOF; see AGENTS.md ffmpeg gotchas).
- Captions missing from the output with no error → negative-pts stream-copy
  concat; the card assembly concat must re-encode.
- `AIDEMO_KEEP_TMP=1 node bin/aidemo.mjs compose examples/local-demo` keeps
  `.compose-tmp/` so you can ffprobe intermediate segments.
- Don't leave the fixture server running or the port collides on the next run.

## Report

```
verify: PASS|FAIL
typecheck: ok|errors
e2e: full render | keyless fallback (probe+record+compose) | skipped (why)
output: <duration>s, video+audio | anomaly: <what>
failures: <stage → cause → log excerpt>   (omit if none)
```

# Contributing to aidemo

Thanks for helping make agent-authored demo videos better. This doc covers the
practical stuff; for what the project is and how it works, start with the
[README](README.md).

## Dev setup

Prereqs: **Node 20+**, **Google Chrome**, **ffmpeg + ffprobe** on `PATH`.

```bash
git clone https://github.com/tandryukha/demo-engine.git
cd demo-engine
npm install
cp .env.example .env      # add OPENAI_API_KEY (used for TTS + Whisper captions)
```

No Playwright browser download is needed — the engine drives your system Chrome.

## Run the smoke test

Every change should keep the self-contained fixture rendering end-to-end:

```bash
node examples/local-demo/serve.mjs                          # terminal 1
node bin/aidemo.mjs render examples/local-demo --headless   # terminal 2
open examples/local-demo/output/final-demo.mp4
```

Also run the type check: `npm run typecheck`.

If your change touches one pipeline stage, you can iterate on just that stage —
each CLI step (`voice`, `record`, `captions`, `compose`) is independently
re-runnable, and `aidemo probe <dir>` dry-runs browser actions without TTS.

## Project layout

```
bin/aidemo.mjs        CLI entry (launches tsx → src/cli.ts)
src/                  pipeline stages: starter (init templates), voice, recorder,
                      captions, compose, capture (native/OBS), types (storyboard
                      schema — zod), distribute (skill install/update/feedback)
.claude/skills/record-demo/   the Claude Code skill (authoring layer)
examples/local-demo/  self-contained fixture + storyboard (the smoke test)
demos/                your local working area — untracked, not part of the repo
docs/                 public docs and README media
```

The storyboard schema lives in `src/types.ts` (zod). The authoring guidance —
action vocabulary, demo-director principles, ChatGPT-widget technique — lives in
`.claude/skills/record-demo/SKILL.md`; keep the two in sync when you change the
schema.

## Making changes

- **Bugs / feature requests:** open an issue (there are templates, including a
  structured one for feedback from recording sessions).
- **Recording-session feedback:** `aidemo feedback demos/<name>` pre-fills a
  context-rich issue from your session.
- **Pull requests:** keep them focused; describe the storyboard/flow you tested
  against. If behavior changes, update README/SKILL.md in the same PR.
- **Commit style:** short, imperative subject lines (`fix: compose hangs on
  unbounded apad`), matching the existing history.

## Developer Certificate of Origin (DCO)

Every commit must be signed off:

```bash
git commit -s -m "your message"
```

The `-s` flag adds a `Signed-off-by:` line certifying you wrote the change (or
have the right to submit it) under the project's MIT license — see
[developercertificate.org](https://developercertificate.org/). PRs with
unsigned commits can't be merged. This keeps the project's licensing options
clean without a heavyweight CLA.

## Scope

In scope for this repo: the engine, the CLI, the record-demo skill, adapters
for other coding agents, and the (planned) GitHub Action. Out of scope: hosted
cloud features (cloud browsers, credential vaults, team review UIs) — those are
deliberately not part of the open-source engine.

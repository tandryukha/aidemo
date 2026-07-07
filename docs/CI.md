# Re-rendering demos in CI (the aidemo GitHub Action)

Commit a storyboard, and CI keeps its demo media in sync — a fresh, narrated,
captioned MP4 (and GIF) on every relevant change. Because the recording is a
**deterministic replay** and the voice runs **locally**, this costs
**~$0 and needs no API key**.

- **Action:** `tandryukha/aidemo@stable` (defined by [`action.yml`](../action.yml))
- **Templates:** [`examples/workflows/`](../examples/workflows/) — auto-commit,
  PR-comment, cron-refresh
- **Self-test (this repo):** [`.github/workflows/demo-render.yml`](../.github/workflows/demo-render.yml)

## Why it's ~$0

aidemo splits into two loops with different cost models, and the split is
enforced by the engine's "no LLM in the capture loop" invariant:

| Loop | Where | LLM? | Marginal cost |
|---|---|---|---|
| **Authoring** — an agent reads your changelog and writes/updates `storyboard.json` | Local, in your agent (Claude Code, or any agent via the MCP server) | Yes | **$0** — rides your flat-rate subscription, not API tokens |
| **Render** — replay the committed storyboard → MP4 + GIF | **CI** (this Action) or local | **No** | **~$0** — see below |

Three things make the render loop cost effectively nothing:

1. **Deterministic replay.** The recording is a fixed action-spec driven in real
   Chrome — no model is in the capture loop, so a render burns zero LLM tokens.
   Cloud "AI recorder" tools spend tokens per take; aidemo doesn't.
2. **Content-hashed voice.** `aidemo voice` hashes each scene's text + voice plan
   and reuses the cached audio when nothing changed — a UI-only re-render
   re-voices nothing.
3. **Local Kokoro TTS.** With `tts: local` (the default) the voice is synthesised
   in-process by Kokoro-82M — **no OpenAI key at all**, and captions fall back to
   offline script-timing. The only cost is CI minutes on GitHub's free runners.

## Quick start

```yaml
# .github/workflows/demo.yml
name: demo
on:
  push:
    branches: [main]
    paths: ["demos/**", "!demos/**/output/**"]
permissions:
  contents: write
jobs:
  render:
    if: github.actor != 'github-actions[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with: { path: ~/.cache/huggingface, key: kokoro-${{ runner.os }}-q8 }
      - uses: tandryukha/aidemo@stable
        with:
          demos: demos/*
          gif: "true"
      - run: |
          git config user.name 'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          git add -A demos
          git diff --cached --quiet || (git commit -m 'chore(demo): re-render [skip ci]' && git push)
```

Prefer a ready-made file? Copy one of the [templates](../examples/workflows/).

## Inputs

| Input | Default | Notes |
|---|---|---|
| `demos` | *(required)* | Demo dir(s) to render, space/newline-separated; shell globs allowed (`demos/*`). Each needs `generated/storyboard.json`. |
| `command` | `render` | `render` \| `probe` \| `record` \| `compose` \| `voice` \| `captions` \| `gif`. |
| `tts` | `local` | `local` (Kokoro in-process, no key) or `openai` (needs `openai-api-key`). |
| `gif` | `false` | Also export `output/final-demo.gif` (render/compose). |
| `headless` | `true` | Chrome headless — required on CI (no display). |
| `dtype` | `q8` | Kokoro quantization: `q8` (~90 MB) \| `fp32` \| `fp16` \| `q4` \| `q4f16`. |
| `engine-ref` | `stable` | Engine git ref to install from `github:tandryukha/aidemo`. |
| `engine-path` | *(empty)* | Use an already-checked-out engine instead of installing (deps preinstalled). Mainly for this repo's self-test. |
| `openai-api-key` | *(empty)* | Only for `tts: openai`. Pass a secret; never hard-code. |
| `working-directory` | `.` | Where the demo paths are resolved from. |

Outputs: `media` (newline-separated list of rendered files) and `engine-bin`
(the CLI entry the action ran).

The action loops over every dir in `demos`, so re-rendering a whole onboarding
library is just `demos: content/onboarding/*` — no per-demo boilerplate.

## Runner requirements

The Action is **composite** — it runs on your job's runner, which must provide:

- **Node.js 20+** and npm on PATH. `ubuntu-latest` ships this; the templates also
  run `actions/setup-node` to pin a version.
- **Google Chrome / Chromium** — the recorder launches Chrome via Playwright's
  `channel: "chrome"` (it does **not** download a Playwright browser).
  `ubuntu-latest` ships Chrome.
- **ffmpeg + ffprobe** on PATH. `ubuntu-latest` does **not** ship ffmpeg, so add
  a step before the Action: `sudo apt-get update && sudo apt-get install -y
  ffmpeg` (every template in `examples/workflows/` does this).

The Action runs `aidemo doctor` as an informational preflight so you can see the
detected Chrome/ffmpeg/voice-provider in the logs. Self-hosted or minimal runners
must install Chrome + ffmpeg themselves.

## How local voice resolves in CI (the mechanism)

The engine's local provider does a lazy `import("kokoro-js")` from **its own**
module tree. An engine fetched with `npx github:...` lives in the npx cache,
where a consumer-side `npm i kokoro-js` is invisible. So the Action installs the
engine **and** `kokoro-js` into one throwaway prefix:

```bash
npm i --prefix "$RUNNER_TEMP/aidemo-engine" --no-save --ignore-scripts \
  github:tandryukha/aidemo#stable kokoro-js
```

`kokoro-js` lands as a **sibling** of the engine in the same `node_modules`, so
the engine resolves it by normal Node module lookup. `--ignore-scripts` keeps the
install script-free (the engine drives system Chrome, so Playwright needs no
browser download; Kokoro still runs). You don't have to think about any of this
— it's what the Action does for you.

## Caching the model

Kokoro's weights download from `huggingface.co` on the **first** run only, into
`~/.cache/huggingface` (transformers.js's cache; override with `HF_HOME`). Cache
it so later runs restore in seconds:

```yaml
- uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
  with:
    path: ~/.cache/huggingface
    key: kokoro-${{ runner.os }}-q8
```

A static key is fine — the model is immutable (bump the key if you change
`dtype`). For a fully air-gapped runner, pre-seed that directory and set
`HF_HUB_OFFLINE=1`.

## The three templates

See [`examples/workflows/README.md`](../examples/workflows/README.md) for the
full walkthrough.

- **`demo-autocommit.yml`** — push to `main` → re-render touched demos → commit
  media back to `main`. Keep `output/` **un-ignored**; loops are prevented with
  `[skip ci]` + an actor guard.
- **`demo-pr-comment.yml`** — pull request → render affected demos → sticky PR
  comment with the GIF **inline** (committed to the PR branch) + MP4 artifact.
  The flagship template — reviewers see the demo without leaving the PR.
- **`demo-cron-refresh.yml`** — weekly cron → re-render everything → open a PR
  via `peter-evans/create-pull-request` for review.

## Security

These templates are meant to be safe to copy into a public repo:

- Every third-party action is **pinned to a full commit SHA** with a version
  comment (let Dependabot bump them).
- `demo-pr-comment.yml` uses **`pull_request`, never `pull_request_target`**.
- `permissions:` is explicit and minimal on every workflow.
- Network egress is limited to `github.com`, `registry.npmjs.org`, Playwright's
  CDN (one-time ~2 MB ffmpeg recording helper) and `huggingface.co` (model
  download, `tts=local` only).

## Fork-PR caveat

On `pull_request` events, PRs **from forks** get a **read-only** `GITHUB_TOKEN`.
`demo-pr-comment.yml` therefore skips its commit-to-branch and sticky-comment
steps for fork PRs (guarded by a `head.repo.full_name == github.repository`
check) and reviewers use the uploaded `demo-media` artifact instead. This is the
correct, safe behavior — do not switch to `pull_request_target` with a PR-head
checkout to work around it.

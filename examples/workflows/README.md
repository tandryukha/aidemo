# aidemo CI workflow templates

Copy-paste these into your repo's `.github/workflows/` to re-render committed
demo storyboards in CI — **no LLM tokens, no API key**. They wrap the
[`tandryukha/aidemo`](https://github.com/tandryukha/aidemo) GitHub Action, which
replays your committed `storyboard.json` deterministically and voices it with an
in-process Kokoro model. See [`docs/CI.md`](../../docs/CI.md) for the full
recipe (why it's ~$0, runner requirements, caching, caveats).

Everything below assumes your demos live under `demos/<name>/` with a
`generated/storyboard.json` in each. Adjust the paths marked `←` in each file.

## The three templates

| File | Trigger | What it does | Perms |
|---|---|---|---|
| [`demo-autocommit.yml`](demo-autocommit.yml) | push to `main` (paths-filtered) | Re-render the touched demos and **commit the fresh MP4/GIF back to `main`**. | `contents: write` |
| [`demo-pr-comment.yml`](demo-pr-comment.yml) | `pull_request` (paths-filtered) | Render affected demos and post/update a **sticky PR comment with the GIF inline**; also uploads the MP4 as an artifact. | `contents: write`, `pull-requests: write` |
| [`demo-cron-refresh.yml`](demo-cron-refresh.yml) | weekly `cron` + manual | Re-render **all** demos and open a PR (`peter-evans/create-pull-request`) with the refreshed media for review. | `contents: write`, `pull-requests: write` |

## Choosing one

- **Docs/README media that must always match `main`** → `demo-autocommit.yml`.
  Media is committed straight to `main`. The demo `output/` dirs must **not** be
  gitignored, or there's nothing to commit. Loops are prevented by a
  `[skip ci]` commit message plus an `actor != github-actions[bot]` guard.
- **Reviewers should see the demo in the PR** → `demo-pr-comment.yml`. This is
  the flagship: the GIF renders inline in a sticky comment that updates on every
  push.
- **Keep a whole demo library fresh without touching it** → `demo-cron-refresh.yml`.
  A weekly job re-renders everything and opens a reviewable PR.

You can run more than one; they're independent.

## Adapting them

1. **Paths.** Replace `demos/**` / `demos/*` / `demos` with your storyboard
   dir(s). `demos:` accepts space- or newline-separated dirs and shell globs
   (`demos/*`, `content/demos/onboarding-*`).
2. **GIF path in the PR comment.** `demo-pr-comment.yml` embeds one GIF by URL;
   point `demos/example/output/final-demo.gif` at your actual demo's GIF.
3. **Local server, if your storyboard targets one.** If a storyboard's `goto`
   points at `http://localhost:PORT`, start that server in a step *before* the
   `tandryukha/aidemo` step (background it with `&` and wait for readiness), the
   way the engine's own `.github/workflows/demo-render.yml` starts its fixture
   server. Demos that target a public URL need nothing extra.
4. **OpenAI voice instead of local (optional).** Set `tts: openai` and
   `openai-api-key: ${{ secrets.OPENAI_API_KEY }}` on the action. Local voice is
   the default precisely so CI needs no secret.

## Security notes (read before copying into a public repo)

- Every third-party action is **pinned to a full commit SHA** with a version
  comment. Keep it that way; let Dependabot bump the SHAs.
- `demo-pr-comment.yml` uses **`pull_request`, never `pull_request_target`**.
  That means for PRs **from forks** the `GITHUB_TOKEN` is read-only: the
  commit-to-branch and sticky-comment steps are skipped, and reviewers use the
  uploaded `demo-media` artifact instead. This is the safe trade-off — do not
  "fix" it by switching to `pull_request_target` with a PR-head checkout, which
  would execute untrusted fork code with write permissions.
- `permissions:` is declared explicitly and minimally on every workflow.
- The only network egress is `github.com` (engine + your repo),
  `registry.npmjs.org` (npm deps) and `huggingface.co` (one-time Kokoro model
  download). No other endpoints are contacted.

## Caching

Each template caches `~/.cache/huggingface` (where transformers.js stores the
Kokoro model) with a static key, so only the very first run downloads the
~90 MB model; later runs restore it in seconds. Voice output is also
content-hashed per scene by the engine, so a UI-only change re-voices nothing.

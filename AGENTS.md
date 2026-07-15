# Working on aidemo — guide for coding agents

You are working **on** the demo engine, not just using it. The
[README](README.md) explains what aidemo is and why it's built this way;
[CONTRIBUTING.md](CONTRIBUTING.md) covers process (DCO sign-off, PR
expectations, CI policy). If this file contradicts them, they win.

**Mental model:** `storyboard.json` (script + per-scene voice/music plan +
browser action-spec) → `voice` (OpenAI TTS) → `record` (deterministic replay in
real Chrome, injected cursor, timeline) → `captions` (Whisper word timing) →
`compose` (ffmpeg: trim idle, sync to narration, zoom, cards, mux) →
`output/final-demo.mp4`.

## Commands

| Task | Command |
|---|---|
| Install | `npm install` — Node 20+, system Chrome, ffmpeg+ffprobe on PATH (no Playwright browser download) |
| Type check | `npm run typecheck` |
| Fixture server | `node examples/local-demo/serve.mjs` (port 8787) |
| E2E smoke test | `node bin/aidemo.mjs render examples/local-demo --headless` |
| Dry-run actions only | `node bin/aidemo.mjs probe examples/local-demo --headless` |
| One pipeline stage | `node bin/aidemo.mjs voice\|record\|captions\|compose <dir>` |
| Screenshot stills | `node bin/aidemo.mjs stills <dir>` — extract named PNGs from an existing take (also auto-runs in `render` when the storyboard has `still` markers) |
| Golden regression check | `node bin/aidemo.mjs probe <dir> --update-golden` (write baseline) / `--golden` (CI guard, non-zero exit on drift) |
| Multi-language matrix | `node bin/aidemo.mjs render <dir> --langs de,fr` — one take → N locales (also `--lang` on voice/captions/compose) |
| Personalized variants | `node bin/aidemo.mjs render <dir> --variants variants.json` (or `--param k=v`) |
| Always-fresh embed snippets | `node bin/aidemo.mjs embed <dir>` — stable raw-GitHub URLs for READMEs/PRs |
| CI render (consumers) | `uses: tandryukha/aidemo@stable` (composite action, `action.yml`) — see `docs/CI.md` |
| MCP server (agent interface) | `node bin/aidemo.mjs mcp` — stdio; smoke test: `npm run mcp-smoke` (needs Chrome) |
| Print authoring guide | `node bin/aidemo.mjs guide` |
| Environment check | `node bin/aidemo.mjs doctor` |

`render`, `voice`, and `captions` need `OPENAI_API_KEY` in `.env` (or
`OPENAI_BASE_URL` pointing at a local OpenAI-compatible server, or
`AIDEMO_TTS_PROVIDER=local` + `npm install kokoro-js` for in-process TTS with
offline captions — no key at all); `probe`, `record`, and `compose` re-runs
don't. Every engine change should keep the fixture rendering end-to-end
(that's the smoke test CI can't run for you — it needs Chrome, ffmpeg, and a
TTS/STT endpoint or the local provider).

## Layout

```
bin/aidemo.mjs        CLI entry (launches tsx → src/cli.ts)
src/types.ts          storyboard schema (zod) — the contract everything shares
src/                  pipeline stages: voice, recorder/player/cursor (record),
                      captions/caption-render, compose/zoom/cards/music/ffmpeg,
                      stills (screenshot mode), i18n (multi-language),
                      params/variants (personalized renders), golden (probe
                      regression), embed (always-fresh URLs), capture
                      (native/OBS), starter (init templates), distribute
                      (skill install/update/feedback, doctor, repo-init)
src/mcp/              the MCP server (server = tools/resources, jobs = job model)
docs/AUTHORING.md     canonical authoring guide — served by the engine
                      (MCP get_authoring_guide / `aidemo guide`)
action.yml            composite GitHub Action (uses: tandryukha/aidemo@stable)
docs/CI.md            CI render recipe; docs/EMBEDS.md always-fresh embeds
docs/plans/           deferred designs (e.g. public-mcp.md); docs/recipes/ how-tos
examples/workflows/   copy-paste consumer CI workflow templates
.claude/skills/       record-demo (thin adapter → AUTHORING.md) + dev skills
.claude-plugin/       marketplace.json — Claude Code plugin marketplace catalog
plugins/record-demo/  published plugin (bundles record-demo skill + aidemo MCP)
examples/local-demo/  self-contained fixture + storyboard — the smoke test
test/mcp-smoke.mjs    MCP-surface smoke test (local, needs Chrome)
demos/                untracked local working area
docs/                 public docs + README media (docs/internal/ is gitignored, private)
```

## Invariants — don't break these

- **No LLM in the capture loop.** The recording is a deterministic replay of a
  fixed action-spec. Agents author storyboards; they never steer a live take.
- **Schema ↔ authoring-doc sync.** `src/types.ts` is the storyboard schema;
  `docs/AUTHORING.md` is the canonical authoring guide that documents it
  (served to agents via the MCP `get_authoring_guide` tool and `aidemo guide`;
  `.claude/skills/record-demo/SKILL.md` is a thin adapter with no schema
  content). Change the schema → update `docs/AUTHORING.md` in the same commit.
- **Published plugin skill stays in sync.** The Claude Code plugin ships a copy
  of the record-demo skill at `plugins/record-demo/skills/record-demo/SKILL.md`.
  It must be byte-identical to `.claude/skills/record-demo/SKILL.md`. Edit the
  canonical one, then `npm run sync:plugin-skill`; `npm run check:plugin-skill`
  fails on drift. On a version bump, also bump `version` in
  `plugins/record-demo/.claude-plugin/plugin.json`.
- **ffmpeg portability.** Many ffmpeg builds lack `subtitles`/`drawtext`.
  Captions and cards are headless-Chrome-rasterized PNGs overlaid with
  time-gated `enable`. Don't add filters beyond that baseline.
- **Storyboards are backward compatible.** Cinematic and content features
  (zoom, scroll easing, ducking, cards, scene `transition` crossfades, `output`
  sizing/letterbox, `still` markers, `params`/placeholders, per-scene
  `narrations`) are opt-in; existing storyboards must render unchanged, and a
  run with no new flag must be byte-for-byte the old behavior.
- **Polish is compose-time, not record-time.** A bad zoom must stay a
  recompose, never a re-record.

## ffmpeg gotchas (learned the hard way)

- Stream-copy `concat` of `-loop 1` PNG→x264 card segments carries leading
  negative pts and **silently kills `overlay` captions** — the final card
  assembly must re-encode (`concatSegments(..., reencode: true)`); scene-only
  concat can stay stream-copy.
- Never use unbounded `apad`: it never EOFs and `-t` does **not** stop it
  (runaway encode until killed). Always `apad=whole_dur=<sec>`. Same class:
  `-stream_loop -1` through `atrim` never EOFs — loop a computed finite count.
- `zoompan`: use `on/FPS` as the time base (input must be CFR), single-quote
  every expression (they contain commas), and pre-upscale 2× below ~1600 px
  width or integer-pixel crops shimmer.
- Debugging compose: `AIDEMO_KEEP_TMP=1` preserves `.compose-tmp/`
  intermediates. Logs land in `<demo>/logs/<command>.log`; a failed take also
  leaves `logs/fail-*.png/json`.

## Repo conventions

- `demos/` is untracked scratch and `docs/internal/` is gitignored — never
  link to either from tracked files.
- Commit style: short imperative subject (`fix: compose hangs on unbounded
  apad`); every commit signed off (`git commit -s` — DCO, required to merge).
- CI is typecheck + gitleaks + dependency review. PRs must not add install
  scripts, new network endpoints, or unpinned GitHub Actions.
- Canonical repo: `github.com/tandryukha/aidemo`. Consumers run the engine via
  `npx -y github:tandryukha/aidemo#stable`; see RELEASING.md for how the
  `stable` tag moves.

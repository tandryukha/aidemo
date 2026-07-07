# Recipe: changelog → blog (the release-to-content flywheel)

Ship a release → an agent digests what changed → the demo storyboard gets
updated → CI renders fresh video/GIF/stills → a drafted post embeds that
always-fresh media → publish. Next release re-enters the same loop. This is
the P0 recipe: each piece (CI rendering, GIF export, screenshot stills) is
useful alone, but chained they add up to a content pipeline that stays
current with the product for free, forever, without anyone remembering to
update a demo video by hand.

Like every recipe in this repo, the loop splits into an authoring half and a
render half with different cost models — see
[docs/recipes/agents-in-ci.md](agents-in-ci.md) for the full breakdown and
the three ways to run the authoring half with nobody opening a laptop. In
short: authoring rides an agent subscription ($0 marginal), rendering runs in
CI with no LLM involved (~$0, no API key at all with local voice).

## The loop

```
release tag lands
  → agent reads commits/changelog since the previous tag
  → decides: is anything here demo-worthy?
      no  → stop, report nothing to do
      yes → update or create storyboard.json (+ per-language narrations,
            if multi-language output is wanted)
  → agent pushes a branch / opens a PR
  → CI renders MP4 + GIF + stills from the storyboard (LLM-free)
  → agent (or the same PR) drafts a post that embeds the fresh media
  → publish
  → next release re-enters the loop
```

## The agent prompt (copy-able)

This is the exact instruction block to hand to Claude Code, a scheduled
routine, or an equivalent agent. Adapt the paths to your repo's conventions;
the two worked examples below note where they'd differ.

```
You are refreshing this repo's demo content after a release.

1. Find the previous tag and the current one (or HEAD if unreleased):
     git describe --tags --abbrev=0
     git log <prev-tag>..<new-tag-or-HEAD> --oneline
   Also check CHANGELOG.md (if the repo has one) and merged PR titles in that
   range.

2. Decide: is anything in this range demo-worthy? A new user-facing flow, a
   meaningfully changed screen, a long-standing bug fixed that users hit
   constantly. If nothing qualifies, stop here and report "no demo-worthy
   change this cycle" — do not force a video out of an invisible refactor.

3. If something qualifies:
   a. Call the aidemo MCP `get_authoring_guide` tool (or read
      docs/AUTHORING.md) and `get_storyboard_schema` before editing JSON.
   b. Update the existing storyboard (commonly
      demos/<name>/generated/storyboard.json) or `init_demo` a new one to
      reflect the new flow: add scene(s) for what changed, trim scenes for
      what's gone stale. Keep narration to ~2.5 words/sec, hook first, CTA
      last — see AUTHORING.md for the full authoring conventions.
   c. If stills are wanted for a store listing, README, or the post itself,
      mark the relevant beats for screenshot-mode capture rather than
      hand-cropping a video frame.
   d. If multi-language output is wanted (e.g. a bilingual audience), note
      which locales this release's render should target instead of
      hand-writing translated narration — the engine derives per-language
      narration/captions from one recorded take.
   e. Call `validate_storyboard` and fix any reported issues before
      proceeding.
   f. Do not render locally unless this environment actually has Chrome and
      ffmpeg available. If it does, run a `probe` (record-only dry run)
      first to catch selector drift before pushing — CI will otherwise be
      the first place a stale selector shows up.

4. Write a short draft post (150-300 words, plain language, no hype) to the
   repo's posts directory (e.g. content/posts/<date>-<slug>.md, front matter:
   title, date, tags) with one embed placeholder for the release's demo,
   resolved at publish time to the always-fresh render rather than a
   hand-uploaded file.

5. Push a branch (e.g. demo-refresh/<tag>) and open a PR containing the
   storyboard diff, the draft post, and one line on what changed and why
   it's (or isn't) demo-worthy.
```

Step 3c/3d reference two engine features — screenshot-mode `still` markers
and `--lang` multi-language renders — that are landing in the same release as
this doc. **Verify the exact marker syntax and flag name against
[docs/AUTHORING.md](../AUTHORING.md) and [docs/CI.md](../CI.md) once merged**;
until then, treat those two sub-steps as forward-looking guidance rather than
a command you can run today.

## Wiring (CI side)

The rendering half of this loop is the same GitHub Action stack documented in
[docs/CI.md](../CI.md):

- The `tandryukha/aidemo@stable` composite action wraps `probe`/`record`/
  `voice`/`captions`/`compose`/`gif` so a workflow doesn't have to reimplement
  the pipeline.
- `examples/workflows/demo-cron-refresh.yml` (or `demo-autocommit.yml` on tag
  push) is the render step this recipe's step 5 PR triggers.
- `examples/workflows/demo-pr-comment.yml` surfaces the fresh render inline
  on the PR opened in step 5, so a human reviewer sees the actual video
  before merging.
- `examples/workflows/demo-publish.yml` handles the publish-time embed swap —
  see [docs/EMBEDS.md](../EMBEDS.md) for how the draft post's embed
  placeholder resolves to a stable, always-fresh URL.

## Worked examples

### maxfit.ee — a news post per product-improving release

- **Trigger:** a release that changes something a customer would notice,
  merged to `main`.
- **Authoring:** the release PR's own agent session (or a routine triggered
  by the merge) runs the prompt above, scoped to "since the last release."
- **Output:** a short news post per qualifying release, embedding the fresh
  demo — the product visibly keeps improving in public, without a
  human writing a changelog blurb every time.
- **Cadence:** per release, skipping releases with nothing demo-worthy (step
  2's "no" branch matters here — not every release needs a post).

### A solo dev's weekly "what got better" digest — cron-driven

- **Trigger:** cron, e.g. every Monday, independent of whether a discrete
  "release" happened that week.
- **Authoring:** a scheduled Claude cloud routine (see
  [docs/recipes/agents-in-ci.md](agents-in-ci.md), option (b)) runs the same
  prompt scoped to "since last week," across possibly several small merges
  rather than one tagged release.
- **Output:** a weekly digest post, so content keeps shipping even in weeks
  where nothing felt individually announcement-worthy — the accumulation of
  small merges over a week usually *is* demo-worthy, even if no single merge
  was.
- **Cadence:** weekly, decoupled from the release cadence entirely.

## Cost model

- **Authoring:** $0 marginal — the agent step above runs on a flat-rate
  subscription (Claude Code, Copilot seat, or equivalent), not per-token API
  billing. See [agents-in-ci.md](agents-in-ci.md) for the three ways to wire
  this so nobody has to trigger it by hand.
- **Rendering:** ~$0 in CI — no LLM involved at all; no API key required if
  the repo uses the local Kokoro voice provider (`AIDEMO_TTS_PROVIDER=local`)
  or has already content-hashed/cached its voice manifest. A few cents per
  minute of narration if using uncached OpenAI TTS instead.
- **Net:** a demo-video content pipeline with no recurring bill beyond an
  agent subscription most teams already pay for.

## See also

- [docs/recipes/agents-in-ci.md](agents-in-ci.md) — the three ways to run
  this recipe's authoring step with nobody opening a laptop, and the
  cost-model split this recipe assumes throughout.
- [docs/CI.md](../CI.md) — the Action and workflow templates this recipe's
  wiring section names.
- [docs/EMBEDS.md](../EMBEDS.md) — how a draft post's embed placeholder
  resolves to always-fresh media.
- [docs/plans/public-mcp.md](../plans/public-mcp.md) — a hosted-MCP option
  (not yet built) for running the authoring step with no local repo/agent
  setup at all.
- [docs/AUTHORING.md](../AUTHORING.md) — the storyboard schema and authoring
  conventions the prompt above is written against.

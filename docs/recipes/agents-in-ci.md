# Recipe: fully autonomous demo refresh, three ways

Three ways to get a demo storyboard updated with **nobody opening a laptop**
— an agent notices something worth demoing, edits `storyboard.json`, and CI
renders it. These are recipes, not integrations: aidemo stays agent-neutral,
none of them need a new engine dependency, and nothing here is required to
use the engine at all.

Each option splits cleanly into two halves with different cost models, and
that split is the point:

| Half | Where it runs | Uses an LLM? | Marginal cost |
|---|---|---|---|
| **Authoring** — read the changelog/diff, decide what changed, write/update `storyboard.json` | The agent | Yes | Usually **$0** — rides a flat-rate subscription, not metered API tokens |
| **Render** — replay the committed storyboard → MP4/GIF/stills | CI | **No** | **~$0** — voice is content-hashed per scene, and the local Kokoro provider (`AIDEMO_TTS_PROVIDER=local`) removes the API key requirement entirely; an uncached OpenAI TTS pass is a few cents/minute if you don't use it |

All three options below keep the render half identical (CI, LLM-free) and
differ only in *who* does the authoring and *how it's billed*. See
[docs/CI.md](../CI.md) for the Action and workflow templates every option
here pushes into, and
[docs/recipes/changelog-to-blog.md](changelog-to-blog.md) for the concrete
prompt/runbook that turns "authoring" into an actual step-by-step recipe.

## (a) GitHub Copilot coding agent

**What it is:** GitHub's own coding agent, included in paid Copilot seats. It
runs inside GitHub Actions (no separate compute to provision), reads a
repo's `AGENTS.md`, and supports MCP servers configured in the repo — so it
can call `get_authoring_guide` / `get_storyboard_schema` / `validate_storyboard`
the same way any other MCP-aware agent does.

**Flow:**

1. Assign or `@mention` it on an issue or PR: `@copilot update the release
   demo storyboard for vX.Y.Z`.
2. Copilot's agent reads the repo's `AGENTS.md` and (if the aidemo MCP server
   is registered for it) calls `get_authoring_guide` /
   `validate_storyboard` before touching JSON; if MCP isn't wired up for your
   Copilot config yet, it can still edit `storyboard.json` directly per
   [docs/AUTHORING.md](../AUTHORING.md) — the schema is plain, documented
   JSON either way.
3. It opens a PR with the storyboard diff.
4. The aidemo GitHub Action (see [docs/CI.md](../CI.md)) renders the
   storyboard on that PR and comments the fresh MP4/GIF inline
   (`demo-pr-comment.yml`).

**Cost:** Copilot premium request budget — a seat you likely already pay for.
No new vendor, and no API key for aidemo itself if the repo uses local voice.

**Gotcha:** Copilot coding agent's MCP configuration surface is still
evolving — confirm your GitHub plan actually exposes it before depending on
it. The fallback (plain storyboard edits per AUTHORING.md, no MCP needed) always
works, since Copilot can edit a documented JSON file with or without tool
access to the engine.

## (b) Scheduled Claude cloud agents / Claude Code routines

**What it is:** a Claude Code routine (or any scheduled cloud agent) that
wakes on a cron schedule, does the authoring work, and pushes a branch — no
one has to trigger it. Billed against the subscription, not per API token.

**Flow:**

1. A routine runs on a schedule (e.g. weekly, or on every push to `main`).
2. It reads commits/changelog since the last run, decides whether anything
   is demo-worthy, and — if so — updates or creates `storyboard.json` (the
   exact prompt for this step is the runbook in
   [changelog-to-blog.md](changelog-to-blog.md)).
3. It calls `validate_storyboard` to schema-check before pushing. It does
   **not** call `record`/`render` itself — a routine's cloud sandbox has no
   Chrome or ffmpeg, so asking it to produce pixels directly will fail; the
   actual render belongs to CI, not the routine.
4. It pushes a branch and opens a PR (or commits straight to `main`,
   depending on the consumer repo's conventions — see
   [docs/CI.md](../CI.md) for the auto-commit vs. PR-comment workflow
   choice).
5. The aidemo Action renders LLM-free on that branch/PR.

**Worked example:** the solo-dev weekly digest in
[changelog-to-blog.md](changelog-to-blog.md) — a routine that runs whether or
not a "real" release happened that week, so marketing content exists even in
weeks nobody manually wrote an announcement.

**Cost:** flat-rate subscription for the authoring half; the render half is
the same $0-ish CI cost as every other option.

**Gotcha:** if the routine needs to *probe* selectors locally before trusting
its own storyboard edit, it needs an environment with Chrome — most scheduled
cloud-agent sandboxes don't have one. Default to: author, validate the schema,
push, and let CI's own `probe`/`render` step be the first real dry run. If a
probe fails there, the PR shows it (failure artifacts, per
[docs/AUTHORING.md](../AUTHORING.md)'s job-error shape) instead of silently
shipping a broken demo.

## (c) claude-code-action with an API key

**What it is:** the GitHub Action that wraps Claude Code itself, triggered by
a repo event (issue comment, label, schedule), billed against an Anthropic
API key stored as a repo secret.

**Flow:** identical shape to (a)/(b) — it edits `storyboard.json` (using the
aidemo MCP tools if registered, or by hand per AUTHORING.md), opens a PR, and
the aidemo Action renders it.

**When to use it:** document this option for teams that already run
`claude-code-action` for other things and want the same mechanism for demo
refresh — **never required**. Both (a) and (b) get full autonomy without a
per-token bill; this is the one path here that has a marginal LLM cost per
run, since it's metered API usage rather than subscription-billed. Call that
out to anyone picking between the three: it's the only option that breaks the
"$0 marginal" property the other two keep.

## Which one to pick

| You already have | Use |
|---|---|
| GitHub Copilot seats, no Claude subscription | (a) |
| A Claude subscription, want zero extra CI/vendor setup | (b) |
| `claude-code-action` already standardized on for other repo automation | (c) — knowing it's the one with a per-run token cost |

None of these are mutually exclusive with rendering the same storyboard
locally or manually — they're just the "nobody has to remember to do this"
layer on top of the same engine, same schema, same `AGENTS.md`/AUTHORING.md
contract every other authoring path uses.

## See also

- [docs/CI.md](../CI.md) — the GitHub Action and workflow templates
  (`demo-autocommit.yml`, `demo-pr-comment.yml`, `demo-cron-refresh.yml`) all
  three options push into.
- [docs/recipes/changelog-to-blog.md](changelog-to-blog.md) — the concrete
  release→content runbook, with a copy-able agent prompt for the authoring
  step.
- [docs/plans/public-mcp.md](../plans/public-mcp.md) — a fourth, not-yet-built
  option: a hosted MCP endpoint for authoring with no local install and no
  CI of your own at all.
- [docs/AUTHORING.md](../AUTHORING.md) — the schema/tool contract every
  option above authors against.

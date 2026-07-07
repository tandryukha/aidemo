# Plan: hosted public aidemo MCP service

**Status: planned, deliberately not started.** This is a deferred design, not
a roadmap commitment. It costs real money to host (compute for headless
Chrome, storage for artifacts, abuse handling); the [GitHub
Action](CI.md) does not — it renders on the user's own CI minutes, with no
server for anyone to run. The Action ships first and covers the CI-rendering
use case at $0. This doc exists so that if/when the [launch gate](#launch-gate)
trips, the design work is already done.

## Why

Today, using aidemo means: clone or `npx` the engine, have Node + system
Chrome + ffmpeg on PATH, and either an OpenAI-compatible endpoint or the local
Kokoro voice provider. That's a light install by video-tooling standards, but
it's still an install. A **hosted** MCP endpoint removes it entirely: an agent
(Claude, Codex, Copilot, Gemini — any MCP client) points at a URL and gets the
same `get_authoring_guide` / `validate_storyboard` / `render` / `job_status`
surface described in [docs/AUTHORING.md](../AUTHORING.md), with zero local
install. That opens the door to contexts where local install isn't practical
at all: a cloud agent session with no persistent disk, a CI runner that isn't
this repo's own, a lightweight chat client with tool-calling but no shell.

This **complements, not replaces** local and CI rendering. Local/CI stays the
default for anyone who already has an agent + a repo — it's free, it's
private (nothing leaves the machine except the TTS/STT calls the user already
opts into), and it's the only option for anything that needs a logged-in
Chrome profile (see [Non-goals](#non-goals-now)). The hosted service is for
the case where none of that is available yet and the alternative is "install
first, demo later" — see [docs/recipes/agents-in-ci.md](../recipes/agents-in-ci.md)
for the local/CI-first recipes this sits alongside.

## Architecture sketch

The job model already exists (`src/mcp/jobs.ts`, wrapped by `src/mcp/server.ts`)
and this service reuses its shape rather than inventing a new one: a tool call
starts a job and returns a `jobId` immediately; `job_status` polls stage,
progress, and result. What changes for the hosted case is everything *around*
that shape — multi-tenancy, isolation, and where the bytes end up.

- **Transport.** [Streamable HTTP](https://modelcontextprotocol.io) is the MCP
  spec's remote-server transport. The engine's one MCP dependency,
  `@modelcontextprotocol/sdk`, already bundles the HTTP-transport helpers —
  today's stdio-only server just never constructs them (see README → Security
  & trust). The hosted service is where they'd finally get used. This service
  is **not** a mode of the stdio server described in AGENTS.md/README —
  per the open-core boundary this repo already draws (engine/CLI/skill/Action
  = open, in this repo; a hosted cloud layer = a separate service), it lives
  in its own repo and deploys independently. This plan doc describes that
  future repo's design, not a change to `src/mcp/server.ts`.
- **Sandboxed render workers.** Rendering means driving a real headless
  Chrome against a URL the caller supplies — that's the hard security
  problem here, not a footnote. Treat it like running arbitrary untrusted
  code, because it is:
  - **Per-job container.** Every job gets a fresh, ephemeral container/VM;
    nothing persists between jobs. No shared browser profile, no shared
    cookies, no shared disk — one job can never see another's state. This is
    a hard requirement, not an optimization: the whole engine's local model
    assumes a *private* Chrome profile, and hosted must not silently violate
    that assumption.
  - **Egress allowlist per registered project.** A job's browser gets network
    access only to the origin(s) the registered project owner confirmed at
    registration time — default deny-all otherwise. Anonymous/unregistered
    jobs get an even smaller, pre-vetted allowlist (e.g. the bundled fixture
    site), not "any URL," until there's an identity attached to the request.
  - **Resource caps.** Wall-clock timeout per job (mirroring the per-scene
    timeouts the recorder already enforces locally), CPU/memory ceilings
    enforced by the container runtime (not the app, so a misbehaving job
    can't talk its way out of them), and an output-size cap.
- **Artifact storage.** Rendered MP4/GIF/stills land in object storage behind
  **signed, expiring download URLs** — never a public-by-default bucket.
  Retention window differs by tier (free short, paid longer); exact numbers
  are a launch-time decision, not a design constraint here. This overlaps
  with [docs/EMBEDS.md](../EMBEDS.md)'s always-fresh-embed story, with one
  difference: embeds assume a stable URL that keeps serving a repo's own
  latest render; hosted artifacts additionally need to *expire*, since nobody
  is paying to keep everyone's renders forever.
- **Job queue.** One logical queue, a priority lane for paid jobs, and
  concurrency caps per tier (see [Tiering](#tiering)). Position is reported
  honestly — "you're #4, ~3 min" — rather than hidden.

## Tiering

- **Free tier** — anonymous or lightly-registered (see
  [Agent-first registration](#agent-first-registration)), strictly
  rate-limited, and **queued**: jobs run when capacity is idle, and the
  caller is told its queue position rather than getting an instant render.
  Honest "your job is #N in queue" UX beats a fake instant-render promise the
  service can't actually keep at zero fixed cost.
- **Paid tier** — priority queue placement, higher concurrency, longer
  artifact retention. Subscription-priced **only if free-tier interest
  proves demand first** — no numbers here, this is explicitly
  decision-gated. The template to follow if/when that happens is Remotion's
  own pivot: ship free/open, then introduce public, transparent pricing once
  traction is real, rather than guessing a price up front.

## Agent-first registration

The one design constraint the owner cares about most: **registration must be
completable by an agent, mid-session, without a human ever opening a
browser tab on their own initiative.** Two paths:

1. **GitHub OAuth device flow (primary).** An MCP `register` tool starts the
   standard device-authorization grant (RFC 8628) — the same mechanism `gh
   auth login` and the Docker CLI already use for headless auth. The tool
   returns `{ verification_uri, user_code, expires_in }`; the agent's job is
   just to surface that one-time code and URL to its human in whatever
   channel it has ("open https://github.com/login/device and enter
   `ABCD-1234`") — something coding agents already do routinely. The agent
   (or a background poll) then calls a follow-up tool with the device code
   until the human approves; the server exchanges it for a GitHub identity
   and mints an API key **bound to that identity**, returned once. No form,
   no password, no human-only step beyond clicking "approve" on a page
   GitHub itself renders.
2. **Verified-email magic link (fallback).** For agents/humans without
   GitHub: `register` accepts an email, sends a one-time link, and the agent
   polls the same way until it's clicked. Strictly a fallback — device flow
   is the primary path because it needs no email round-trip and ties
   identity to an account most developers already have.
- **Key scoping.** A key is bound to an identity and, once a project is
  registered, to that project's egress allowlist — the human confirms which
  origin(s) their storyboards may navigate to at registration time, not the
  agent unilaterally.
- **Quota visible via an MCP tool.** A `quota` (or equivalent) tool reports
  tier, remaining renders, current queue depth, and reset window at any time
  — an agent can check "am I about to hit a wall" without leaving the
  session.
- **Self-upsell, no browser required.** The whole anonymous → registered-free
  → paid ladder is designed to be climbable from inside one MCP session: an
  anonymous job hitting its rate limit gets an error whose text says "call
  `register` to raise your limit"; a registered-free caller hitting the free
  queue/quota ceiling gets a `quota` response that names the upgrade path (a
  checkout link the agent can hand to its human). The agent never has to stop
  and say "go install something" — every next step is another tool call.

## Cost model at launch

Target **$0 fixed cost**: a queue on one small always-on box, or a
scale-to-zero container platform that pays for compute only while a job is
actually rendering (a render is seconds-to-low-minutes of CPU). Free-tier
concurrency is capped at **1** globally at launch — the entire free tier
shares one worker slot. That's the cheapest possible "it actually works"
while the launch gate is being evaluated, and it doubles as the honest
queue-depth signal callers see.

## Launch gate

Build this only when there's a concrete interest signal, not a hunch. Track,
starting from when the GitHub Action ships:

- **Waitlist signups** — a simple form or a pinned "who wants hosted
  rendering" GitHub issue people can react to or comment on.
- **Issue reactions** — 👍 count on that same tracking issue.
- **Action adoption** — number of distinct repos actually using the GitHub
  Action (a proxy for "people who'd rather not run CI at all if they didn't
  have to").

No specific threshold is pre-committed here on purpose — the owner reviews
these counters periodically (e.g. each release) and decides when the trend,
not a single magic number, justifies the hosting cost. That review is the
gate; these three counters are what it reviews.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Abuse: crypto-miner / arbitrary-compute URLs.** A "render this URL" primitive is a free compute-execution primitive if unbounded. | Per-job resource caps (CPU/memory/wall-clock) enforced by the container runtime, ephemeral per-job containers (no persistent workers to keep mining), no job runs longer than a demo plausibly needs. |
| **SSRF via internal URLs.** A job's headless browser could be pointed at cloud metadata endpoints (`169.254.169.254`) or private/internal addresses reachable from the render network. | Deny-by-default egress allowlist scoped per registered project (public origins only); explicit block of link-local and RFC1918 ranges regardless of what's on an allowlist; resolve-once-and-pin DNS to defeat DNS-rebinding attacks against the allowlist check. |
| **Copyright / recording someone else's site without the right to.** | Registration ties a project to a human-confirmed origin allowlist — an implicit assertion the registrant has the right to record it, the same posture any headless-browser screenshot service takes. Anonymous tier is restricted to a small pre-vetted playground, not arbitrary URLs, so this risk barely exists before an identity is attached. |
| **A single free worker slot becomes a denial-of-service vector for other free users.** | Per-key/per-IP concurrency cap of 1 in addition to the global cap; honest queue-position reporting turns "why is nothing happening" into a visible, expected wait rather than a black box worth abusing. |

## Relationship to "no LLM in the capture loop"

This service does not change that invariant — it can't, because it never
runs an agent loop at all. A `render`/`record` job here takes an
**already-authored** `storyboard.json` and replays it deterministically,
exactly like the local and CI paths do. The service never authors, never
edits a storyboard, and never steers a live take with an LLM. Authoring stays
100% client-side, in the caller's own agent, on the caller's own subscription
or API budget — the hosted service only ever receives a finished spec to
replay. In flywheel terms (see
[docs/recipes/changelog-to-blog.md](../recipes/changelog-to-blog.md)), this
is a second render substrate alongside local and CI, not a new place for
tokens to get spent: the marginal cost here is *our* compute bill for running
someone's already-written storyboard, not an LLM call.

## Non-goals (now)

- **Logged-in / credentialed recording.** Anything that needs a real,
  logged-in Chrome profile (the ChatGPT-app / Apps-SDK recording story in
  README, or any authenticated product) stays local-only. Hosting someone
  else's session cookies is a fundamentally different trust model than
  hosting a headless render of a public URL, and isn't part of this plan.
- **Team dashboards, brand kits, project history UI.** Those are the "Web
  UI" roadmap item in README, independent of whether rendering itself is
  hosted.
- **Multi-region, SLAs, enterprise SSO.** Not before there's a paid tier to
  justify them.
- **Bring-your-own-cloud-browser / self-hosting this service.** Out of scope
  for this plan; the engine itself stays fully self-hostable regardless.

## See also

- [docs/CI.md](../CI.md) — the GitHub Action that ships first and covers the
  $0 CI-rendering case this plan is deliberately deferred behind.
- [docs/recipes/agents-in-ci.md](../recipes/agents-in-ci.md) — three ways to
  get fully autonomous authoring today, entirely on local/CI rendering, no
  hosted service required.
- [docs/recipes/changelog-to-blog.md](../recipes/changelog-to-blog.md) — the
  release→content flywheel this service would plug into as an alternative
  render substrate, not a replacement for it.
- [docs/EMBEDS.md](../EMBEDS.md) — the always-fresh-embed mechanics this
  plan's signed-URL artifact storage overlaps with.

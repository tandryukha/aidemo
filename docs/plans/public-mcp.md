# Plan: hosted public aidemo MCP service

**Status: committed to build (2026-07-07).** Targeting a dedicated **new AWS
account**, hosted properly — scale-to-zero so idle cost is ~$0, and one clean
blast-radius boundary. The free tier ships behind a hard **$50/month
variable-cost cap** (see [Free-tier budget guarantee](#free-tier-budget-guarantee-the-50month-cap))
so the downside is bounded and known before a single user shows up. The
[GitHub Action](../CI.md) still ships first and still covers the CI-rendering
case at **$0** — hosted *complements* it for the narrow slice with neither a
local shell nor a CI repo (cloud chat clients, ephemeral agent sessions with no
persistent disk). The old [launch gate](#launch-gate) no longer blocks
*building* the bounded free tier; it now gates only when the **paid** tier
turns on.

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
that shape — multi-tenancy, isolation, and where the bytes end up. It lives in
its **own repo** and its **own dedicated AWS account** (an AWS Organizations
member account, so a runaway bill or a compromised render worker is
blast-radius-boxed away from everything else), with an account-level **AWS
Budgets** alarm and, ideally, a spend-ceiling SCP as coarse backstops. Every
choice below defaults to **scale-to-zero** so idle cost is ~$0.

- **Transport — the MCP control plane.**
  [Streamable HTTP](https://modelcontextprotocol.io) is the MCP spec's
  remote-server transport. The engine's one MCP dependency,
  `@modelcontextprotocol/sdk`, already bundles the HTTP-transport helpers —
  today's stdio-only server just never constructs them (see README → Security
  & trust). The hosted service is where they'd finally get used. This service
  is **not** a mode of the stdio server described in AGENTS.md/README —
  per the open-core boundary this repo already draws (engine/CLI/skill/Action
  = open, in this repo; a hosted cloud layer = a separate service), it lives
  in its own repo and deploys independently. This plan doc describes that
  future repo's design, not a change to `src/mcp/server.ts`. On AWS the control
  plane is light (tool calls enqueue a job and return a jobId; `job_status` is
  a poll), so it runs on the smallest **ECS Fargate** service behind an **ALB**
  — or on **Lambda** (function URL) if the surface stays poll-based and never
  needs long-lived SSE.
- **Sandboxed render workers — one ephemeral Fargate task per job.**
  Rendering means driving a real headless Chrome against a URL the caller
  supplies — that's the hard security problem here, not a footnote. Treat it
  like running arbitrary untrusted code, because it is:
  - **Per-job container → a fresh Fargate task per job** (ECS `RunTask`),
    which exits when the render finishes. Nothing persists between jobs — no
    shared browser profile, no shared cookies, no shared disk; one job can
    never see another's state. This is a hard requirement, not an optimization:
    the whole engine's local model assumes a *private* Chrome profile, and
    hosted must not silently violate that assumption.
  - **Egress allowlist per registered project.** The render task runs in a
    **private subnet with no route to the VPC's internal ranges**; all outbound
    goes through an **egress-filtering proxy** (allowlisted origins only) or
    **AWS Network Firewall** with domain rules — default deny-all. Access is
    granted only to the origin(s) the registered project owner confirmed at
    registration time. Anonymous/unregistered jobs get an even smaller,
    pre-vetted allowlist (e.g. the bundled fixture site), not "any URL," until
    there's an identity attached to the request. Link-local and RFC1918 ranges
    are blocked regardless of what's on an allowlist, and DNS is
    resolve-once-and-pin to defeat rebinding. **Also block the ECS
    task-metadata endpoint (`169.254.170.2`) and IMDS (`169.254.169.254`)** so
    a hostile storyboard can't navigate the browser to them and harvest the
    task role's temporary credentials.
  - **Resource caps.** Fargate task CPU/memory sizing is the hard ceiling (the
    app can't talk its way past a runtime limit), plus a wall-clock
    `stopTimeout` and an app-level **5-min job timeout** (mirroring the
    per-scene timeouts the recorder already enforces locally), and an
    output-size cap. The task role is **least-privilege**: write to one S3
    prefix, read its own job record, nothing else — so even a credential leak
    buys an attacker almost nothing.
- **Artifact storage → S3.** Rendered MP4/GIF/stills land in an S3 bucket
  behind **presigned, expiring download URLs** — never a public-by-default
  bucket — with an **S3 lifecycle policy** for tier-based retention (free
  short, paid longer; exact numbers are a launch-time decision). This overlaps
  with [docs/EMBEDS.md](../EMBEDS.md)'s always-fresh-embed story, with one
  difference: embeds assume a stable URL that keeps serving a repo's own latest
  render; hosted artifacts additionally need to *expire*, since nobody is
  paying to keep everyone's renders forever.
- **Job queue → SQS.** One logical queue, a small dispatcher (a Lambda on the
  SQS trigger, or the control plane itself) that launches Fargate tasks up to
  the concurrency cap (1 at launch), and a priority lane for paid jobs.
  Position is reported honestly — "you're #4, ~3 min" — rather than hidden.
- **Identity, keys, quota, budget → DynamoDB.** API keys bound to a GitHub
  identity, per-identity daily/monthly quota counters (atomic, TTL-expiring
  windows), and the **global monthly spend meter** all live in DynamoDB and are
  checked atomically *before* dispatch. Secrets (GitHub OAuth app secret,
  OpenAI key) live in **Secrets Manager / SSM Parameter Store**. Per-IP
  limiting for the anonymous tier is **AWS WAF** rate-based rules on the ALB.

## Tiering

- **Free tier** — anonymous or lightly-registered (see
  [Agent-first registration](#agent-first-registration)), strictly
  rate-limited, and **queued**: jobs run when capacity is idle, and the
  caller is told its queue position rather than getting an instant render.
  Concrete launch limits: **5 renders/day, 25/month per GitHub identity**;
  anonymous (no account) gets **2–3 renders/day/IP on pre-vetted origins
  only**; global concurrency **1**. Honest "your job is #N in queue" UX beats a
  fake instant-render promise the service can't keep at zero fixed cost.
- **Paid tier** — priority queue placement, higher concurrency, longer
  artifact retention. **Priced flat (subscription or credit pack), never
  per-token / per-render-minute** — per-render compute is predictable
  (seconds-to-low-minutes), so metering pennies isn't worth the billing infra
  or the buyer's per-call anxiety; a card on file also doubles as the paid
  tier's uniqueness proof. Turned on **only if free-tier interest proves demand
  first** — no numbers here, this is explicitly decision-gated. The template to
  follow if/when that happens is Remotion's own pivot: ship free/open, then
  introduce public, transparent pricing once traction is real, rather than
  guessing a price up front. (Remotion's *metered* tier exists because its
  renders are heavy synthetic compositions; ours are seconds of deterministic
  replay, so a flat price fits.)

## Free-tier budget guarantee (the $50/month cap)

The hard promise: **total variable cost never exceeds ~$50/month ex-VAT**,
known before a single user shows up. The trap to avoid up front: **per-user
rate limits do not bound total spend** — cap each user at 25 renders/month and
500 users still cost you 12,500 renders. Only a global meter guarantees the
ceiling. So four nested limits, outermost is the guarantee:

1. **Global monthly budget meter — the actual cap.** A counter in DynamoDB,
   decremented by each render's estimated cost and checked atomically *before*
   dispatch. At the ceiling the free tier closes until reset: `budget
   exhausted, resets on the 1st — register a paid key to continue`. AWS Budgets
   is only a coarse backstop here (it lags hours); the real-time hard stop is
   this app-level counter.
2. **Per-render bounds — make each render's cost a known ceiling.**
   - Narration ≤ **~1,200 chars / ~90 s audio** (TTS cost is linear in this,
     and it's the product's 30–60 s sweet spot anyway).
   - Hard **5-min job timeout** (Fargate `stopTimeout` + app timeout) — kills
     runaway / crypto-mining jobs.
   - Max output **1080p** (4K is ~4× the encode + egress for no free-tier
     benefit).
3. **Per-identity quota — fair distribution.** 5 renders/day, 25/month per
   GitHub identity → ~40 heavy or ~200 light users before the global cap trips.
4. **Concurrency = 1 global at launch — worker + cost protection.** The whole
   free tier shares one Fargate slot; queued with honest position reporting.

Unit economics behind the numbers (plug in current OpenAI/AWS rates — these are
order-of-magnitude, and note you must meter **total** variable cost, not just
"AI spend": compute + egress are real and were the thing the original framing
undercounted):

| Component | Rate (assumed) | Per ~90 s render |
|---|---|---|
| TTS (OpenAI, ~90 s narration, HD-ish) | ~$15–30 / 1M chars | ~$0.02–0.04 |
| STT (Whisper, 90 s) | $0.006 / min | ~$0.01 |
| Compute (Fargate, ~3 min, ~2 vCPU / 4 GB) | ~$0.04 / vCPU-hr + mem | ~$0.005–0.02 |
| Egress + S3 (≈10 MB MP4, expiring) | ~$0.09 / GB out | ~$0.001 |
| **All-in worst case, with the caps above** | | **~$0.05–0.07** |

So **$50 ≈ ~700–1,000 renders/month.** AI spend is *not* the binding
constraint — abuse and concurrency are; these caps exist to distribute a fixed
budget fairly and stop one abuser draining it in an afternoon. Voice is
content-hashed per scene (`src/voice.ts`) so re-renders of the same narration
cost ~$0 in TTS, and Kokoro-local TTS could drop the AI line to $0 entirely if
the free tier ever wants to run key-free. Whether the cap actually holds in
practice is a monitoring question — see [Observability](#observability).

## Observability

Two planes, kept **separate** — conflating them is exactly how a "$50 cap"
silently leaks:

- **Enforcement plane (exact, synchronous, before-dispatch):** the DynamoDB
  budget meter and per-identity quota counters. This is what *guarantees* the
  cap. Billing data and CloudWatch are far too laggy (hours) to enforce
  anything — they never gate a render.
- **Observation plane (eventually-consistent, for humans + alarms):**
  CloudWatch metrics / logs / dashboards / alarms layered on top. Watches
  trends, pages on anomalies, feeds the [launch gate](#launch-gate).

**Emit per job** (structured JSON from each Fargate task → CloudWatch via
Embedded Metric Format, so a log line doubles as a metric with no separate
`PutMetricData` call):

- `render.cost_usd`, **broken down by source** — TTS chars→$, STT seconds→$,
  Fargate task-seconds × size→$, S3 egress bytes→$. This is the **actual** cost,
  emitted *after* the job completes.
- `render.duration_ms` per stage (record / voice / captions / compose), Fargate
  cold-start time, output bytes.
- Pseudonymous identity (hashed GitHub id), tier, queue wait, and outcome
  (success / failed-stage / killed-by-timeout).

**Estimate-vs-actual reconciliation — the subtle one.** The budget meter
decrements by an *estimate* at dispatch (it must — you enforce *before* the job
runs), then each completed job emits its *actual* cost. Track the drift as its
own metric: if estimates consistently run low, the $50 cap leaks even though the
meter says it's holding. Alarm when cumulative drift exceeds a few percent, and
periodically true-up the estimate model.

**Custom metrics + a single dashboard** (namespace `aidemo/hosted`, dimensioned
by tier):

- **Budget** — global spend vs $50, burn rate, projected exhaustion date, and
  **count of times the cap tripped** (that last one is a direct paid-tier demand
  signal for the launch gate).
- **Users** — DAU/MAU by registered identity, new registrations,
  anonymous-vs-registered split, and **renders-per-identity distribution**
  (top-N heavy users — this is the "50 real users vs 1 abuser rendering 50×"
  tell; a raw render count can't distinguish them).
- **Health / SLO** — queue depth + *real* wait time (the honest "#N in queue,
  ~3 min" number must be measured, not guessed), success/failure rate, render
  latency p50/p95, error rate by stage.
- **Abuse** — timeout-killed jobs, egress-allowlist denials, blocked
  internal-address / IMDS attempts, WAF rate-blocks, registrations rejected by
  the age gate.
- **Funnel** — anonymous → registered → paid conversion.

**Alarms → SNS → email/Slack:** budget ≥ 80% of $50; cap tripped; a single
identity exceeding N renders/hour; error-rate or timeout-kill spike; queue wait
past threshold; estimate-vs-actual drift past threshold.

**Infra-cost cross-check (coarse, lagging):** AWS Cost Explorer with per-tier
resource tags on Fargate/S3, plus the account-level AWS Budgets alarm — a
sanity check *against* the app-emitted per-render numbers, never a real-time
control.

**Privacy:** identify users by a pseudonymous (hashed) GitHub id; never log
storyboard content, and log the target only as its allowlisted **origin**, not
full URLs + query strings — consistent with the copyright/SSRF posture above.

## Agent-first registration

The one design constraint the owner cares about most: **registration must be
completable by an agent, mid-session, without a human ever opening a browser
tab on their own initiative.** There are two auth layers — ship both, because
MCP clients differ in what they support natively.

**Layer 1 — transport-level OAuth (MCP-native; best UX where supported).** The
MCP authorization spec treats a Streamable-HTTP server as an OAuth 2.1 resource
server. A capable client (Claude Code/Desktop) discovers this, runs the OAuth
handshake itself (authorization-code + PKCE, dynamic client registration per
RFC 7591), and stores/refreshes the token — sending `Authorization: Bearer …`
on every call. The human just clicks "approve" once and the agent writes zero
auth code. *(The MCP auth spec is still moving; verify current discovery/grant
requirements against the live spec at build time.)*

**Layer 2 — tool-level device flow (universal fallback; works with every MCP
client).** For clients with no built-in OAuth, an MCP `register` tool runs the
OAuth 2.0 Device Authorization Grant (RFC 8628) — the same mechanism `gh auth
login`, the Docker CLI, and AWS SSO already use for headless auth. Ship this
**first**: it's the lowest common denominator and the whole quota/upsell ladder
rides on it. Two identity paths:

1. **GitHub OAuth device flow (primary).** The `register` tool starts the
   standard device-authorization grant: it returns
   `{ verification_uri, user_code, expires_in }`; the agent's job is just to
   surface that one-time code and URL to its human in whatever channel it has
   ("open https://github.com/login/device and enter `ABCD-1234`") — something
   coding agents already do routinely. The agent (or a background poll) then
   calls a follow-up tool with the device code until the human approves; the
   server exchanges it for a GitHub identity, **applies the age gate below**,
   and mints an API key **bound to that identity**, returned once. No form, no
   password, no human-only step beyond clicking "approve" on a page GitHub
   itself renders.
2. **Verified-email magic link (fallback).** For agents/humans without GitHub:
   `register` accepts an email, sends a one-time link, and the agent polls the
   same way until it's clicked. Strictly a fallback — device flow is the
   primary path because it needs no email round-trip and ties identity to an
   account most developers already have.

- **Sybil resistance — bind quota to a costly-to-farm identity.** You can't
  prove "unique human"; you can only make fake identities cost more than the
  free tier is worth. The ladder, and where we plant the flag:

  | Signal | Cost to farm | Use |
  |---|---|---|
  | IP address | ~$0 (proxies, cloud IPs) | Anonymous-playground WAF rate-limit only — never the real key |
  | Email | ~$0 (temp-mail) | Too weak alone; magic-link fallback only |
  | **GitHub account + age gate** | Annoying at scale; GitHub throttles account creation | **Primary.** Require account age **≥30 days** and/or **≥1 public repo** — rejects throwaways |
  | Phone / payment card | High | **Paid tier only** — a card on file *is* the uniqueness proof; too much friction for free |

  **Quota lives on the identity, not the key**: re-registering the same GitHub
  identity returns the *same* quota bucket, not a fresh 25 renders. That's the
  whole game — a key is just a handle on an identity's bucket.
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
  queue/quota ceiling (or the global budget cap) gets a `quota` response that
  names the upgrade path (a checkout link the agent can hand to its human). The
  agent never has to stop and say "go install something" — every next step is
  another tool call.

## Cost model at launch

Target **$0 fixed cost**: the control plane is the smallest always-on Fargate
task (or scale-to-zero Lambda), and render workers are **Fargate tasks launched
per job** that pay for compute only while a job is actually rendering (a render
is seconds-to-low-minutes of CPU). Free-tier concurrency is capped at **1**
globally at launch — the entire free tier shares one worker slot. That's the
cheapest possible "it actually works," it doubles as the honest queue-depth
signal callers see, and it's bounded above by the
[global budget meter](#free-tier-budget-guarantee-the-50month-cap) so the total
monthly bill can't exceed ~$50 no matter how many callers show up.

## Launch gate

The bounded free tier ships (its downside is capped at ~$50/month by design).
These counters now gate only **when the paid tier turns on** — build that only
when there's a concrete interest signal, not a hunch. Track, starting from when
the GitHub Action ships:

- **Waitlist signups** — a simple form or a pinned "who wants hosted
  rendering" GitHub issue people can react to or comment on.
- **Issue reactions** — 👍 count on that same tracking issue.
- **Action adoption** — number of distinct repos actually using the GitHub
  Action (a proxy for "people who'd rather not run CI at all if they didn't
  have to").
- **Free-tier usage** — once hosted is live, straight off the
  [Observability](#observability) dashboard: registered identities, renders/mo,
  and how often the global budget cap is actually hit (the cap tripping
  repeatedly is itself the demand signal that justifies a paid tier).

No specific threshold is pre-committed here on purpose — the owner reviews
these counters periodically (e.g. each release) and decides when the trend,
not a single magic number, justifies standing up paid billing. That review is
the gate; these counters are what it reviews.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Free tier blows past $50 because per-user limits don't bound total spend.** | A **global monthly spend meter** (DynamoDB, atomic check-and-decrement before every dispatch) hard-stops the free tier at the cap; per-render caps make each decrement a known quantity; the meter decrements by *estimate*, so completed jobs emit actual cost and an alarm fires on estimate-vs-actual drift before the cap can silently leak (see [Observability](#observability)); AWS Budgets + a spend-ceiling SCP on the dedicated account are coarse backstops (they lag, so they're not the primary control). |
| **Task-role credential theft on Fargate.** A hostile storyboard navigates the headless browser to the ECS task-metadata endpoint (`169.254.170.2`) or IMDS (`169.254.169.254`) and exfiltrates the render task's temporary AWS creds. | Block both endpoints at the network layer for the render task; least-privilege task role (write one S3 prefix, read its own job record, nothing else) so leaked creds buy almost nothing; IMDSv2 only. |
| **Abuse: crypto-miner / arbitrary-compute URLs.** A "render this URL" primitive is a free compute-execution primitive if unbounded. | Per-job resource caps (CPU/memory/wall-clock) enforced by the Fargate runtime, ephemeral per-job tasks (no persistent workers to keep mining), no job runs longer than a demo plausibly needs (5-min hard timeout). |
| **SSRF via internal URLs.** A job's headless browser could be pointed at cloud metadata endpoints or private/internal addresses reachable from the render network. | Deny-by-default egress allowlist scoped per registered project (public origins only), enforced by an egress proxy / Network Firewall; explicit block of link-local and RFC1918 ranges regardless of what's on an allowlist; resolve-once-and-pin DNS to defeat DNS-rebinding attacks against the allowlist check. |
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
someone's already-written storyboard, not an LLM call. This is also why the
budget math is tractable — the only per-job spend is bounded TTS/STT plus
metered Fargate seconds, both of which the [caps](#free-tier-budget-guarantee-the-50month-cap)
pin to a known ceiling.

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

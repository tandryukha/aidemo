---
name: aidemo-blog
description: Run a blog-generation wave for aidemo using the centralized blog engine. Use when the user says "run a blog wave", "generate blog articles", "write the next N articles", "blog batch", or "continue the blog generation" for aidemo. This is a THIN adapter — the engine's `blog-wave` skill + its served guides carry the actual doctrine (research-first citations, SDXL hero taxonomy, wave runbook, model tiering). It points at aidemo's local config, style overrides, topic map, and repo-specific gotchas, and mandates filing engine feedback at the end of every wave. Do NOT use for: editing one existing article (edit the JSON + re-bake), deploying the blog (aidemo's deploy target), or changing the engine itself (file feedback instead).
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, WebSearch, WebFetch
model: opus
---

# aidemo-blog — blog waves for aidemo (thin adapter)

The engine holds the logic; this file holds only what is specific to aidemo.
**Do not duplicate doctrine here** — fetch it live so it can never go stale.

## Run the guide and follow it

```bash
blog-engine guide wave-runbook     # the 6 phases, disk-is-ledger, packing, launchd autoresume
blog-engine guide authoring        # writer contract + non-hallucination doctrine
blog-engine guide sdxl-taxonomy    # hero image failure taxonomy + judge rubric
blog-engine guide model-tiering    # opus-first; sonnet token-save; codex serial-only
blog-engine guide source-policy    # Tier 1-4 citation whitelist
blog-engine guide cadence          # plan release cadence before bulk-generating
```

The engine-owned **`blog-wave`** skill is the orchestrator runbook — it drives the
six phases and defers to the guides above. Follow it. Everything below is
aidemo-local.

## aidemo's local files (the engine reads these; you point at them)

- `blog/blog.config.json` — machine-enforced values: site/brand, word & link
  budgets, banned-diction additions, cluster→style routing, citation policy + host
  tiers, model tiers + wave size, cadence. The engine gates read this; **never
  restate a config value in this skill.**
- `blog/style/writer-overrides.md` — aidemo's voice, tone, and claims policy.
  Appended **verbatim** to every rendered lane prompt under a `STRICT — these win
  on conflict` header. This is where editorial voice lives, not here.
- `blog/data/topics.json` — the hub-and-spoke topic map (slugs, clusters, pillars,
  crossLinks, science/evidence hooks).
- `blog/data/generation-log.md` — the lab notebook + hero-debt table. Append one
  entry per wave.
- `blog/data/articles/` — the corpus (disk is the ledger).

## Self-update (do this at a wave boundary, never mid-wave)

A SessionStart hook prints an "update available" notice when the pinned engine
version is behind. To take it:

```bash
blog-engine skill check      # is a newer engine version out?
blog-engine skill update     # re-pull the thin skill + re-pin installed.json (also repins launchd loops)
```

`skill update` is the single deliberate bump point. Guide-only fixes propagate
instantly (served live); a validator/renderer/driver fix needs a version bump.

## THE ROUTING RULE — apply at the end of every wave

For each learning this wave, ask: **"would another consumer's next wave benefit?"**

- **Yes** → file an engine issue with `blog-engine feedback` (categories:
  guide / lane-template / validator / renderer / judge / driver / bake).
- **No** → make a local edit (voice, topics, model budget, style routing, cadence
  dates) and record it in `blog/data/generation-log.md`.
- **Both** → local hotfix now **and** an engine issue for the durable fix, noting
  the workaround you applied locally.

Filing **zero** issues is a valid outcome — but it must be **stated** in the wave
report with a reason. The end-of-wave report therefore always carries this line:

```
Feedback: <N> engine issues filed (<links>) / 0 with reason
```

## aidemo repo-local gotchas

<!-- Everything between the two markers below is CONSUMER-OWNED: `blog-engine skill
     update` preserves it verbatim and rewrites everything else. Edit your local
     gotchas only between the markers, and never delete the markers themselves. -->
<!-- consumer:start -->
<!-- Repo-specific footguns ONLY (deploy quirks, a stale LAN IP, a load-bearing
     theme classname, a shared quota with another job, a local preview env var).
     Doctrine that any consumer would hit belongs in an engine feedback issue, not
     here. Start empty; append as aidemo accumulates scars. -->

- **Migration is PARKED** — until stable ≥ the release with the M3 bake knobs
  AND engine issues #7/#8 land, waves run on the local `blog/scripts/*`
  (frozen-but-operational) via the `blog-wave` skill, not engine CLIs. See
  `blog/README.md` § "Blog-engine migration (M3)" for the retirement checklist.
- **Deploy = git push.** `docs/blog/` is the committed GitHub Pages output at
  https://aidemo.top/blog/ — never hand-edit it, and only ever commit a bake
  whose diff you have reviewed. Live in ~30-60s after push.
- **robots.txt**: the site root `docs/robots.txt` owns crawler policy; the blog
  must NOT ship its own (`publish.robots: false` — keep it that way).
- **Parity knobs are load-bearing**: `site.codeBlocks: true`,
  `site.indexHeading: "The aidemo blog"`, `publish.robots: false`, and the
  engine's shiki pin (exactly 4.3.1) are what make the engine bake
  byte-identical to the live site. Changing any of them churns committed pages.
- **Hero lane semantics differ from the engine's**: subjects live in
  `data/hero-subjects.json` (one object metaphor per slug), style is the fixed
  matte-clay wrapper (mirrored in `blog/style/styles.json`), seed =
  fnv1a(slug)+seedOffset, sizes 800/400 only, rendered 1216x832. Re-roll by
  bumping seedOffset, never by prompt-editing.
- **One SDXL job machine-wide** — calorie-slo shares the GPU/backend
  (`ps aux | grep sdxl_backend` before rendering).
- `git commit -s` (DCO) is required in this repo; blog commits are
  pathspec-only, straight to main.
<!-- consumer:end -->

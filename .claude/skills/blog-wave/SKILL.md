---
name: blog-wave
description: Run SEO blog waves for aidemo.top/blog — per wave, 5 parallel opus-xhigh writer agents then a fable-xhigh ship agent (validate --resolve, SDXL hero images, publish, bake, commit+push = deploy), looping unattended until the topic map is written. Use when the user says "new blog wave", "next blog wave", "write blog articles", "add blog topics", "expand the blog", "more articles", or asks to grow the blog to N articles. Knows the gotchas; ship agents that arm background GPU waits DIE with them (recover with finisher.workflow.js), Workflow args can arrive stringified, one wave and one SDXL job at a time (other repos' GPU jobs included), trust git/live state over agent self-reports, usage-limit recovery = chain 1h sleeps past the reset then resumeFromRunId. Do NOT use for; writing one article by hand (follow blog/ops/lane-prompt.md directly), landing-page or indexing-plumbing changes (landing-page skill), demo videos (record-demo), engine changes (verify).
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Workflow, ScheduleWakeup, SendMessage
model: opus
---

# blog-wave — aidemo SEO blog wave orchestration

Your job: expand https://aidemo.top/blog/ by whole waves, unattended, with
this session ONLY orchestrating — every substantive step (writing, fixing,
image generation, shipping) happens inside agents/workflows. Be terse;
surface per-wave outcomes and failures, not narration.

Proven at scale: this procedure shipped 102 articles / 7 clusters / 21 waves
in one unattended campaign (2026-07-18/19), surviving three usage-limit
interruptions and a session restart.

## Authoritative references (these win over this skill if they contradict it)

- `blog/README.md` — pipeline, commands, hero-image lane, publishing flow
- `blog/ops/lane-prompt.md` — the writer contract (validator-enforced)
- `blog/data/topics.json` — the topic map; `wave` field orders the build
- `blog/scripts/validate.mjs` / `bake.mjs` / `hero_images.mjs`

> **Engine migration parked (2026-07-20):** the centralized blog-engine
> reproduces our bake byte-for-byte on its main, but the pinned `#stable`
> release + its validator aren't there yet — see `blog/README.md`
> § "Blog-engine migration (M3)". Keep using the local scripts (they are
> FROZEN: operational, no new features — pipeline improvements go to
> blog-engine as feedback issues, repo-local knobs go to
> `blog/blog.config.json`).

Supporting files in this directory:
- `wave.workflow.js` — the wave workflow: parallel opus-xhigh writers → one
  fable-xhigh ship agent. Args: `{wave: N, topics: [{slug, role}...]}`.
- `finisher.workflow.js` — ship-only recovery when drafts exist but the ship
  stage died. Args: `{wave: N, slugs: [...]}`.

## Phase 0 — preflight

```bash
cd <repo> && git log --oneline -2 && git status --short | head
cd blog && node scripts/validate.mjs 2>&1 | tail -3   # corpus must be green
python3 -c "
import json, os
t = json.load(open('data/topics.json'))
done = {f[:-5] for f in os.listdir('data/articles')}
todo = sorted({x['wave'] for x in t['topics'] if x['slug'] not in done})
print('unwritten waves:', todo or 'NONE — need new topics (Phase 1)')"
```

## Phase 1 — new topics (only when the map is exhausted or the user asks)

1. Launch 1-2 background planner agents (`model: "opus"`), territories split
   to avoid overlap, each producing N topic entries matching the topics.json
   schema exactly, written to the session scratchpad as JSON. Planners must
   web-verify keyword phrasings and must NOT cannibalize live slugs.
2. Launch a merge workflow (single fable-xhigh agent): merge into
   `blog/data/topics.json`; integrity-fix (slug uniqueness, pillar refs
   resolve, crossLinks resolve or drop, one pillar per new cluster,
   productMentionCap only 4 or 8); assign waves 5-per-wave, pillars before
   their spokes, clusters mixed within each wave; re-validate the live corpus
   (must stay green); commit `blog/data/topics.json` only, push.

## Phase 2 — the wave loop (one wave at a time, never two)

Per wave:

```
# get the lineup
python3 -c "
import json; t = json.load(open('blog/data/topics.json'))
print(json.dumps([{'slug': x['slug'], 'role': x['role']} for x in t['topics'] if x.get('wave') == N]))"

# launch (args may be passed as an object; the script also tolerates a JSON string)
Workflow({scriptPath: ".claude/skills/blog-wave/wave.workflow.js",
          args: {"wave": N, "topics": [...]}})
```

Between waves, self-pace with ScheduleWakeup (~1800s fallback; workflow
completion notifications are the real wake signal).

On wave completion, ALWAYS verify actual state before trusting the report:

```bash
git log --oneline -1                      # wave commit present?
curl -sL https://aidemo.top/blog/<new-slug>/ | grep -o '<title>[^<]*</title>'
```

Ship agents sometimes return "waiting on X" and die with their background
wait — the commit check above is the truth. Decision table:

| Observed state | Action |
|---|---|
| Commit present, page live | Wave done → launch next wave |
| Commit present, page not yet live | Poll curl up to 5 min yourself |
| Drafts on disk, no wave commit | Launch `finisher.workflow.js` with `{wave, slugs}` |
| Writers failed (usage limit) | See recovery below |

## Phase 3 — after the last wave

Launch a final verification workflow (single fable-xhigh agent): full
`validate.mjs --resolve`, every article has both hero webps, re-bake produces
zero git diff, live spot-checks (one article per cluster, all hubs,
sitemap URL count = articles + hubs + 2, feed.xml, llms.txt, a hero webp, a
shiki code block). Relay the report, update the `aidemo-seo-blog` memory,
stop the loop.

## Recovery paths (all battle-tested)

- **Usage limit mid-wave**: agents die with "resets HH:MM". Chain
  ScheduleWakeup sleeps (max 3600s each) until past the reset, then
  `Workflow({scriptPath, resumeFromRunId, args: same})` — finished writers
  replay from cache, only failed agents re-run.
- **Session restart mid-wave**: workflow leaves no completion record. Check
  disk: drafts present → finisher; drafts missing → relaunch the wave.
- **Ship agent ended early** ("waiting for GPU/deploy poll"): its background
  tasks died with it. Check git state, then finisher. Never assume its
  pending step happened.
- **Interrupted planner agents**: resume via SendMessage (context intact) —
  they often already wrote their output before dying; check the file first.

## Gotchas (learned the hard way — do not relearn)

- **One SDXL job at a time, machine-wide**: other repos (calorie-slo) run the
  same backend. The ship/finisher agents poll `ps aux | grep sdxl_backend`
  and wait; generation must be FOREGROUND Bash, ≤6 slugs per call,
  timeout 600000 — background generation dies with its agent.
- **Hero metaphor failure taxonomy** (swap after 3 failed rolls, update the
  article's hero block to match): SDXL cannot render inscribed/graduated
  surfaces (dials, scales, wax seals — gibberish text), repeated-teeth
  objects (zippers, combs), multi-object binds ("three X", pairs — it
  multiplies or merges them), furniture (pulls photoreal interiors), or
  brand-shaped objects (Swiss Army knife). Single bold silhouettes win.
- **Writers converge**: two writers in one wave picked the same metaphor
  (abacus) and the same vendor taglines. The ship agent de-dupes metaphors
  against `blog/data/hero-subjects.json`; shared-tagline passage warnings
  (OBS's self-description) are acceptable, judged not waved through blindly.
- **Validator citation gate quirks**: some URLs 404 HEAD but serve GET
  (handled in checkUrl since wave 9); Wikipedia URLs with parens need
  percent-encoding; official-standards 403s (tech.ebu.ch) are bot-blocks,
  not dead links — acceptable warnings.
- **Commits**: straight to main, `git commit -s`, subject
  `feat: blog wave N — <n> articles live`, Co-Authored-By Claude line;
  push = deploy (GitHub Pages, live in ~30-60s). On push rejection:
  `git pull --rebase origin main` (up to 3x). Never hand-edit `docs/blog`.
- **Models**: writers `model: "opus", effort: "xhigh"`; ship/merge/verify
  agents inherit the session model at `effort: "xhigh"` (only Workflow
  `agent()` exposes effort).

## End-of-run report template

```
Wave N shipped: <slugs>
Validator: X/X pass (--resolve) | fixes: <what>
Heroes: <n> generated, <n> re-rolls, <metaphor swaps>
Commit: <sha> | Live: verified <url>
Next: wave N+1 (<slugs>) | DONE — final verification passed
```

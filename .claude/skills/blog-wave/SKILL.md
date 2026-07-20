---
name: blog-wave
description: RETIRED 2026-07-20 — this local pre-engine wave-orchestration skill has been superseded by the centralized blog-engine. If you land here for "new blog wave", "next blog wave", "write blog articles", "add blog topics", "expand the blog", "more articles", or growing aidemo.top/blog to N articles, use the `aidemo-blog` skill instead (it drives the engine). This stub only exists to redirect; it carries no orchestration logic.
allowed-tools: Read
model: sonnet
---

# blog-wave — RETIRED (use `aidemo-blog` + the engine)

This skill and its two workflows (`wave.workflow.js`, `finisher.workflow.js`)
were the aidemo-local wave orchestrator back when the blog built from
`blog/scripts/*.mjs`. On 2026-07-20 the blog was migrated onto the centralized
[blog-engine](https://github.com/tandryukha/blog-engine) (v0.2.0, `#stable`) and
those local scripts were deleted, so this skill's workflows were retired with
them. **Git history preserves all of it** (commit before the retirement) if you
ever need to read the old orchestration.

## Where the functionality lives now

- **The `aidemo-blog` skill** is the entry point for every blog wave — it is the
  thin adapter that points the engine at aidemo's config/style/topics and drives
  the wave. Invoke that skill for anything this one used to do.
- **`blog-engine guide WAVE-RUNBOOK`** is the engine-served wave runbook (the six
  phases, disk-is-ledger, packing, launchd autoresume). Doctrine that used to
  live in this file now lives there and is served live so it can't go stale.
- **`blog-engine wave …`** (`status` / `prompt` / `resume` / `install-launchd`)
  is the deterministic wave bookkeeping the old workflows hand-rolled.
- **`blog/README.md`** documents the engine-based build/validate/hero/publish
  flow; **`blog/blog.config.json`** holds the machine-enforced knobs.

Do NOT re-add local bake/validate/hero scripts or workflow files here. Pipeline
improvements go upstream via `blog-engine feedback`; repo-local knobs go to
`blog/blog.config.json`.

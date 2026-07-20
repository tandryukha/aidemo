# aidemo-blog — how this got here & how to keep it fresh

This repo carries a **thin copy** of the `aidemo-blog` blog skill from
[blog-engine](https://github.com/tandryukha/blog-engine). The engine itself is **not**
vendored — it runs on demand via npx from a pinned `stable` tag.

Everywhere below, `blog-engine` means:

    npx -y github:tandryukha/blog-engine#stable

## The knowledge layer (never goes stale)
Doctrine lives in the engine and is served live, always version-matched:

    npx -y github:tandryukha/blog-engine#stable guide           # list topics
    npx -y github:tandryukha/blog-engine#stable guide AUTHORING # print one

## Config, not skill
Machine-enforced knobs live in `blog/blog.config.json` (see the engine's
`docs/CONFIG-SCHEMA.md`). LLM-read voice/claims live in
`blog/style/writer-overrides.md`. The skill never duplicates a config value.

## Stay up to date
A `SessionStart` hook in `.claude/settings.json` runs `skill check` and prints a
notice when a newer skill is available. Apply it at a wave boundary:

    npx -y github:tandryukha/blog-engine#stable skill update --dir .

**Pinning:** interactive sessions + the hook use `#stable`; unattended launchd
loops must invoke the immutable `vX.Y.Z` tag recorded in `installed.json` so a
release can't move under a multi-day corpus run.

## Send feedback upstream
At the end of every wave, file engine-grade learnings on the engine repo:

    npx -y github:tandryukha/blog-engine#stable feedback

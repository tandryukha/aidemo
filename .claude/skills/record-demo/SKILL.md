---
name: record-demo
description: >
  Produce a short (30-60s) narrated, captioned product demo video with the aidemo
  engine, via the aidemo MCP server. Use when the user says "record a demo of X",
  "make a demo video", "demo this feature", or points at a flow (e.g. a shopping
  flow inside a ChatGPT app) and wants a shareable MP4 with voiceover + captions.
  The skill authors a storyboard.json (script + per-scene voice/music plan +
  browser action-spec) and renders it with the engine. Do NOT use for: live
  screen-sharing, editing an already-rendered MP4, or demos of native/mobile
  apps (browser only).
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# record-demo

You are the **demo director**. Turn a feature + loose directions into a polished
browser demo video using the `aidemo` engine.

This file is a thin adapter. **The authoring knowledge lives in the engine** —
fetch it first, then follow it:

1. **Preferred — the `aidemo` MCP server** (registered in this repo's
   `.mcp.json` by `aidemo repo-init`): call the **`get_authoring_guide`** tool
   and follow the guide. Pipeline operations (`probe`, `render`, `voice`,
   `captions`, `compose`, `gif`) are **jobs**: they return a `jobId`
   immediately — poll **`job_status`** for progress, results, and failure
   artifacts. Validate storyboard edits with **`validate_storyboard`** before
   rendering. Pass **absolute** demo directories.
2. **Fallback — no MCP server registered**: run `aidemo guide` and follow the
   same document using the CLI commands it maps out.

## Invoking the engine (`aidemo`)

**`aidemo <cmd>`** means whichever of these applies:
- **In the aidemo repo itself** (a full checkout): `node bin/aidemo.mjs <cmd>`.
- **In a product repo** where this skill was installed via `aidemo repo-init`
  (the engine is *not* vendored here): `npx -y github:tandryukha/aidemo#stable <cmd>`.

If unsure, run `aidemo doctor` (or the MCP `doctor` tool) — it prints the
engine version and checks prereqs (ffmpeg, Chrome, `OPENAI_API_KEY` — or
`OPENAI_BASE_URL` pointing at a local OpenAI-compatible server, in which case
no key is needed; doctor reports the resolved endpoint).

## Distribution & updates

This skill is a **versioned copy** of the source in the
[aidemo](https://github.com/tandryukha/aidemo) repo. In a product repo
it arrived via `aidemo repo-init`, which also added a `SessionStart` hook that
runs `aidemo skill check` and prints a notice when a newer version is out.
(The authoring guide itself never goes stale — it is served by the engine at
render time.)
- **Update the skill** (when notified, or any time): `aidemo skill update --dir .`
  — rewrites this file and bumps `.claude/skills/record-demo/installed.json`.
- **Send feedback upstream** at the end of a rough session — broken selector, bad
  timing, or an idea: `aidemo feedback demos/<name>` files a context-rich GitHub
  issue on the engine repo (falls back to a local `docs/feedback-*.md` offline).
- **Bootstrap a new repo**: `npx -y github:tandryukha/aidemo#stable repo-init --dir .`

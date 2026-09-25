# TODO

> **Glama gate: CLEARED (2026-09-08).** Build test `01a08102-cb7f-7af0-94f9-94ce97201468` passed (18 tools + 2 resources), release **0.9.0** published on Glama.
> Badge added to awesome-mcp-servers PR #10178 (commit `889fc38` on `tandryukha:add-aidemo`) + nudge comment `issuecomment-5586204689`. **Now waiting on punkpeye to merge.**

## Follow-ups now unblocked by the Glama release
- Glama profile: Server Coherence + Tool Definition Quality should now score; "Try in Browser" should exist on the Overview page (seeds "recent usage").
- Re-check the README Glama score badge (d0a518c) now that a real grade exists.

## Reference (if a future Glama build is needed)
Admin › Dockerfile — Glama generates its own Dockerfile from the form (ignores the repo Dockerfile):
- **Build steps:** `["npm install"]` (NOT pnpm — aidemo has no real build step)
- **CMD arguments:** `["mcp-proxy","--","node","bin/aidemo.mjs","mcp"]` — the missing `mcp` subcommand was the cause of every failure from 2026-08-04 to 2026-09-08
- Placeholder params: `{"AIDEMO_TTS_PROVIDER":"local"}`
- Fields are CodeMirror — real keystrokes only; read "Instance logs", not build logs.

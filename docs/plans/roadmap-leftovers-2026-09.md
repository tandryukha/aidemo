# Roadmap leftovers (after v0.14.0) — pick-up list for the next session

_Written 2026-09-08 at the end of the "agent-grade demos" roadmap build
(v0.11 see&lint → v0.12 attention → v0.13 produced → v0.14 self-healing +
import). Everything in the roadmap shipped except the items below. Each entry
says what it is, why it was left, and where to start._

## Engine work

### B3 · `autoIdle` — record-time idle detection (deferred, M)
**What:** opt-in `autoIdle: true` (top-level or per scene) marks any span with
no visible pixel change longer than ~1.5 s as trimmable idle, so un-annotated
waits (`pause`, slow XHRs without `waitForWidget`) stop inflating scenes.
**Why deferred:** the obvious implementation (periodic `page.screenshot` or a
second CDP screencast while Playwright's own screencast records the take)
risks stuttering the recording. Needs a design pass first.
**Start here:** `src/player.ts` scene loop (idleSpans are pushed by
`waitFor*`), `src/recorder.ts` (where a side sampler would live). Candidate
designs: (a) hash `page.screenshot({type:"jpeg", quality:20, scale:"css"})`
at ~3 fps in a side loop, only between actions, and stop it around
type/scroll; (b) post-hoc: after the take, run ffmpeg `freezedetect` on
`recordings/raw.webm` per scene and write `idleSpans` from the frozen spans
(zero record-time cost, compose-time only — probably the better fit for the
"polish is compose-time" invariant). Verify with the stream-md5 baseline on a
storyboard without the flag.

### Multi-tab stories (out of scope by design)
`click.followPopup` closes a new tab and follows its URL in the recorded tab;
there is no `newTab`/`switchTab` because Playwright's `recordVideo` writes one
file per page. If real multi-tab demos are ever needed: record each page's
webm, splice by timeline in compose (each `TimelineScene` already carries
`source` + `leadInMs` from the resume work — the plumbing exists).

### Resume edge cases to harden (`record --from-scene`)
- External capture (`--capture native|obs`) resume is untested; the keep-file
  logic takes `resolveRawVideo()` so it should work, but verify the lead-in
  math with `raw.mp4`.
- `frames --source raw` shows only the new tail of a resumed take (documented);
  a nicer `frames --source take` could stitch by `source`.
- A resumed take's scene hash ignores `setup`/`params` — a param change that
  alters typed text IS caught (actions differ), a change only in `setup`
  cookies is not.

### import-trace follow-ups
- `getByLabel` becomes a `text=` match (noted in `_notes`); a real mapping
  needs `label=` support in `resolveTargetLocator`, or `internal:label=` pass-
  through (Playwright accepts it — test whether the storyboard should just keep
  it).
- Test-file parser is line/regex based: multi-line chained locators and
  page-object helpers are skipped with a note. A proper TS parse (typescript is
  already a devDependency) would cover them.
- `expect(...).toHaveScreenshot`, `toHaveAttribute`, `toBeChecked` are ignored.

### `init --from-url` follow-ups
- Scenes from headings use `h2:has-text("…")` — long headings are truncated
  in the id but not in the selector; a page with duplicate headings yields a
  non-unique target (lint won't catch it; probe will).
- No scroll/section detection for single-page apps with no headings — falls
  back to a search-or-CTA-only draft.

### Device frames
- `iphone`/`android` chrome draws the island/punch-hole OVER the video's top
  ~46 px. A `safeTop` option (pad the video down instead) would keep an
  app's status bar visible. Also no landscape/tablet variants.

## Distribution (needs a human decision)

- **npm publish is dormant**: repo variable `NPM_PUBLISH` is unset, so
  `@tandryukha/aidemo` on npm and the Homebrew formula
  (`tandryukha/homebrew-aidemo`, `Formula/aidemo.rb`) are still **0.8.0**
  while GitHub/`stable`/the Claude plugin are 0.14.0. Setting
  `NPM_PUBLISH=true` before the next `release: vX.Y.Z` commit republishes;
  then bump the Homebrew formula url + sha256 (see
  `docs/plans/homebrew.md`). The README's `npx -y @tandryukha/aidemo` line
  installs the old engine until then.
- Skills channel is live (`npx skills add tandryukha/aidemo` installs only
  record-demo; dev skills carry `metadata.internal: true`). Consider listing
  on skills.sh's directory once traffic warrants.

## Horizon (WS-F from the roadmap, not scheduled)

- Narration-vs-page drift check in CI: golden the text content the narration
  references (`assert textMatches` already covers the explicit case).
- Second-take diff: `report.json` diff between takes (which scene got slower).
- Webcam/PiP and B-roll insert cards (image/video card type) — cards infra.
- Interactive HTML demo (hotspots) from the same timeline — extends
  `src/walkthrough.ts`.
- Hosted public MCP exposing `frames`/`report` (`docs/plans/public-mcp.md`).

## How to verify any of the above (unchanged recipe)

`npm run typecheck` · `npm run check:plugin-skill` · fixture server
`node examples/local-demo/serve.mjs` · `node bin/aidemo.mjs probe
examples/local-demo --headless --golden` · `npm run mcp-smoke` · stream md5 of
an unchanged storyboard before/after (`ffmpeg -i out.mp4 -map 0:v -c copy -f
md5 -`) · full e2e `OPENAI_API_KEY= AIDEMO_TTS_PROVIDER=local node
bin/aidemo.mjs render <dir> --headless`. Schema change ⇒ `docs/AUTHORING.md`
in the same commit; release ⇒ bump `package.json`, `plugins/record-demo/
.claude-plugin/plugin.json`, `server.json`, commit `release: vX.Y.Z`, push.

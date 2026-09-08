# Roadmap leftovers (after v0.14.0) — pick-up list

_Written 2026-09-08 at the end of the "agent-grade demos" roadmap build
(v0.11 see&lint → v0.12 attention → v0.13 produced → v0.14 self-healing +
import). **Updated 2026-09-08**: the whole "Engine work" section shipped (see
*Done* below). What is left needs either a human decision (distribution) or a
scheduling decision (horizon)._

## Done (2026-09-08)

- **B3 · `autoIdle`** — shipped as a **compose-time** feature, the post-hoc
  option from the original design: `probeFreezeSpans()` runs ffmpeg
  `freezedetect` on the take (`src/ffmpeg.ts`), compose folds the motionless
  spans into the scene's `idleSpans` and caps them exactly like an annotated
  wait. Zero record-time cost, so the recording can't stutter — and it honors
  "polish is compose-time, not record-time". Opt-in `autoIdle: true |
  {enabled?, minMs?=1500, noise?=0.003}`, per-scene `autoIdle` overrides,
  `autoIdleMs` per scene in `output/report.json`, and `lint` discounts a long
  `pause` when it's on. Verified: with the flag off, the fixture's video+audio
  stream md5s are byte-identical to the pre-change render.
- **Resume hardening** — the scene hash now covers `setup` and `params` (a take
  recorded before this still resumes, with a log line saying what can't be
  checked); compose refuses a resumed timeline whose raw files differ in pixel
  size, which is the way an external-capture (retina `raw.mp4`) take resumed by
  a built-in `raw.webm` one would otherwise misplace every overlay.
- **`frames --source take`** — walks `timeline.json` and samples the whole
  recorded take across the raw files a resume splices, naming each frame with
  its scene (`take-00-09-s2.png`). `--source raw` keeps its old meaning.
- **import-trace** — `getByLabel` now stays `internal:label="…"i` (verified:
  `page.locator` resolves it to the labelled control, so no more text-match
  approximation); `toBeChecked` and `toHaveAttribute` become asserts that fold
  the condition into the selector (`>> :scope:checked`, `>> :scope[href="…"]`);
  `toHaveScreenshot` is dropped with a note; the test-file parser follows a
  locator parked in a `const` to its use.
- **`init --from-url`** — heading selectors are trimmed at a word boundary and
  get an explicit `nth=` when the page repeats a heading; a page with no
  headings drafts scroll beats instead of a search-or-CTA-only draft.
- **Device frames** — `frame.safeTop` (`true` = 46 px, or a number) reserves a
  status-bar strip of bezel above the video so the island / punch-hole stops
  covering the app's own top pixels.

Still deliberately open in that area:

- **Landscape / tablet device chrome.** The bezel geometry is aspect-agnostic
  already, but the camera cut-out is hard-centered on the top edge — a landscape
  phone or an iPad would need its own placement (and, for a tablet, a thinner
  bezel with no island).
- **A real TS parse for test files.** The parser is still line/regex based, so
  a page-object helper (`await loginPage.submit()`) is still skipped with a
  note. `typescript` is a devDependency, and the npm package ships prod deps
  only — using it at runtime means promoting it, which is a bigger call than
  the remaining coverage is worth.
- **Multi-tab stories (out of scope by design).** `click.followPopup` closes a
  new tab and follows its URL in the recorded tab; there is no
  `newTab`/`switchTab` because Playwright's `recordVideo` writes one file per
  page. If real multi-tab demos are ever needed: record each page's webm and
  splice by timeline in compose (each `TimelineScene` already carries `source`
  + `leadInMs` from the resume work — the plumbing exists).
- **`init --from-url` on heading-less SPAs** now drafts scroll beats, but still
  does no section detection — the beats are placeholders the agent points at
  real elements.

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

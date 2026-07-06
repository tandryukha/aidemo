---
name: record-demo
description: >
  Produce a short (30-60s) narrated, captioned product demo video with the aidemo
  engine in this repo. Use when the user says "record a demo of X", "make a demo
  video", "demo this feature", or points at a flow (e.g. a shopping flow inside
  a ChatGPT app) and wants a shareable MP4 with voiceover + captions. The skill
  authors a storyboard.json (script + per-scene voice/music plan + browser
  action-spec) and runs `aidemo render`. Do NOT use for: live screen-sharing,
  editing an already-rendered MP4, or demos of native/mobile apps (browser only).
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# record-demo

You are the **demo director**. Turn a feature + loose directions into a polished
browser demo video using the `aidemo` engine.

## Invoking the engine (`aidemo`)
Below, **`aidemo <cmd>`** means whichever of these applies:
- **In the aidemo repo itself** (a full checkout): `node bin/aidemo.mjs <cmd>`.
- **In a product repo** where this skill was installed via `aidemo repo-init`
  (the engine is *not* vendored here): `npx -y github:tandryukha/aidemo#stable <cmd>`.

If unsure, run `aidemo doctor` — it prints the engine version and checks prereqs
(ffmpeg, Chrome, `OPENAI_API_KEY`). See **Distribution & updates** at the bottom.

## Pipeline (what the engine does)
`storyboard.json` → **voice** (OpenAI TTS per scene) → **record** (drives Chrome,
injected animated cursor, Playwright video + timeline) → **captions** (Whisper
word timing) → **compose** (trim idle "thinking" spans, sync each scene's video
to its narration length, overlay captions, mux audio) → `output/final-demo.mp4`.

You author the **storyboard**; the CLI does the mechanical steps.

## Steps
1. **Clarify the brief** (only if genuinely ambiguous): target flow/URL, the one
   thing to prove, audience, tone, length, CTA. Otherwise infer sensible defaults.
2. **Scaffold**: `aidemo init <name>` → creates `demos/<name>/` with a
   starter `generated/storyboard.json`. (Or copy `examples/local-demo` as a base.)
3. **Confirm selectors for a new/changed flow.** Don't guess. The cheapest way is
   `aidemo probe demos/<name>` — a **record-only dry run** (narration
   optional in the storyboard) that drives the real flow in ~90 s without spending
   TTS or a full take, so you can verify selectors, iframe descent, and cart
   continuity live. (Or drive the page with a Playwright script / the chrome MCP
   tools.) Map each iframe once in `storyboard.frames`. A probe that hits a bad
   selector leaves a screenshot + frame dump in `logs/`.
4. **Write the storyboard** (see schema + principles below).
5. **Render**: `aidemo render demos/<name>` (headed for real ChatGPT:
   drop `--headless`). Then inspect `output/final-demo.mp4` (extract a few frames
   with ffmpeg and look at them). Note: **don't** `aidemo record … | tee log` —
   the pipeline exit code becomes tee's (0), masking a failed take. The CLI
   already tees itself to `logs/<command>.log`; if you must pipe, `set -o pipefail`.
6. **Iterate cheaply**: change one scene's narration and re-run
   `aidemo voice demos/<name>` then `aidemo compose demos/<name>` — voice **skips
   unchanged scenes** (hashes narration + voice plan), so only the edited scene is
   re-voiced and an approved take is preserved (`--force` re-voices all;
   `--scene <id>` targets one). Re-record only if the browser flow changed.

## Demo-director principles (make it feel human-made)
- **Hook in the first ~3 seconds.** Open on the value, not a login screen.
- **One idea per scene.** 4-6 scenes for a 45s demo.
- **Narration ≈ 2.5 words/sec.** A 6s scene ≈ 15 words. Keep it tight and spoken,
  not written ("here's the thing" > "the following functionality").
- **Match narration to the action.** The engine time-stretches each scene's video
  to its narration and freeze-holds a static page for any remainder — so a scene
  that's mostly a pause should have shorter narration, and a busy scene more.
- **End on a clear CTA.**
- **Voice plan per scene**: pick `voiceId` (marin/alloy/verse/... ) and
  `instructions` to steer tone/emotion/pace. Keep it consistent across scenes.

## Storyboard schema (quick reference)
Top level: `title`, `targetLengthSeconds?`, `video{width,height}` (default
1280x720), `frames{ name: iframeSelector }`, `voice{voiceId,instructions,speed}`
(default, scenes may override), `music?`, `zoom?`, `intro?`, `outro?`, `scenes[]`.

Cinematic keys (all opt-in; omit for the plain look):
- `zoom: {scale?=1.55, easeMs?=600, holdMs?=1700}` — **auto-zoom on focus**:
  every click/typed prompt zooms in on the interaction point at compose time,
  holds, eases out; near-consecutive focus points pan instead of bouncing.
  Set `"zoom": false` on a scene to opt just that scene out.
- `intro` / `outro: {title, subtitle?, durationMs?=2600, background?, accent?,
  fadeMs?=350}` — typographic title cards; narration/captions shift
  automatically and music runs under the cards.
- `music: {track, gainDb?=-14, ducking?="sidechain", fadeOutMs?=1800, ...}` —
  the bed ducks under narration via a sidechain compressor and swells back in
  pauses (`"ducking": "constant"` + `duckToDb` = legacy fixed bed). No bed ships
  with the repo (license provenance matters for a submission); generate a
  **license-free** one with `aidemo music assets/music.wav` and point
  `track` at it. Per-scene `music.cue` is informational only — it's ignored (the
  bed plays continuously), and setting one now logs a warning at load.

Each scene: `id`, `narration`, `voice?`, `music?`, `zoom?` (false to disable), `actions[]`.

Action vocabulary (a `target` is `{selector}` or `{frame,selector}` or
`{named:"composer"}`):
- `{op:"goto", url}`
- `{op:"type", target, text, humanize?}`  — human-cadence typing
- `{op:"press", key}`  — e.g. "Enter"
- `{op:"click", target}` · `{op:"hover", target}`
- `{op:"scrollTo", target, easing?, durationMs?}` · `{op:"scrollBy", dy, easing?, durationMs?}`
  — easing presets: `"smooth"` (default) | `"snappy"` | `"glide"` | `"linear"`
- `{op:"focus", target, scale?, holdMs?}`  — deliberate zoom beat on an element
  without clicking it (needs top-level `zoom` enabled)
- `{op:"waitFor", target, timeoutMs?}`  — normal wait (fires instantly if the
  selector already matches — no good for in-place changes)
- `{op:"waitForWidget", target, textMatches?, label?, timeoutMs?}`  — **records
  the wait as idle** so compose trims/speeds it. Use for every ChatGPT
  "thinking" wait for a brand-**new** widget. When a prompt could render
  either of two widget types that share the selector (e.g. carousel vs compare
  both carry `button[data-add-id]`), pass `textMatches` (case-insensitive regex
  on the new widget's text) with a string unique to the type you expect — an
  unqualified wait passes on the wrong widget and the desync only shows in review.
- `{op:"waitForReply", selector?, textMatches?, label?, timeoutMs?}`  — wait for
  a **new TEXT-ONLY assistant reply** (a tool that answers without a widget,
  e.g. a delivery-options lookup) — the main-frame twin of `waitForWidget`:
  assistant-message count growth + generation finished, always recorded as
  trimmable idle. `selector` defaults to ChatGPT's message nodes
  (`[data-message-author-role="assistant"]`); `textMatches` additionally
  asserts the finished reply's text (fails the scene if the model answered
  off-script).
- `{op:"waitForChange", target, textMatches?, timeoutMs?, idle?, label?}`  —
  wait for an **in-place mutation** of an existing element (the gap between
  waitFor and waitForWidget). Use after a widget-side click that re-renders the
  SAME widget: click-Add renders the basket bar into `[data-cart-bar]`; a qty
  `±` re-renders the row. Pass `textMatches` (case-insensitive regex on the new
  text) to wait for a specific state, e.g. target the qty display and pass
  `"2"` for a 1→2 re-render. `idle:true` records it as trimmable idle like
  `waitForWidget`.
- `{op:"pause", ms}`  — a deliberate on-screen beat (not trimmed)

Target `last`/`nth` pick among matching **frames** on framed targets and among
matching **elements** on plain (frameless) targets — e.g.
`{selector:"[data-message-author-role=\"assistant\"]", last:true}` is the
newest reply.

Typing into the composer while the prior reply is still streaming is safe: the
player waits the composer out and **records that wait as trimmable idle**, so a
long streaming turn can't blow the next scene past its narration.

High-fidelity capture: `aidemo record/render --capture native` (macOS ffmpeg
screen grab; terminal needs Screen Recording permission) or `--capture obs`
(OBS via obs-websocket; scene = Display Capture of the primary screen). Both
require a headed browser. Default remains Playwright's built-in recorder.

## ChatGPT Apps SDK recording — hard-won facts (READ before a ChatGPT demo)
> **App-specific.** This whole section applies only when the demo *subject* is a
> ChatGPT Apps SDK widget (an app embedded inside chatgpt.com). For a plain web app
> (a marketplace, a dashboard, a SaaS UI) skip it entirely — you just author
> `goto`/`type`/`click`/`scrollTo` against the site's own selectors.

Confirmed by recording a real production shopping app (2026-07-06). The engine already
handles the frame/timing/stealth cases below; you mostly need to author correctly.

**Login & profile (the crux).**
- Use a dedicated Chrome profile logged into ChatGPT with the app's dev connector
  enabled (`AIDEMO_CHROME_PROFILE` or `--profile`). Run **headed**; quit any Chrome
  on that profile first (Playwright needs the lock).
- You **cannot copy** an existing ChatGPT login in: real Chrome encrypts cookies
  with the macOS Keychain, but Playwright launches with `--use-mock-keychain
  --password-store=basic`, so copied cookies won't decrypt. Log in **once** in a
  Chrome that uses the *same* mock store, then quit and record:
  `open -na "Google Chrome" --args --user-data-dir=<profile> --password-store=basic --use-mock-keychain https://chatgpt.com/`
  (A normal window like this also dodges Google's SSO automation block.)
- Cloudflare: the engine launches with `--disable-blink-features=AutomationControlled`
  so `navigator.webdriver` is false and the profile's real `cf_clearance` is honored
  (otherwise you get a "Verify you are human" wall mid-record).

**Widgets render in a NESTED iframe.** The app UI is inside an `<iframe name="root">`
(about:blank) within the `*.web-sandbox.oaiusercontent.com` sandbox — a single-level
`frameLocator` only reaches the empty wrapper, and ChatGPT renders **two** sandbox
iframes per widget (one populated, one empty). The engine auto-descends and picks the
populated frame **when your `frame` selector contains `oaiusercontent`** — so declare:
`"widget": "iframe[src*=\"web-sandbox.oaiusercontent.com\"], iframe[src*=\"<app>\"]"`.
Always set `"last": true` on widget targets (newest widget for this turn).

**Authoring rules that actually work:**
- **Prefix every prompt with the app name** ("YourApp, …") or the model does a plain
  web search instead of calling the app.
- **`humanize: false`** on composer typing — fast typing keeps each scene's *active*
  video shorter than its narration, so compose freeze-holds/gently slows the widget
  (good dwell) instead of speeding past it. Human-cadence typing flashed widgets.
- **`waitForWidget` on every reply** — the engine waits for a *new* widget (match
  count grows past a pre-send baseline) and folds the "generation finished" wait +
  a composer clear into the trimmed idle span, so multi-turn prompts don't interleave.
- **Drive a tool by clicking its widget button when the model is unreliable.** Some
  tools (e.g. checkout) the model narrates in text instead of calling — a typed prompt
  produces no widget. Use a `click` on the widget's own control instead, e.g.
  `{op:"click", target:{frame:"widget", last:true, selector:"button[data-cart-act=\"checkout\"]"}}`.
- **Real-world widget hooks** (from a production shopping app — widgets use inline
  styles + `data-*`, not `data-testid`; yours will differ, so confirm with a probe):
  carousel/product-card = `button[data-add-id]`; cart = `button[data-cart-act]`
  (inc/dec/remove/`="checkout"`); external hand-off = `button[data-ext-href]`
  (`:has-text("checkout")` to distinguish the checkout CTA from a card's "View" link).
- **External checkout opens a NEW TAB** (a separate Playwright page, *not* in the
  video). End the scene on the visible hand-off CTA and let narration cover the jump.
  (Recorder keeps the largest `.webm` so the stray new-tab recording is discarded.)
- Collapse the sidebar (`[data-testid="close-sidebar-button"]`, persist it in the
  profile) to hide chat-history PII and clean the frame. Note the home screen greets
  the account by first name for ~2 s — blur or accept per the owner.
- **Widget-side mutations render in the SAME widget, not a new one** (v2 recording,
  2026-07-06): click-Add renders a basket bar into the widget's `[data-cart-bar]`
  slot; the cart's `±` re-renders the row in place. Wait with **`waitForChange`**
  on the mutating element (`{op:"waitForChange", target:{frame:"widget", last:true,
  selector:"[data-cart-bar]"}, textMatches:"checkout"}`) — it waits for the element
  to actually change, unlike `waitFor` (fires instantly on a stale match) or
  `waitForWidget` (times out — no new widget). A bare `pause` races the server.
- **Widget-initiated tool results are invisible to the model** (v3 recording,
  2026-07-06): a widget-click `add_to_cart` returns its result to the widget
  only — the model never learns the session id, so a later *prompted* "show my
  basket" can render an EMPTY cart. (v2's adjacency success was luck, not
  contract.) Rule: a flow that needs model-side cart continuity must make its
  FIRST cart mutation a typed/model-invoked one; after that, widget clicks
  (qty `±`, checkout) are safe.
- **Dev-connector widgets carry a "CSP off" badge** on their header (new since
  2026-07-06). Cosmetic, appears in every frame, not fixable app-side (CSP
  `_meta` verified riding `resources/read`) — accept it, or frame zooms to keep
  the header out of the payoff shots.
- **Pin prompts to exact catalog titles.** A fuzzy product reference ("Gold
  Standard 900 g") can trigger an intermediate model search that renders a
  "0 products found" widget mid-video. Use the product's exact catalog title in
  the prompt.
- **Don't hand-author scrolls before widget clicks** — the player self-scrolls:
  sandbox iframes are out-of-process, so a scroll from inside the widget can't move
  ChatGPT's page; `boxOf` wheels the main scroller until the target sits in the
  viewport band, and `humanClick` hit-tests and dodges overlays (ChatGPT's floating
  scroll-to-bottom arrow otherwise eats coordinate clicks aimed at widget footers).
- **ChatGPT can hijack a turn with an A/B "Which response do you prefer?" eval
  screen** (two text responses, no widget, blocks on a human choice), or a consent
  wall. The player now runs **best-effort interruption handlers** before composer
  typing and inside the widget wait — they try to dismiss these and log what they
  did. When one can't self-resolve, the scene still fails, but with a *named* error
  + a screenshot in `logs/` (so you can see it was platform roulette, not your
  storyboard). Selectors for these handlers track live ChatGPT and may drift; a
  re-run is still the reliable fix.
- **Cheap live probe before a full take**: `aidemo probe demos/<name>` runs the
  storyboard **record-only** with narration optional — a 3-scene probe (search →
  click → prompted follow-up) answers selector/continuity questions in ~90 s
  without spending TTS or a full take. On a bad selector it leaves
  `logs/fail-<scene>-<n>.{png,json}` (screenshot + which frames matched).
- **A failed take is salvaged, not lost**: `record` writes a partial
  `timeline.json` and keeps the main recording even when a late scene fails, so a
  scene-7-of-7 failure doesn't discard the good footage. Re-run to get a clean take.

`aidemo init` scaffolds a storyboard already using all of the above.

## Verify before declaring done
Play (or frame-extract) `output/final-demo.mp4`: cursor glides and clicks pulse,
narration matches on-screen actions, captions are readable and in sync, no dead
air, and the key moment (e.g. checkout confirmed) is actually visible on screen.
If the demo is headed for a README, `aidemo gif demos/<name>` converts it to a
README-ready `output/final-demo.gif` (GIFs autoplay on GitHub; MP4s don't).

## Distribution & updates
This skill is a **versioned copy** of the source in the
[aidemo](https://github.com/tandryukha/aidemo) repo. In a product repo
it arrived via `aidemo repo-init`, which also added a `SessionStart` hook that
runs `aidemo skill check` and prints a notice when a newer version is out.
- **Update the skill** (when notified, or any time): `aidemo skill update --dir .`
  — rewrites this file and bumps `.claude/skills/record-demo/installed.json`.
- **Send feedback upstream** at the end of a rough session — broken selector, bad
  timing, or an idea: `aidemo feedback demos/<name>` files a context-rich GitHub
  issue on the engine repo (falls back to a local `docs/feedback-*.md` offline).
- **Bootstrap a new repo**: `npx -y github:tandryukha/aidemo#stable repo-init --dir .`

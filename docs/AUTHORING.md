# Authoring demos with aidemo — the canonical guide

This is the engine-versioned authoring guide for **any** agent or human
producing a demo video with aidemo. It is served by the engine itself, so it
always matches the engine that will render:

- **MCP** (preferred for agents): call the `get_authoring_guide` tool on the
  `aidemo` MCP server — it returns this document.
- **CLI**: `aidemo guide` prints it.

You are the **demo director**: turn a feature + loose directions into a
polished 30–60s narrated, captioned browser-demo MP4. You author the
**storyboard** (script + per-scene voice/music plan + declarative browser
action-spec); the engine does the mechanical steps deterministically.

## Interfaces: MCP tools ↔ CLI commands

Every operation exists on both surfaces. Agents should prefer the MCP server
(structured results, job tracking); the CLI is the human/CI surface. `aidemo
<cmd>` means `node bin/aidemo.mjs <cmd>` inside the engine repo, or
`npx -y github:tandryukha/aidemo#stable <cmd>` anywhere else.

| Operation | MCP tool | CLI |
|---|---|---|
| Read this guide | `get_authoring_guide` | `aidemo guide` |
| Storyboard JSON Schema | `get_storyboard_schema` | — (see below) |
| Validate a storyboard | `validate_storyboard` | (validated on every run) |
| Scaffold a demo | `init_demo` | `aidemo init <name>` |
| Environment check | `doctor` | `aidemo doctor` |
| Dry-run the flow | `probe` (job) | `aidemo probe <dir>` |
| Full pipeline | `render` (job) | `aidemo render <dir>` |
| One stage | `voice` / `record` / `captions` / `compose` (jobs) | `aidemo voice\|record\|captions\|compose <dir>` |
| README GIF | `gif` (job) | `aidemo gif <dir>` |
| Named stills (screenshot mode) | `stills` (job) | `aidemo stills <dir>` |
| Job progress / result | `job_status`, `job_list`, `job_cancel` | (CLI runs block in the foreground) |

**The job model (MCP).** Pipeline operations touch TTS/STT, a real Chrome, or
ffmpeg and can run for minutes — so their tools return `{jobId, demoDir,
logFile}` **immediately**. Poll `job_status {jobId}` for stage, per-scene
progress, a log tail, and the final `result` or `error`. On failure, `error`
carries `failureArtifacts` (screenshot + frame-dump paths), the log file, and
`salvaged` when a partial take was kept. One long job runs at a time — a
second submission is rejected with the running job's id (poll or cancel it).
Job ids live in server memory: after a reconnect, look in `<demoDir>/logs/`
instead.

**Always pass absolute demo directories** to MCP tools — the server's working
directory is not necessarily your repo (Codex registers servers globally).

**Validate early.** Run `validate_storyboard` after every storyboard edit
(cheap, structured errors) instead of discovering schema issues inside a
render job.

## Pipeline (what the engine does)

`storyboard.json` → **voice** (TTS per scene) → **record** (drives Chrome,
injected animated cursor, video + timeline) → **captions** (Whisper word
timing) → **compose** (trim idle "thinking" spans, sync each scene's video to
its narration length, overlay captions, mux audio) → `output/final-demo.mp4`.

No LLM runs during capture — the recording is a deterministic replay of your
fixed action-spec. Voice and captions call an OpenAI-compatible endpoint
(`OPENAI_API_KEY`, or `OPENAI_BASE_URL` pointing at a local server such as
speaches — then no key is needed); probe/record/compose never touch the
network.

## Steps

1. **Clarify the brief** (only if genuinely ambiguous): target flow/URL, the
   one thing to prove, audience, tone, length, CTA. Otherwise infer sensible
   defaults.
2. **Scaffold**: `init_demo` / `aidemo init <name>` → creates `demos/<name>/`
   with a starter `generated/storyboard.json`.
3. **Confirm selectors for a new/changed flow.** Don't guess. The cheapest way
   is a **probe** — a record-only dry run (narration optional) that drives the
   real flow in ~90 s without spending TTS or a full take, so you can verify
   selectors, iframe descent, and cart continuity live. Map each iframe once in
   `storyboard.frames`. A probe that hits a bad selector leaves a screenshot +
   frame dump in `logs/` (surfaced as `failureArtifacts` in `job_status`).
4. **Write the storyboard** (schema + principles below), then
   `validate_storyboard`.
5. **Render**: run the `render` job (headed for real ChatGPT: keep
   `headless: false` / drop `--headless`). Then inspect `output/final-demo.mp4`
   — extract a few frames with ffmpeg and look at them.
   CLI note: **don't** pipe `aidemo record … | tee log` — the exit code becomes
   tee's (0), masking a failed take. The engine already tees itself to
   `logs/<command>.log`.
6. **Iterate cheaply**: change one scene's narration and re-run `voice` then
   `compose` — voice **skips unchanged scenes** (hashes narration + voice
   plan), so only the edited scene is re-voiced and an approved take is
   preserved (`force` re-voices all; `scene <id>` targets one). Re-record only
   if the browser flow changed.

## Demo-director principles (make it feel human-made)

- **Hook in the first ~3 seconds.** Open on the value, not a login screen.
- **One idea per scene.** 4–6 scenes for a 45s demo.
- **Narration ≈ 2.5 words/sec.** A 6s scene ≈ 15 words. Keep it tight and
  spoken, not written ("here's the thing" > "the following functionality").
  That figure is English-centric: non-English OpenAI TTS voices can read
  30-40% slower — plan at ≈1.8-2.0 words/sec for morphology-rich languages
  (Estonian, Finnish, German, …), or voice one scene first (`aidemo voice
  <dir> --scene <id>`) to measure the actual pace before writing the rest. If
  the storyboard declares `targetLengthSeconds`, `voice` compares the real
  narration length against it and warns with a per-scene words/sec table when
  it's over budget.
- **Match narration to the action.** The engine time-stretches each scene's
  video to its narration and freeze-holds a static page for any remainder — so
  a scene that's mostly a pause should have shorter narration, and a busy scene
  more.
- **Pre-navigate: put nav clicks at the END of the prior scene.** In a
  screen-tour where each scene starts with a navigation click, the destination
  appears 2–3 s late (the cursor glides across the *old* screen before the
  click lands), desyncing narration from visuals — the narration for screen N
  plays over screen N−1. Instead, end each scene with the click that opens the
  *next* scene's screen: every scene then opens already on the screen its
  narration describes.
- **End on a clear CTA.**
- **Voice plan per scene**: pick `voiceId` (marin/alloy/verse/… on the default
  OpenAI TTS; an ElevenLabs voice id if the engine runs with
  `AIDEMO_TTS_PROVIDER=elevenlabs`; a Kokoro voice id — af_heart, am_adam, … —
  if it runs with `AIDEMO_TTS_PROVIDER=local`; both non-default providers
  ignore `instructions`) and `instructions` to steer tone/emotion/pace. Keep it
  consistent across scenes.

## Storyboard schema (quick reference)

The precise contract is the JSON Schema from `get_storyboard_schema`
(generated from the engine's own zod schema, `src/types.ts`).

Top level: `title`, `language?`, `targetLengthSeconds?`, `video{width,height}`
(default 1280x720), `frames{ name: iframeSelector }`,
`voice{voiceId,instructions,speed}` (default, scenes may override), `music?`,
`zoom?`, `intro?`, `outro?`, `transition?`, `output?`, `scenes[]`.

`language?` is a BCP-47/ISO-639-1 code (e.g. `"et"`) describing what language
the base `narration` is already written in — set it for a monolingual
non-English demo (no `narrations` translations at all). It's metadata, not a
render switch: it only feeds the `captions` STT language hint (see below).
Distinct from `--lang`, which *selects* a scene's `narrations[code]`
translation (Multi-language renders, below).

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
  pauses (`"ducking": "constant"` + `duckToDb` = legacy fixed bed). No bed
  ships with the repo (license provenance matters); generate a **license-free**
  one with `aidemo music assets/music.wav` and point `track` at it. Per-scene
  `music.cue` is informational only — it's ignored (the bed plays
  continuously), and setting one logs a warning at load. **Adding music
  auto-normalizes the master** to ~−16 LUFS / −1.5 dBTP (a final `loudnorm`
  pass) so it isn't quiet next to other clips — tune or disable it with
  `output.loudness` (see below).
- `transition: {type:"crossfade", durationMs?=400}` — **cross-dissolve every
  scene boundary** instead of hard-cutting (see below).
- `output: {width?, height?, fit?="contain", background?, loudness?}` — **render
  at a different size/aspect** (`width`+`height`, set together) and/or **set the
  master loudness** (`loudness`), e.g. a vertical social clip (see below).
- `motionBlur: {frames?=3}` — **subtle motion blur** on fast motion (cursor,
  scroll, zoom pan); static UI stays sharp (see below).
- `cursor: {hidden?, hideScenes?, scale?}` — **compose-time cursor control**:
  hide or resize the cursor post-hoc instead of baking it (see below).

Each scene: `id`, `narration`, `voice?`, `music?`, `zoom?` (false to disable),
`actions[]`.

## Transitions, output sizing & loudness

Opt-in, compose-time polish keys. All are pure post-processing — they never
touch the recording, so tuning them is always a recompose, never a re-record.
Omit them and compose behaves exactly as before (hard-cut scenes, recording-size
output, no loudness pass on a narration-only render).

**`transition: {type:"crossfade", durationMs?=400}`** — cross-dissolves the video
across every scene boundary. Narration is a single continuous track and stays
authoritative: the crossfade steals its overlap from each scene's own frozen
tail frames (a hold beyond the scene's end), so the timeline does **not** shrink.
The final video's total duration, frame count, and per-scene narration alignment
are identical to the hard-cut version — only the cuts become dissolves. Cost: the
scene join is re-encoded (the default hard-cut path is a lossless stream-copy
concat). Needs ≥2 scenes; a shorter `durationMs` (250–400) reads as a snappy
dissolve, longer (600+) as a slow cinematic fade.

**`output: {width, height, fit?, background?}`** — reframes the finished video
(cards and captions already baked in) to a target size, applied as the last
step. `fit`:
- `"contain"` (default) — scale to fit inside `width×height` and pad the
  remainder with `background` (ffmpeg color syntax, e.g. `black`, `0x1a1a1a`;
  default black). Letterbox/pillarbox bars, nothing cropped.
- `"cover"` — scale to fill and center-crop the overflow. No bars, but edges are
  lost.

This seeds the **social-clips lane**: a vertical `{width:1080, height:1920}` (or
`720×1280`) clip from a landscape 1280×720 take. Use even width/height (yuv420p).
Only core scale/pad/crop filters are used, so it stays portable across ffmpeg
builds. `width` and `height` are set together (or both omitted) — an `output`
block may carry only `loudness`.

**`output: {loudness?}`** — master loudness normalization (a final `loudnorm`
pass, portable core filter). This exists because **mixing a music bed drops the
master to ~−29 LUFS** — far below streaming norms (YouTube/podcast sit around
−14…−16 LUFS), so the video sounds quiet next to anything else. The fix runs
automatically:
- **With a `music` block:** the master is normalized to **−16 LUFS integrated /
  −1.5 dBTP** by default (LRA 11). No `output` block needed.
- **Narration only (no music):** no loudness pass runs — that path is
  byte-for-byte unchanged.

Override or disable via `loudness`:
- `"loudness": false` — disable the pass entirely (even with music).
- `"loudness": {integrated?=-16, truePeak?=-1.5, lra?=11}` — override any target
  (partial objects fill from the defaults). Setting an object also **forces the
  pass on for a narration-only render** (e.g. to hit a specific delivery target).

Targets are the ffmpeg `loudnorm` `I` (LUFS), `TP` (dBTP), and `LRA` (LU). The
pass runs last over the muxed audio and pins the rate back to 44.1 kHz.

## Motion blur & cursor

Two more compose-time polish keys, both opt-in and portable (baseline `tmix` /
`overlay` — no `drawtext`/`subtitles`). Omit them and the render is byte-for-byte
the old behavior.

**`motionBlur: {frames?=3}`** — averages a small sliding window of frames so fast
motion (the cursor gliding, an eased scroll, a zoom pan) gets a subtle trail.
Static UI is untouched — identical frames average to themselves, so only moving
pixels blur. `frames` is the window size (2 = whisper, 3 = default, up to 6 for a
heavier smear). Pure post-processing over the content — recompose to tune it.

**`cursor: {hidden?, hideScenes?, scale?}`** — moves the cursor from a *baked*
record-time artifact to a *compose-time layer*, so you can style it **post-hoc,
without re-recording**:
- `hidden: true` — no cursor at all (clean product shots; a `still` grabbed in
  this mode is cursor-free too).
- `hideScenes: ["s5"]` — hide the cursor only on those scenes (e.g. a
  full-screen result or confirmation).
- `scale: 1.3` — resize the cursor (1 = the 24px baseline arrow).

How it works: with a `cursor` block present, `record` leaves the take
**cursor-free** and logs the cursor path into `timeline.json`; `compose` draws
the cursor as an overlay along that path (over the content, so it zooms and pans
with the frame, exactly like a baked cursor). This means the cursor block must be
present **when you record** (so the clean take + path exist) — after that, every
hide/resize is a recompose, never a re-record. Without the block, the cursor is
baked at record time as before (the default).

## Action vocabulary

A `target` is `{selector}` or `{frame,selector}` or `{named:"composer"}`:
- `{op:"goto", url}`
- `{op:"type", target, text, humanize?}` — human-cadence typing
- `{op:"press", key}` — e.g. "Enter"
- `{op:"click", target}` · `{op:"hover", target}`
- `{op:"scrollTo", target, easing?, durationMs?}` · `{op:"scrollBy", dy,
  easing?, durationMs?}` — easing presets: `"smooth"` (default) | `"snappy"` |
  `"glide"` | `"linear"`
- `{op:"focus", target, scale?, holdMs?}` — deliberate zoom beat on an element
  without clicking it (needs top-level `zoom` enabled)
- `{op:"still", name}` — **screenshot mode**: mark a named still at this beat.
  A pure timeline marker (no screenshot at record time); `aidemo stills` /
  `render` extract `output/stills/<name>.png` from the clean take. See *Stills /
  screenshot mode* below.
- `{op:"waitFor", target, timeoutMs?}` — normal wait (fires instantly if the
  selector already matches — no good for in-place changes)
- `{op:"waitForWidget", target, textMatches?, label?, timeoutMs?}` — **records
  the wait as idle** so compose trims/speeds it. Use for every ChatGPT
  "thinking" wait for a brand-**new** widget. When a prompt could render
  either of two widget types that share the selector (e.g. carousel vs compare
  both carry `button[data-add-id]`), pass `textMatches` (case-insensitive regex
  on the new widget's text) with a string unique to the type you expect — an
  unqualified wait passes on the wrong widget and the desync only shows in
  review.
- `{op:"waitForReply", selector?, textMatches?, label?, timeoutMs?}` — wait for
  a **new TEXT-ONLY assistant reply** (a tool that answers without a widget,
  e.g. a delivery-options lookup) — the main-frame twin of `waitForWidget`:
  assistant-message count growth + generation finished, always recorded as
  trimmable idle. `selector` defaults to ChatGPT's message nodes
  (`[data-message-author-role="assistant"]`); `textMatches` additionally
  asserts the finished reply's text (fails the scene if the model answered
  off-script).
- `{op:"waitForChange", target, textMatches?, timeoutMs?, idle?, label?}` —
  wait for an **in-place mutation** of an existing element (the gap between
  waitFor and waitForWidget). Use after a widget-side click that re-renders the
  SAME widget: click-Add renders the basket bar into `[data-cart-bar]`; a qty
  `±` re-renders the row. Pass `textMatches` (case-insensitive regex on the new
  text) to wait for a specific state, e.g. target the qty display and pass
  `"2"` for a 1→2 re-render. `idle:true` records it as trimmable idle like
  `waitForWidget`.
- `{op:"pause", ms}` — a deliberate on-screen beat (not trimmed)

Target `last`/`nth` pick among matching **frames** on framed targets and among
matching **elements** on plain (frameless) targets — e.g.
`{selector:"[data-message-author-role=\"assistant\"]", last:true}` is the
newest reply.

**Selector gotcha — nested label text:** for buttons whose label sits in a
nested text node (common in react-native-web, MUI, and icon+label buttons like
`<button role="button"><svg/><div>Library</div></button>`), prefer
`:has-text("Library")` over `:text-is("Library")`. Playwright's `:text-is`
matches the *smallest* element whose text equals the string — the inner
`<div>`, not the clickable wrapper — so
`[role="button"]:text-is("Library")` matches **0 elements** and fails the
take, while `[role="button"]:has-text("Library")` matches the button (the
player takes `.first()`).

Typing into the composer while the prior reply is still streaming is safe: the
player waits the composer out and **records that wait as trimmable idle**, so a
long streaming turn can't blow the next scene past its narration.

High-fidelity capture: `capture: "native"` (macOS ffmpeg screen grab; terminal
needs Screen Recording permission) or `"obs"` (OBS via obs-websocket; scene =
Display Capture of the primary screen). Both require a headed browser. Default
remains Playwright's built-in recorder.

**⚠ Frame-review every native/OBS take before publishing — a bad crop can
leak your desktop.** These modes record the REAL screen and crop to the
browser viewport afterwards; a wrong crop silently ships whatever else is on
screen (desktop icons, notifications, permission dialogs, other windows) into
the video. The recorder measures the window via CDP, sizes it to the
storyboard viewport, and **aborts** when the computed crop doesn't match the
viewport instead of shipping a mis-cropped take
(`AIDEMO_NATIVE_CROP_UNSAFE=1` downgrades the abort to a loud warning — only
for debugging, and then review every frame). No automatic check can see
everything, so eyeball the frames anyway. `record` also preserves the
previous take as one `.prev` generation (`recordings/raw.prev.*` +
`generated/timeline.prev.json`) instead of deleting it, so a bad re-record
never destroys the last good take — copy the `.prev` files back over the
current ones to roll back.

## Stills / screenshot mode

One storyboard can also emit **named still images** — for READMEs, docs, blog
posts, and app-store / listing media — from the *same* take that produces the
video. No second tool, no separate capture pass.

Drop a `still` marker wherever you want a frame:

```json
{ "op": "still", "name": "hero" }
```

It's a **pure timeline marker** — like `focus`, it records *when* (timeline
time) but takes no screenshot during recording. The PNG is extracted at
**compose time** from the recorded take:

- `aidemo stills <dir>` (MCP `stills` job) extracts every marker from an
  existing recording into `output/stills/<name>.png`. It reads only
  `timeline.json` + the raw take — **no API key, no re-record** — so re-running
  it (or adding a new marker + re-recording) is cheap. This mirrors the rest of
  the engine's "polish is a re-extract, never a re-take" rule.
- `aidemo render <dir>` (and the MCP `render` job) runs the extraction
  automatically whenever the storyboard contains any `still` marker.

**Stills come from the CLEAN take** — the raw recording, before captions, zoom,
or title cards are burned in. That's deliberate: a still is the bare product UI
at that instant, exactly what a README or a store listing wants, not a frame
with a caption pill across it. They're written at the recording's native
resolution — the storyboard `video` size (1280×720 by default); a `native`/`obs`
retina capture yields correspondingly larger stills.

The timeline→frame mapping is the same one compose uses to sync scenes:
`frame_time = marker.tMs + timeline.leadInMs`. Place the marker **after the page
settles** (e.g. right after a `scrollTo`, before a `pause`) so the extracted
frame isn't mid-transition — the marker itself waits a short beat before
recording its time for exactly this reason.

**Names must be unique and file-safe.** Each `name` becomes `<name>.png`
(letters, digits, dot, dash, underscore). Duplicate names across the storyboard
are a **hard error** at extraction, so one still never silently clobbers
another.

## ChatGPT Apps SDK recording — hard-won facts (READ before a ChatGPT demo)

> **App-specific.** This whole section applies only when the demo *subject* is a
> ChatGPT Apps SDK widget (an app embedded inside chatgpt.com). For a plain web
> app (a marketplace, a dashboard, a SaaS UI) skip it entirely — you just author
> `goto`/`type`/`click`/`scrollTo` against the site's own selectors.

Confirmed by recording a real production shopping app (2026-07-06). The engine
already handles the frame/timing/stealth cases below; you mostly need to author
correctly.

**Login & profile (the crux).**
- Use a dedicated Chrome profile logged into ChatGPT with the app's dev
  connector enabled (`AIDEMO_CHROME_PROFILE` or the `profile` option). Run
  **headed**; quit any Chrome on that profile first (Playwright needs the lock).
- You **cannot copy** an existing ChatGPT login in: real Chrome encrypts
  cookies with the macOS Keychain, but Playwright launches with
  `--use-mock-keychain --password-store=basic`, so copied cookies won't
  decrypt. Log in **once** in a Chrome that uses the *same* mock store, then
  quit and record:
  `open -na "Google Chrome" --args --user-data-dir=<profile> --password-store=basic --use-mock-keychain https://chatgpt.com/`
  (A normal window like this also dodges Google's SSO automation block.)
- Cloudflare: the engine launches with
  `--disable-blink-features=AutomationControlled` so `navigator.webdriver` is
  false and the profile's real `cf_clearance` is honored (otherwise you get a
  "Verify you are human" wall mid-record).

**Widgets render in a NESTED iframe.** The app UI is inside an
`<iframe name="root">` (about:blank) within the
`*.web-sandbox.oaiusercontent.com` sandbox — a single-level `frameLocator` only
reaches the empty wrapper, and ChatGPT renders **two** sandbox iframes per
widget (one populated, one empty). The engine auto-descends and picks the
populated frame **when your `frame` selector contains `oaiusercontent`** — so
declare:
`"widget": "iframe[src*=\"web-sandbox.oaiusercontent.com\"], iframe[src*=\"<app>\"]"`.
Always set `"last": true` on widget targets (newest widget for this turn).

**Authoring rules that actually work:**
- **Prefix every prompt with the app name** ("YourApp, …") or the model does a
  plain web search instead of calling the app.
- **`humanize: false`** on composer typing — fast typing keeps each scene's
  *active* video shorter than its narration, so compose freeze-holds/gently
  slows the widget (good dwell) instead of speeding past it. Human-cadence
  typing flashed widgets.
- **`waitForWidget` on every reply** — the engine waits for a *new* widget
  (match count grows past a pre-send baseline) and folds the "generation
  finished" wait + a composer clear into the trimmed idle span, so multi-turn
  prompts don't interleave.
- **Drive a tool by clicking its widget button when the model is unreliable.**
  Some tools (e.g. checkout) the model narrates in text instead of calling — a
  typed prompt produces no widget. Use a `click` on the widget's own control
  instead, e.g. `{op:"click", target:{frame:"widget", last:true,
  selector:"button[data-cart-act=\"checkout\"]"}}`.
- **Real-world widget hooks** (from a production shopping app — widgets use
  inline styles + `data-*`, not `data-testid`; yours will differ, so confirm
  with a probe): carousel/product-card = `button[data-add-id]`; cart =
  `button[data-cart-act]` (inc/dec/remove/`="checkout"`); external hand-off =
  `button[data-ext-href]` (`:has-text("checkout")` to distinguish the checkout
  CTA from a card's "View" link).
- **External checkout opens a NEW TAB** (a separate page, *not* in the video).
  End the scene on the visible hand-off CTA and let narration cover the jump.
  (Recorder keeps the largest `.webm` so the stray new-tab recording is
  discarded.)
- Collapse the sidebar (`[data-testid="close-sidebar-button"]`, persist it in
  the profile) to hide chat-history PII and clean the frame. Note the home
  screen greets the account by first name for ~2 s — blur or accept per the
  owner.
- **Widget-side mutations render in the SAME widget, not a new one** (v2
  recording, 2026-07-06): click-Add renders a basket bar into the widget's
  `[data-cart-bar]` slot; the cart's `±` re-renders the row in place. Wait with
  **`waitForChange`** on the mutating element (`{op:"waitForChange",
  target:{frame:"widget", last:true, selector:"[data-cart-bar]"},
  textMatches:"checkout"}`) — it waits for the element to actually change,
  unlike `waitFor` (fires instantly on a stale match) or `waitForWidget` (times
  out — no new widget). A bare `pause` races the server.
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
  sandbox iframes are out-of-process, so a scroll from inside the widget can't
  move ChatGPT's page; `boxOf` wheels the main scroller until the target sits
  in the viewport band, and `humanClick` hit-tests and dodges overlays
  (ChatGPT's floating scroll-to-bottom arrow otherwise eats coordinate clicks
  aimed at widget footers).
- **ChatGPT can hijack a turn with an A/B "Which response do you prefer?" eval
  screen** (two text responses, no widget, blocks on a human choice), or a
  consent wall. The player runs **best-effort interruption handlers** before
  composer typing and inside the widget wait — they try to dismiss these and
  log what they did. When one can't self-resolve, the scene still fails, but
  with a *named* error + a screenshot in `logs/` (so you can see it was
  platform roulette, not your storyboard). Selectors for these handlers track
  live ChatGPT and may drift; a re-run is still the reliable fix.
- **Cheap live probe before a full take**: a probe runs the storyboard
  **record-only** with narration optional — a 3-scene probe (search → click →
  prompted follow-up) answers selector/continuity questions in ~90 s without
  spending TTS or a full take. On a bad selector it leaves
  `logs/fail-<scene>-<n>.{png,json}` (screenshot + which frames matched).
- **A failed take is salvaged, not lost**: `record` writes a partial
  `timeline.json` and keeps the main recording even when a late scene fails, so
  a scene-7-of-7 failure doesn't discard the good footage. Re-run to get a
  clean take.

`init_demo` / `aidemo init` scaffolds a storyboard already using all of the
above.

## Parameterized storyboards & variants

One storyboard, many personalized renders (per prospect, per segment). Declare
template params, reference them as `{{name}}`, then override per run or render a
whole matrix at once.

**Declare** a top-level `params` map (name → default value). Every declared
param needs a default so the storyboard still renders with no overrides (and so
`validate_storyboard` stays green):

```json
{
  "title": "{{customer}} — supplement finder",
  "params": { "customer": "there", "query": "whey isolate under 30 euros" },
  "scenes": [
    {
      "id": "s1",
      "narration": "Hi {{customer}}! Just tell DemoFit what you need.",
      "actions": [
        { "op": "goto", "url": "http://localhost:8787/" },
        { "op": "type", "target": { "selector": "#search" }, "text": "{{query}}" },
        { "op": "click", "target": { "selector": "#search-btn" } }
      ]
    }
  ],
  "intro": { "title": "A demo for {{customer}}" }
}
```

**Where placeholders work:** any storyboard string — narration, action `url`,
`type` `text`, card `title`/`subtitle`, `waitFor*` `textMatches`, voice
`instructions`, even selectors. Not numbers: a `{{n}}` in a numeric field fails
schema validation (put the value in a string field). The `params` defaults
themselves are literal (not recursively substituted).

**Resolution & errors** (both caught at load, before any stage runs):
- an override key that isn't declared → hard error (typo guard);
- a `{{name}}` used but not declared → hard error listing the missing names.

**Override a single render** with repeatable `--param key=value` (CLI) — works
on every storyboard-loading command (`probe`, `record`, `voice`, `captions`,
`compose`, `render`); the MCP tools take an equivalent `params` object:

```bash
aidemo render <dir> --param customer="Acme Corp" --param query="creatine"
aidemo probe  <dir> --param customer="Acme Corp"   # verify the take, zero spend
```

**Consistency across stages.** One resolved param set applies to the whole run,
so a param in narration re-voices + re-captions and one in a url/typed text
changes the recorded take. The resolved set is persisted to
`generated/params.json`, so a later stage-only re-run (e.g. `aidemo compose
<dir>`) reuses the exact same values — pass `--param` again only to change them
(a take-affecting change then needs a re-record, per "polish is compose-time").

**Render a whole matrix** with `--variants variants.json`, an array of
`{ name, params }`:

```json
[
  { "name": "acme",   "params": { "customer": "Acme Corp", "query": "creatine" } },
  { "name": "globex", "params": { "customer": "Globex",    "query": "omega 3"  } }
]
```

```bash
aidemo render <dir> --variants variants.json
```

Each entry renders as an isolated full pipeline into
`output/variants/<name>/` (its own take — content differs; voice hashing still
skips unchanged scenes within a variant). Runs are sequential. Because a variant
renders relative to its own dir, keep any local asset paths (e.g. a music
`track`) absolute.

## Verify before declaring done

Play (or frame-extract) `output/final-demo.mp4`: cursor glides and clicks
pulse, narration matches on-screen actions, captions are readable and in sync,
no dead air, and the key moment (e.g. checkout confirmed) is actually visible
on screen. If the demo is headed for a README, run the `gif` job — GIFs
autoplay on GitHub; MP4s don't.

Then: if you hit any engine bug, surprise, or workaround this session, file
it now while the context is fresh — the MCP `feedback` tool (title + body;
environment/log context is auto-attached) or `aidemo feedback <dir>` on the
CLI. If nothing came up, skip this.

## Debugging

- Every run tees its output to `<demo>/logs/<command>.log`; a failed take also
  leaves `logs/fail-<scene>-<n>.{png,json}`. `job_status` surfaces all of these
  paths on failure.
- `AIDEMO_KEEP_TMP=1` preserves `.compose-tmp/` intermediates when debugging
  compose.
- `doctor` checks Node, ffmpeg, Chrome, the TTS/STT endpoint (and flags
  LLM-only servers like Ollama, which have no audio endpoints — point
  `OPENAI_BASE_URL` at a speech server such as speaches instead).

## Demo as regression test

A probe run is a deterministic replay of the storyboard, so it doubles as a
regression test for the UI it drives: if a selector moves, a page renames a
`data-testid`, or a navigation breaks, the flow changes — catch it as a failed
check, not a user complaint. This is the golden-file pattern (borrowed from
vhs).

`aidemo probe <dir> --update-golden` writes `golden/probe.json`: a **normalized,
timing-free** projection of the probe — per scene, the ordered action outcomes
(`op`, the resolved `target`/selector, `ok`, the element-`found` boolean, and
each `goto`'s `finalUrl`). No wall-clock timings, coordinates, or anything
volatile, so it is stable across runs. Commit it next to the storyboard.

`aidemo probe <dir> --golden` re-runs the probe, normalizes it the same way, and
deep-compares against `golden/probe.json`. On a match it exits 0; on drift it
prints a readable field-level diff (`$.scenes[2].actions[0].found: expected
true, got false`) and exits non-zero. A missing baseline is a clear error
telling you to run `--update-golden` first. In golden mode a failing action is
recorded (`ok:false`) and the run continues, so you get the full diff instead of
an abort at the first break. (The MCP `probe` tool takes the same `updateGolden`
/ `golden` params and returns `golden.match` + `golden.diffs` in its result.)

Wire it into CI so a breaking UI change is a failed check:

```yaml
# after starting your app/fixture server on its expected URL
- run: npx -y github:tandryukha/aidemo#stable probe path/to/demo --golden --headless
```

Regenerate the baseline (`--update-golden`) and re-commit `golden/probe.json`
whenever the flow changes on purpose.

## Captions: Whisper STT vs. offline (script-timed)

Default `aidemo captions <dir>` transcribes the composed narration audio with
Whisper word-level timestamps — real per-word timing, but a plain audio
transcription can still misspell narration (this bit non-English demos hard:
Estonian "uus kuub" came back "Scoop", "AI-treener" came back "EI treener").
To keep the transcript honest, the request is biased with what the engine
already knows about the script:

- **Prompt bias (always on).** The storyboard's narration text (in scene
  order) is sent as Whisper's `prompt`, nudging the transcript to converge on
  the actual scripted words/spelling instead of guessing from audio phonetics
  alone — while still keeping real word-level timing from the audio. This
  changes STT output for every non-trivial demo (strictly for the better:
  caption text lines up with the script); there's no flag to opt out of it
  short of `--offline`.
- **Language hint.** A BCP-47/ISO-639-1 code is sent as Whisper's `language`
  param when known, in this priority order: an explicit `--stt-lang <code>`
  → an active `--lang <code>` (multi-language render) → the storyboard's own
  top-level `language` field → unset (auto-detect).
- **`aidemo captions <dir> --stt-lang <code>`** sets the language hint
  directly, independent of `--lang` — use it for a one-off STT fix (or a
  monolingual non-English demo) without editing the storyboard.

**Non-English narration:** prompt bias + a language hint fix the common case,
but Whisper can still misspell unusual or compound words. If burned-in
captions still look wrong, **`aidemo captions <dir> --offline` is the
guaranteed-correct fallback** — cues are derived directly from the storyboard
script (correct spelling by construction, since there's no transcription at
all) using each scene's measured duration from `voice.json`; only the timing
*within* a scene is approximate (words spread proportional to length, not
measured speech rhythm). `captions` logs a one-line reminder of this whenever
the resolved language isn't English.

## Multi-language renders (one take, N languages)

Record the browser flow **once**, then ship the same demo in several languages —
each with its own voiceover and captions — without re-recording. The take (raw
video + `timeline.json`) is language-independent: it replays your action-spec,
which never mentions the spoken words. Only the **narration, captions, and
intro/outro card copy** localize; `compose` already stretches each scene's video
to its own narration length, so a longer or shorter translation just retimes the
shared footage.

Translations are **authored into the storyboard** — the pipeline never calls an
LLM to translate (the capture loop and the render pipeline both stay LLM-free).

**Authoring pattern.** Add a `narrations` map to any scene (language code →
translated text) and, for title cards, an `i18n` map:

```jsonc
{
  "intro": {
    "title": "DemoFit",
    "subtitle": "Find your supplement",
    "i18n": { "de": { "subtitle": "Finde dein Supplement" } }
  },
  "scenes": [
    {
      "id": "s1",
      "narration": "Just tell DemoFit what you need.",           // base language
      "narrations": {                                            // per-language overrides
        "de": "Sag DemoFit einfach, was du brauchst.",
        "fr": "Dites simplement à DemoFit ce qu'il vous faut."
      },
      "actions": [ /* … shared across every language … */ ]
    }
  ]
}
```

A code missing from a scene's `narrations` (or a card's `i18n`) falls back to the
base `narration` / card copy, and the CLI warns which scenes fell back — partial
translation is allowed.

**One-take → N-renders flow.**

1. `record` once (or a full default `render`) — produces the shared take and the
   default-language MP4.
2. For each extra language, run **only** the language-dependent stages against
   the same take:
   `aidemo voice <dir> --lang de` → `aidemo captions <dir> --lang de` →
   `aidemo compose <dir> --lang de`. No re-record.
3. Or use the convenience matrix: `aidemo render <dir> --langs de,fr` records
   **once**, then voices + captions + composes each language. `aidemo compose
   <dir> --langs de,fr` re-composes several languages from an existing take.

**Artifacts are namespaced so a language never clobbers the default:**

| Artifact | Default | `--lang de` |
|---|---|---|
| Per-scene + assembled audio | `audio/…` | `audio/de/…` |
| Voice manifest | `audio/voice.json` | `audio/de/voice.json` |
| Captions | `generated/captions.{srt,vtt,cues.json}` | `generated/captions.de.{srt,vtt,cues.json}` |
| Final video | `output/final-demo.mp4` | `output/final-demo.de.mp4` |

The **shared** take — `recordings/raw.*`, `generated/timeline.json`,
`generated/storyboard.json` — is not namespaced (that's what one recording feeds
every language). Running without `--lang` is byte-for-byte the old behavior.

**MCP.** `voice`, `captions`, `compose`, and `render` each take an optional
`lang` argument (same semantics; `render` records once then renders that
language). Author the `narrations`/`i18n` maps, then submit one job per language.

**Caveat (honest for v1): only the narration, captions, and card copy change —
the recorded UI does not.** On-screen text stays in whatever language the app
rendered during the take. That's the right tradeoff for a voiceover-led product
demo; if the UI itself must be localized, record a separate take per locale (a
different storyboard) rather than using `--lang`.

**Local-voice reality check.** The in-process Kokoro provider
(`AIDEMO_TTS_PROVIDER=local`) ships **English voices only** — en-US (`af_*`,
`am_*`) and en-GB (`bf_*`, `bm_*`) accents. It's perfect for `en` / `en-GB`
variants (and for validating the matrix offline), but a non-English `--lang`
would be read by an English voice and mispronounced — `voice` warns when you do
this. For genuine non-English speech, render that language with
`AIDEMO_TTS_PROVIDER=elevenlabs` (multilingual) or OpenAI TTS. Set the storyboard
`voice.voiceId` (globally, or per scene) if a language wants a different voice.

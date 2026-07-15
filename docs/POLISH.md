# Cinematic polish & higher-fidelity capture

> Part of [aidemo](../README.md). All of the below is **opt-in** via the
> storyboard; existing storyboards render exactly as before, and polish is
> compose-time — a bad zoom is a recompose, never a re-record.

## Cinematic polish

- **Auto-zoom on focus** (Screen-Studio-style). Add `"zoom": {}` at the top
  level (options: `scale` 1.55, `easeMs` 600, `holdMs` 1700). Every click and
  typed prompt eases the camera in on the interaction point, holds, and eases
  back out — consecutive focus points pan instead of bouncing. Opt a busy scene
  out with `"zoom": false` on the scene, or add a deliberate framing beat with
  the `{op:"focus", target, scale?, holdMs?}` action (no click needed).
- **Smooth-scroll easing presets.** `scrollTo`/`scrollBy` accept
  `"easing": "smooth" | "snappy" | "glide" | "linear"` (+ optional
  `durationMs`). Scrolls run as ~60 Hz eased micro-deltas instead of chunky
  wheel steps.
- **Dynamic music ducking (sidechain).** With `music.track` set, narration keys
  a sidechain compressor on the bed: music dips under speech and swells back in
  pauses and over the cards. Tune with `gainDb` (bed level, default -14),
  `duckThreshold/duckRatio/duckAttackMs/duckReleaseMs`; `"ducking": "constant"`
  restores the old fixed `duckToDb` bed. The bed fades out over the last
  `fadeOutMs` (1800) of the video.
- **Intro/outro cards.** `"intro"` / `"outro"` objects (`title`, `subtitle?`,
  `durationMs`, `background?`, `accent?`, `fadeMs?`) render as typographic
  title cards (headless-Chrome rasterized, like captions) with fade in/out.
  Narration and captions shift automatically; music plays under the cards.
- **Motion blur.** `"motionBlur": {}` (opt `frames`, default 3) averages a small
  sliding window of frames, so fast motion — the cursor, an eased scroll, a zoom
  pan — trails subtly while static UI stays sharp. Compose-time `tmix`, so it's a
  recompose to tune. (Avoid it on scroll-heavy pages — it smears scrolls.)
- **Post-hoc cursor hide/resize.** `"cursor": {}` turns the cursor from a baked
  record-time artifact into a compose-time layer: `hidden` drops it entirely (a
  clean product shot — and any `still` grabbed then is cursor-free too),
  `hideScenes: ["s5"]` hides it on chosen scenes, `scale` resizes it. Record once
  with the block present (the take is captured cursor-free plus a cursor path);
  every hide/resize after that is a recompose, never a re-record.

## Higher-fidelity capture (native / OBS)

Playwright's built-in recording is a CDP screencast — fine for fixtures, softer
for hero demos. `--capture native|obs` (or `AIDEMO_CAPTURE`) records the real
screen instead and crops to the browser viewport automatically (window geometry
is measured from the page). Retina density is preserved end-to-end: compose is
resolution-aware, so captions/cards/zoom render at 2x on a 2x capture.

- `--capture native` (macOS): ffmpeg `avfoundation` grab of the primary screen.
  Grant your terminal **Screen Recording** permission. Device via
  `AIDEMO_CAPTURE_DEVICE` (default "Capture screen 0"; list with
  `ffmpeg -f avfoundation -list_devices true -i ""`).
- `--capture obs`: OBS Studio via obs-websocket v5 (`AIDEMO_OBS_URL`,
  `AIDEMO_OBS_PASSWORD`; needs Node 22+). Set the OBS scene to a **Display
  Capture of the primary screen**; start/stop is automated.

Both need a **headed** browser (they record the actual screen — keep the window
unobstructed and don't move it mid-take).

> **⚠ Frame-review every native/OBS take before publishing** — a bad crop can
> leak your desktop. These modes record the REAL screen and crop afterwards; a
> wrong crop silently ships whatever else is on screen. The recorder measures
> the window and **aborts** when the computed crop doesn't match the viewport
> (since v0.8.0). Eyeball the frames anyway.

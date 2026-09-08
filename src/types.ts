import { z } from "zod";

/**
 * The storyboard is the single source of truth for a demo. Claude (via the
 * `record-demo` skill) authors it; the CLI mechanically executes it.
 *
 * One storyboard = an ordered list of scenes. Each scene bundles everything the
 * pipeline needs for that beat: what to say (narration + voice plan), what music
 * cue to use, and the browser actions to perform.
 */

// ---------------------------------------------------------------------------
// Actions — a small, fixed vocabulary the player interprets. No generated code
// is ever executed; this keeps recording deterministic, safe, and editable.
// ---------------------------------------------------------------------------

/**
 * How to locate an element. Either a raw CSS/text selector on the main page, or
 * a selector inside a named frame (e.g. a ChatGPT app widget iframe). Frames are
 * declared once in the storyboard `frames` map.
 */
const TargetSchema = z.object({
  /** Named frame to resolve via frameLocator; omit for the top page. */
  frame: z.string().optional(),
  /** Playwright selector. Prefer role/text/data-testid for stability. */
  selector: z.string().optional(),
  /**
   * Shorthand semantic target the player knows how to resolve without a raw
   * selector (currently: "composer" = the ChatGPT prompt box). Optional.
   */
  named: z.enum(["composer"]).optional(),
  /**
   * When multiple frames match `frame` (e.g. a ChatGPT conversation renders one
   * widget iframe per tool call), pick the NEWEST one. Essential for multi-turn
   * demos so each `waitForWidget` targets the current reply, not the first.
   * On a plain (frameless) target it picks the last matching ELEMENT instead —
   * e.g. the newest assistant message in a conversation.
   */
  last: z.boolean().optional(),
  /** Pick the nth matching frame — or element, when frameless (0-based). Overridden by `last`. */
  nth: z.number().optional(),
});
export type Target = z.infer<typeof TargetSchema>;

const BaseAction = {
  comment: z.string().optional(),
  /**
   * Best-effort action: when its target never appears or the interaction
   * fails, log and continue instead of failing the take. For state-dependent
   * one-time UI — e.g. collapsing the ChatGPT sidebar persists in the Chrome
   * profile, so a re-run finds the close button absent and a required click
   * would kill the run. Interaction ops (click/type/hover/scrollTo/focus)
   * probe briefly for the target instead of stalling out the full action
   * timeout; wait ops honor their own timeoutMs and then continue. Don't mark
   * actions the demo's visuals depend on — a skipped optional action is only
   * a log line.
   */
  optional: z.boolean().optional(),
  /**
   * Re-attempt an interaction (click/type/hover/scrollTo/focus/moveTo/assert)
   * up to this many extra times when it throws — a beat apart — before the
   * take fails. For UI that re-renders under the cursor (a list that
   * reorders on load, a button that mounts twice). Retries land in
   * timeline.json `actions[].retries`. Optional actions skip instead.
   */
  retry: z.number().int().min(0).max(5).optional(),
  /**
   * Narration anchor: land this action on the word marked `{{@name}}` in the
   * scene's narration. Compose retimes the scene piecewise so the beat plays
   * as the word is spoken. See docs/AUTHORING.md "Narration-anchored beats".
   */
  anchor: z.string().regex(/^[\w.-]+$/).optional(),
};

/**
 * Scroll easing presets. All are eased wheel scrolls; they differ in feel:
 * smooth = balanced ease-in-out (default), snappy = quick with a soft landing,
 * glide = long cinematic drift, linear = constant rate.
 */
export const EasingPresetSchema = z.enum(["smooth", "snappy", "glide", "linear"]);
export type EasingPreset = z.infer<typeof EasingPresetSchema>;

/**
 * Element state a wait/scroll resolves on. "visible" (default) is Playwright's
 * non-empty-box visibility; "attached" only requires the element to be in the
 * DOM — the escape hatch for zero-height lazy mount points.
 */
export const WaitStateSchema = z.enum(["visible", "attached"]);
export type WaitState = z.infer<typeof WaitStateSchema>;

/** Look of an attention overlay (highlight ring, spotlight edge, callout pill). */
export const AttentionStyleSchema = z.object({
  /** CSS color. Default: the storyboard `attention.color`, else #ff5a5f. */
  color: z.string().optional(),
  /** Outline thickness, px. Default 3. */
  thickness: z.number().min(1).max(12).optional(),
  /** Room between the element's box and the outline, px. Default 6. */
  padding: z.number().min(0).max(60).optional(),
  /** "box" (rounded rectangle, default) or "ring" (pill/circle). */
  shape: z.enum(["box", "ring"]).optional(),
});
export type AttentionStyle = z.infer<typeof AttentionStyleSchema>;

export const ActionSchema = z.discriminatedUnion("op", [
  z.object({ ...BaseAction, op: z.literal("goto"), url: z.string() }),
  z.object({
    ...BaseAction,
    op: z.literal("click"),
    target: TargetSchema,
    /**
     * When the click opens a NEW TAB (target=_blank, window.open), close it and
     * continue in the recorded tab at that URL — the take is one window, a
     * second tab is never in the video. Default false (a popup is left alone).
     */
    followPopup: z.boolean().optional(),
  }),
  z.object({
    ...BaseAction,
    op: z.literal("type"),
    target: TargetSchema,
    text: z.string(),
    /** Per-keystroke jitter for a human cadence. Default true. */
    humanize: z.boolean().optional(),
  }),
  z.object({
    ...BaseAction,
    op: z.literal("press"),
    key: z.string(),
    /** Show a keystroke chip for this press (overrides the top-level `keystrokes`). */
    keystrokes: z.boolean().optional(),
  }),
  z.object({
    ...BaseAction,
    op: z.literal("hover"),
    target: TargetSchema,
  }),
  z.object({
    ...BaseAction,
    op: z.literal("scrollTo"),
    target: TargetSchema,
    /** Scroll feel preset. Default "smooth". */
    easing: EasingPresetSchema.optional(),
    /** Override the preset's duration, ms. */
    durationMs: z.number().optional(),
    /**
     * Which element state to wait for before scrolling. Default "visible".
     * "attached" accepts a zero-size mount point (a lazily-filled empty <div>
     * that only renders once scrolled into view) — such an element is in the
     * DOM but never "visible", so the default would time out (issue #44).
     */
    state: WaitStateSchema.optional(),
    /**
     * After the scroll, wait until the scroll position has been still for this
     * many ms (bounded at 3 s) — an honest "scroll finished" instead of a fixed
     * pause against smooth-scroll settle races. Omit for the old fixed settle.
     */
    settleMs: z.number().optional(),
  }),
  z.object({
    ...BaseAction,
    op: z.literal("scrollBy"),
    /** CSS pixels to scroll; positive = down. */
    dy: z.number(),
    /**
     * Scope the scroll to this element's own scroller: the wheel is dispatched
     * over the element, and `dy` is clamped to the room its nearest scrollable
     * ancestor actually has — so a bottomed-out inner panel never chains the
     * wheel to the page and slides the whole app off-screen (issue #43). Omit
     * to scroll whatever is under the cursor (the page, usually).
     */
    target: TargetSchema.optional(),
    /** Scroll feel preset. Default "smooth". */
    easing: EasingPresetSchema.optional(),
    /** Override the preset's duration, ms. */
    durationMs: z.number().optional(),
    /** Wait until the scroll position has been still for this many ms (see scrollTo). */
    settleMs: z.number().optional(),
  }),
  z.object({
    ...BaseAction,
    op: z.literal("waitFor"),
    target: TargetSchema,
    timeoutMs: z.number().optional(),
    /**
     * Element state to wait for. Default "visible". "attached" = present in
     * the DOM even if zero-size/hidden — for lazily-filled mount points that
     * only become visible once something renders into them (issue #44).
     */
    state: WaitStateSchema.optional(),
  }),
  /**
   * Wait for an IN-PLACE mutation of an existing element — the gap that neither
   * waitFor (fires instantly if the selector already matches) nor waitForWidget
   * (waits for a wholly NEW widget) covers. Widget-side interactions re-render
   * the same widget (click-Add renders the basket bar into [data-cart-bar]; the
   * qty +/- re-renders the row), so the reliable signal is "this element's
   * content changed", not "a new element appeared".
   *
   * Captures a baseline signature (presence + text) of `target`, then waits
   * until it differs. With `textMatches`, waits for a change whose NEW text
   * matches the (case-insensitive) JS regex — e.g. target the qty display and
   * pass "2" to wait out a 1→2 re-render.
   */
  z.object({
    ...BaseAction,
    op: z.literal("waitForChange"),
    target: TargetSchema,
    /** Require the changed element's new text to match this JS regex (i-flag). */
    textMatches: z.string().optional(),
    timeoutMs: z.number().optional(),
    /** Record the elapsed span as idle (like waitForWidget) so compose trims it. */
    idle: z.boolean().optional(),
    label: z.string().default("updating"),
  }),
  /**
   * Like waitFor but the elapsed span is recorded as IDLE in the timeline.
   * Use it for "ChatGPT is thinking" waits so compose can trim/speed them.
   */
  z.object({
    ...BaseAction,
    op: z.literal("waitForWidget"),
    target: TargetSchema,
    /**
     * Require the NEW widget frame's text to match this JS regex (i-flag).
     * Different tools share selectors (product-carousel and product-compare
     * both carry button[data-add-id]); when a prompt could render either, an
     * unqualified wait passes on the wrong widget and the desync only shows in
     * review. Pick a string unique to the widget type you expect.
     */
    textMatches: z.string().optional(),
    label: z.string().default("thinking"),
    timeoutMs: z.number().optional(),
  }),
  /**
   * Wait for a NEW assistant reply that answers in TEXT (no widget) — the
   * main-frame twin of waitForWidget, for tools that reply without rendering
   * one (e.g. a delivery-options lookup). Baseline = assistant-message count at
   * wait start; satisfied when it grows AND generation has finished (composer
   * ready again). Always recorded as IDLE so compose trims the thinking time.
   */
  z.object({
    ...BaseAction,
    op: z.literal("waitForReply"),
    /** Selector counting assistant messages. Default: ChatGPT's message nodes. */
    selector: z.string().optional(),
    /** Require the new reply's text to match this JS regex (i-flag). */
    textMatches: z.string().optional(),
    label: z.string().default("thinking"),
    timeoutMs: z.number().optional(),
  }),
  /** Fixed pause (non-idle) — a deliberate on-screen beat. */
  z.object({ ...BaseAction, op: z.literal("pause"), ms: z.number() }),
  /**
   * Deliberate camera focus: record a zoom-in on `target` without interacting
   * with it (auto-zoom already fires on clicks/typing). Purely a timeline
   * marker — the zoom itself is rendered at compose time.
   */
  z.object({
    ...BaseAction,
    op: z.literal("focus"),
    target: TargetSchema,
    /** Zoom level for this focus; defaults to the storyboard zoom scale. */
    scale: z.number().min(1).max(4).optional(),
    /** How long to stay zoomed, ms; defaults to the storyboard zoom hold. */
    holdMs: z.number().optional(),
  }),
  /**
   * Screenshot mode: mark a named still at this beat. Purely a timeline marker
   * (like `focus`) — NO screenshot is taken at record time. `aidemo stills`
   * (and `render`) extract the PNG at compose time from the CLEAN take, so a
   * still is a re-extract away and never a re-record. `name` becomes the file
   * name (`output/stills/<name>.png`) so keep it a simple slug; duplicate names
   * across the storyboard are a hard error at extraction.
   */
  z.object({ ...BaseAction, op: z.literal("still"), name: z.string() }),
  /**
   * Attention beats — compose-time overlays drawn from a box the player
   * measures (like `focus`, they are timeline markers; the drawing happens at
   * compose, so restyling is a recompose). Each dwells briefly at record time
   * (min(holdMs, 800) ms) so the eye registers it before the next action.
   */
  /** Outline `target` (box or ring) for `holdMs`. */
  z.object({
    ...BaseAction,
    op: z.literal("highlight"),
    target: TargetSchema,
    /** How long the outline stays, ms. Default 1600. */
    holdMs: z.number().min(100).max(15000).optional(),
    style: AttentionStyleSchema.optional(),
  }),
  /** Dim everything except `target` for `holdMs`. */
  z.object({
    ...BaseAction,
    op: z.literal("spotlight"),
    target: TargetSchema,
    holdMs: z.number().min(100).max(15000).optional(),
    /** Opacity of the dim layer, 0–0.9. Default 0.55. */
    dimTo: z.number().min(0).max(0.9).optional(),
    /** Extra room around the element, px. Default 10. */
    padding: z.number().min(0).max(80).optional(),
    style: AttentionStyleSchema.optional(),
  }),
  /** Pin a short label to `target` for `holdMs`. */
  z.object({
    ...BaseAction,
    op: z.literal("callout"),
    target: TargetSchema,
    text: z.string().min(1).max(80),
    /** Where the label sits relative to the element. Default "auto". */
    placement: z.enum(["auto", "top", "bottom", "left", "right"]).optional(),
    holdMs: z.number().min(100).max(15000).optional(),
    style: AttentionStyleSchema.optional(),
  }),
  /**
   * Park the cursor deliberately: glide it to `target` (element center) or an
   * absolute viewport point (`x`,`y` CSS px) without clicking. Use it to move
   * the cursor out of the way before a reveal, or to point at what the
   * narration is talking about without an interaction.
   */
  z.object({
    ...BaseAction,
    op: z.literal("moveTo"),
    target: TargetSchema.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  /**
   * Prove the payoff happened. Fails the take with a named error unless
   * `target` is visible (and, when set, its text matches `textMatches`) and/or
   * the page URL matches `url` — polled until `timeoutMs` (default 5000). A
   * demo whose confirmation never rendered should fail loudly at record time,
   * not ship a video of a spinner.
   */
  z.object({
    ...BaseAction,
    op: z.literal("assert"),
    target: TargetSchema.optional(),
    /** Regex the target's text must match (JS syntax, e.g. "Order #\\d+"). */
    textMatches: z.string().optional(),
    /** Regex the page URL must match. */
    url: z.string().optional(),
    timeoutMs: z.number().optional(),
  }),
  /** Choose an option in a native <select> by value or visible label (the cursor clicks it first). */
  z.object({
    ...BaseAction,
    op: z.literal("select"),
    target: TargetSchema,
    value: z.string().optional(),
    label: z.string().optional(),
  }),
  /**
   * Drag `target` to `to` (another target, or absolute viewport `x`,`y`):
   * press, glide with the cursor, release — the drag shows in the take.
   */
  z.object({
    ...BaseAction,
    op: z.literal("drag"),
    target: TargetSchema,
    to: z.object({
      target: TargetSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
  }),
  /**
   * Attach files: `target` is a file input (set directly) or the button that
   * opens the OS file chooser (clicked; the chooser is answered headlessly —
   * no dialog appears in the take). Paths resolve against the demo dir.
   */
  z.object({
    ...BaseAction,
    op: z.literal("upload"),
    target: TargetSchema,
    files: z.array(z.string()).min(1),
  }),
  /** Browser back (history), with the same readiness wait as `goto`. */
  z.object({ ...BaseAction, op: z.literal("back") }),
]);
export type Action = z.infer<typeof ActionSchema>;

// ---------------------------------------------------------------------------
// Voice + music plans
// ---------------------------------------------------------------------------

export const VoicePlanSchema = z.object({
  /**
   * Voice id for the active TTS provider. Default provider = OpenAI (alloy,
   * ash, ballad, cedar, coral, echo, fable, marin, nova, onyx, sage, shimmer,
   * verse); with AIDEMO_TTS_PROVIDER=elevenlabs this is an ElevenLabs voice id.
   */
  voiceId: z.string().default("marin"),
  /** Steering prompt for gpt-4o-mini-tts: tone, emotion, pace. */
  instructions: z.string().optional(),
  /** Playback speed hint passed to the provider when supported. Default 1.0. */
  speed: z.number().min(0.5).max(2).optional(),
  /**
   * TTS-only substitutions, whole-word, case-sensitive: `{"aidemo":"A.I. demo",
   * "SQL":"sequel"}`. Applied to the text sent to the voice provider; the
   * narration (and therefore the captions) keeps the written form. Merged
   * storyboard → scene (scene entries win).
   */
  pronounce: z.record(z.string(), z.string()).optional(),
});
export type VoicePlan = z.infer<typeof VoicePlanSchema>;

export const MusicCueSchema = z.object({
  /**
   * Named cue within the track. NOTE: currently informational only — per-scene
   * cues do nothing (the bed plays continuously and ducks under narration).
   * Setting one logs a warning at storyboard load so it isn't a silent no-op.
   */
  cue: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Scene + Storyboard
// ---------------------------------------------------------------------------

/**
 * A region to blur at compose time. The player re-measures the selector after
 * every action (all matches, up to 8) and logs the spans; compose crops, blurs
 * and overlays each span back — so a price, an email, a token never ships,
 * and the strength is a recompose. Frame-relative selectors use `frame`.
 */
export const RedactSchema = z.object({
  selector: z.string(),
  frame: z.string().optional(),
  /** boxblur radius, px at the logical size. Default 14. */
  blur: z.number().min(2).max(60).optional(),
});
export type Redact = z.infer<typeof RedactSchema>;

/** Caption strip placement + look. */
export const CaptionsConfigSchema = z.object({
  /**
   * "bottom" (default) or "top". With "auto-flip" (the default behaviour when
   * omitted at scene level) compose moves the strip to the top while a
   * highlight/spotlight/callout box or a keystroke chip would collide with it.
   */
  position: z.enum(["bottom", "top"]).optional(),
  /** "pill" (default, centered rounded box), "bar" (full-width band), "none" (no captions burned). */
  style: z.enum(["pill", "bar", "none"]).optional(),
  /** CSS font-family. Default: the brand font, else the system sans. */
  font: z.string().optional(),
  /** Font size, px at the logical width. Default 30. */
  size: z.number().min(14).max(72).optional(),
  /** Text color. Default #fff. */
  color: z.string().optional(),
  /** Pill/bar background (CSS). Default rgba(12,14,22,.66). */
  background: z.string().optional(),
});
export type CaptionsConfig = z.infer<typeof CaptionsConfigSchema>;

/** Storyboard-wide defaults for the attention overlays. */
export const AttentionConfigSchema = z.object({
  /** Default outline / pill accent color. Default #ff5a5f. */
  color: z.string().optional(),
  /** Draw a click ring where every click lands (compose-time cursor only). */
  clicks: z.boolean().optional(),
});
export type AttentionConfig = z.infer<typeof AttentionConfigSchema>;

/**
 * Produced-look frame around the content: padding, background, rounded
 * corners, drop shadow, optional browser chrome. Compose-time; captions and
 * cards render at the framed canvas size. Omit for the raw recording frame.
 */
export const FrameSchema = z.object({
  /** Padding around the video, px at the logical size. Default 48. */
  padding: z.number().min(0).max(400).optional(),
  /** CSS background (color or gradient). Default: dark gradient tinted by brand.accent. */
  background: z.string().optional(),
  /** Corner radius of the video window, px. Default 14. */
  radius: z.number().min(0).max(80).optional(),
  /** Drop shadow under the window. Default true. */
  shadow: z.boolean().optional(),
  /**
   * Window chrome: "none" (default), "browser" / "mac" (a bar with dots or
   * traffic lights above the video), or a device bezel for phone-sized
   * viewports — "iphone" (rounded bezel + dynamic island) / "android" (bezel +
   * punch-hole camera). Device chrome adds no bar; `radius` defaults to 40.
   */
  chrome: z.enum(["none", "browser", "mac", "iphone", "android"]).optional(),
  /**
   * Device chrome only: reserve a status-bar strip of bezel ABOVE the video
   * (px at the logical size) instead of drawing the island / punch-hole over
   * the recording's top pixels. `true` = 46 px (an iPhone status bar). Use it
   * when the app paints something at the very top that must stay visible.
   */
  safeTop: z.union([z.boolean(), z.number().min(0).max(120)]).optional(),
  /** Text in the chrome's address pill (url wins over title). */
  title: z.string().optional(),
  url: z.string().optional(),
});
export type Frame = z.infer<typeof FrameSchema>;

/** Brand kit applied across cards, frame, captions, callouts and a watermark. */
export const BrandSchema = z.object({
  /** Logo image path (png/svg/jpg), relative to the demo dir or absolute. Used as the watermark. */
  logo: z.string().optional(),
  /** Accent color: card rule, frame tint, default attention color. */
  accent: z.string().optional(),
  /** CSS font-family for cards, captions, callouts, chrome. */
  font: z.string().optional(),
  /** Watermark placement for `logo`. */
  watermark: z
    .object({
      position: z
        .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
        .optional(),
      /** 0–1. Default 0.85. */
      opacity: z.number().min(0).max(1).optional(),
      /** Logo width as a fraction of the frame width. Default 0.11. */
      scale: z.number().min(0.03).max(0.5).optional(),
      /** Set false to keep the logo out of the video (cards only). */
      enabled: z.boolean().optional(),
    })
    .optional(),
});
export type Brand = z.infer<typeof BrandSchema>;

/** Tuning for compose-time idle detection (`autoIdle`). */
export const AutoIdleSchema = z.object({
  enabled: z.boolean().optional(),
  /** Shortest motionless span that counts as idle, ms. Default 1500. */
  minMs: z.number().min(400).max(20000).optional(),
  /**
   * Per-pixel noise floor below which two frames count as identical (ffmpeg
   * `freezedetect` noise, 0..1). Default 0.003 — tolerant of encoder dither,
   * tight enough that a blinking caret still reads as motion.
   */
  noise: z.number().min(0).max(0.2).optional(),
});
export type AutoIdle = z.infer<typeof AutoIdleSchema>;

export const SceneSchema = z.object({
  id: z.string(),
  /** Chapter title for this beat (`output.chapters`); defaults to the scene id. */
  title: z.string().optional(),
  /** Spoken narration for this beat. Also the caption source of truth. */
  narration: z.string(),
  /**
   * Translated narration per language code (e.g. {"de":"…","fr":"…"}) for
   * multi-language renders from ONE take (see src/i18n.ts). `render`/`voice`/
   * `captions`/`compose --lang <code>` speak/caption `narrations[code]` instead
   * of `narration` over the shared recording; the default (no `--lang`) always
   * uses `narration`. Translations are authored — the pipeline never calls an
   * LLM to translate. A code missing here falls back to `narration`.
   */
  narrations: z.record(z.string(), z.string()).optional(),
  /**
   * Engine-populated at parse time from `{{@name}}` markers in `narration`:
   * name → 0-based index of the word the beat lands on. Don't author this —
   * write the marker in the narration instead.
   */
  anchors: z.record(z.string(), z.number().int().min(0)).optional(),
  /** Same, per `narrations` language code. */
  narrationAnchors: z.record(z.string(), z.record(z.string(), z.number().int().min(0))).optional(),
  voice: VoicePlanSchema.optional(),
  music: MusicCueSchema.optional(),
  /** Set false to suppress auto-zoom for this scene's clicks/typing. */
  zoom: z.boolean().optional(),
  /** Override the top-level `autoIdle` for this scene (true enables, false disables). */
  autoIdle: z.boolean().optional(),
  /** Caption placement for this scene (overrides top-level `captions.position`). */
  captions: CaptionsConfigSchema.optional(),
  /** Blur these regions while this scene records (adds to top-level `redact`). */
  redact: z.array(RedactSchema).optional(),
  /** Hide these selectors for this scene (adds to top-level `hide`). */
  hide: z.array(z.string()).optional(),
  actions: z.array(ActionSchema).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

export const MusicPlanSchema = z.object({
  /** Path to a local audio file, relative to the project dir, or absolute. */
  track: z.string().optional(),
  /**
   * Ducking mode. "sidechain" (default) compresses the music with the narration
   * as the key signal, so the bed breathes — up in pauses, down under speech.
   * "constant" is the legacy fixed-level duck (see duckToDb).
   */
  ducking: z.enum(["sidechain", "constant"]).default("sidechain"),
  /** Base music-bed gain in dB (pre-duck level heard in narration gaps). Default -14. */
  gainDb: z.number().optional(),
  /** Constant-mode ducked level for the whole bed, in dB. Default -22. */
  duckToDb: z.number().optional(),
  /** Sidechain knobs (sane defaults; rarely need touching). */
  duckThreshold: z.number().optional(),
  duckRatio: z.number().optional(),
  duckAttackMs: z.number().optional(),
  duckReleaseMs: z.number().optional(),
  /** Fade the music out over the last N ms of the video. Default 1800. */
  fadeOutMs: z.number().optional(),
});
export type MusicPlan = z.infer<typeof MusicPlanSchema>;

// ---------------------------------------------------------------------------
// Cinematic polish — auto-zoom config and intro/outro cards
// ---------------------------------------------------------------------------

/**
 * Screen-Studio-style auto-zoom. When present on the storyboard, compose zooms
 * into each recorded focus point (clicks, typing, explicit `focus` actions)
 * with eased in/hold/out choreography, panning between nearby focus points
 * instead of zooming out. Omit the key entirely to disable.
 */
export const ZoomConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Zoom-in level. 1.4–1.8 reads well at 720p. Default 1.55. */
  scale: z.number().min(1).max(4).default(1.55),
  /** Zoom in/out transition length, ms. Default 600. */
  easeMs: z.number().default(600),
  /** How long to stay zoomed after a focus point, ms. Default 1700. */
  holdMs: z.number().default(1700),
});
export type ZoomConfig = z.infer<typeof ZoomConfigSchema>;

/**
 * Motion blur (opt-in, compose-time). Averages a small sliding window of frames
 * (ffmpeg `tmix`), so fast motion — cursor glides, eased scrolls, zoom pans —
 * gets a subtle trail while static UI stays sharp (identical frames average to
 * themselves). Pure post-processing over the content: omit the key and compose
 * behaves exactly as before. Portable — `tmix` is a baseline libavfilter filter,
 * no drawtext/subtitles needed.
 */
export const MotionBlurSchema = z.object({
  enabled: z.boolean().default(true),
  /** Frames averaged in the sliding window. 2 = whisper, 3 = default, up to 6. */
  frames: z.number().int().min(2).max(6).default(3),
});
export type MotionBlur = z.infer<typeof MotionBlurSchema>;

/**
 * Cursor rendering (opt-in, compose-time control). Omit the key for the default:
 * the animated cursor is BAKED into the recording (unchanged, byte-for-byte).
 *
 * Add a `cursor` block and the cursor becomes a **compose-time layer**: the
 * recorder leaves the take cursor-free while the player logs the cursor path,
 * and compose draws the cursor as an overlay along that path (over the content,
 * so it zooms/pans with the frame). Because it's now a compose layer, styling it
 * is a recompose, never a re-record — hide it for the whole demo (`hidden`, for
 * clean product shots), hide it only on certain scenes (`hideScenes`), or resize
 * it (`scale`). Requires re-recording ONCE with the block present (so the clean,
 * cursor-free take + path exist); after that, every hide/resize is compose-only.
 */
export const CursorConfigSchema = z.object({
  /** Hide the cursor for the entire demo (no overlay drawn). */
  hidden: z.boolean().optional(),
  /** Hide the cursor only during these scene ids (e.g. a full-screen result). */
  hideScenes: z.array(z.string()).optional(),
  /** Cursor size multiplier (1 = the 24px baseline arrow). */
  scale: z.number().min(0.5).max(4).optional(),
  /** Pointer look: classic "arrow" (default) or a soft "dot" (screen-recorder style). */
  style: z.enum(["arrow", "dot"]).optional(),
  /** Dot style only: fill color. Default rgba(255,90,95,.85). */
  color: z.string().optional(),
});
export type CursorConfig = z.infer<typeof CursorConfigSchema>;

/** A rendered intro/outro title card. */
export const CardSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  /** On-screen time, ms (excluding fades). Default 2600. */
  durationMs: z.number().default(2600),
  /** CSS background (color or gradient). Default: dark gradient. */
  background: z.string().optional(),
  /** Accent color for the underline detail. Default #6c8cff. */
  accent: z.string().optional(),
  /** Fade in/out length, ms. Default 350. */
  fadeMs: z.number().default(350),
  /**
   * Translated card copy per language code, for multi-language renders
   * (`--lang <code>`). Each entry may override `title` and/or `subtitle`; an
   * absent field falls back to the base card. Only narration + captions + card
   * copy localize — the recorded UI itself is unchanged.
   */
  i18n: z
    .record(
      z.string(),
      z.object({ title: z.string().optional(), subtitle: z.string().optional() })
    )
    .optional(),
});
export type Card = z.infer<typeof CardSchema>;

/**
 * Scene-to-scene transition (opt-in). When present, compose crossfades the
 * video across every scene boundary instead of hard-cutting. The overlap is
 * stolen from each scene's own frozen tail so the timeline does NOT shrink —
 * total duration and per-scene narration alignment are preserved exactly.
 * Omit the key for the default hard cuts (unchanged stream-copy concat).
 */
export const TransitionSchema = z.object({
  type: z.literal("crossfade"),
  /** Crossfade length, ms. Default 400. */
  durationMs: z.number().default(400),
});
export type Transition = z.infer<typeof TransitionSchema>;

/**
 * Master loudness target for the final muxed audio (ffmpeg `loudnorm`). Lands
 * the master at streaming/broadcast norms so it isn't quiet next to anything
 * else the viewer plays. A single-pass `loudnorm` runs LAST over the muxed
 * audio; it is default-ON only when a `music` block is present (the music mix
 * otherwise leaves the master ~-29 LUFS) and OFF for a plain narration-only
 * render. See `output.loudness` to override or disable. Partial overrides fill
 * from these defaults.
 */
export const LoudnessSchema = z.object({
  /** Integrated loudness target, LUFS. Default -16 (YouTube/podcast norm). */
  integrated: z.number().default(-16),
  /** Maximum true peak, dBTP. Default -1.5. */
  truePeak: z.number().default(-1.5),
  /** Loudness range target, LU. Default 11. */
  lra: z.number().default(11),
});
export type Loudness = z.infer<typeof LoudnessSchema>;

/**
 * Final output sizing + loudness (opt-in). Renders the composed video at a
 * different size/aspect than the recording — e.g. a vertical 1080x1920 social
 * clip from a 1280x720 take. Applied AFTER cards + captions, so the whole frame
 * is scaled as one. Omit to keep the recording size. width/height should be
 * even (yuv420p) and are set together. Uses core scale/pad/crop filters only.
 * `loudness` (independent of resize) tunes the master level; omit it entirely
 * for the automatic default (loudnorm when there's music, none otherwise).
 */
/** Named output presets — fill width/height/fit when they are not set explicitly. */
export const OutputPresetSchema = z.enum(["youtube", "short", "readme-gif", "x"]);
export type OutputPreset = z.infer<typeof OutputPresetSchema>;
export const OUTPUT_PRESETS: Record<
  OutputPreset,
  { width: number; height: number; fit: "contain" | "cover" }
> = {
  youtube: { width: 1920, height: 1080, fit: "contain" },
  short: { width: 1080, height: 1920, fit: "contain" },
  "readme-gif": { width: 960, height: 540, fit: "contain" },
  x: { width: 1280, height: 720, fit: "contain" },
};

export const OutputSchema = z
  .object({
    /** Preset sizing (see OUTPUT_PRESETS); explicit width/height/fit win. */
    preset: OutputPresetSchema.optional(),
    /** Write MP4 chapter markers, one per scene (scene `title` or id). Default false. */
    chapters: z.boolean().optional(),
    /** Also extract output/poster.png (first content frame after the intro). Default false. */
    poster: z.boolean().optional(),
    /**
     * Also export output/walkthrough/ (index.html + guide.md + per-scene
     * frames + captions) after every render. Default false; `aidemo
     * walkthrough <dir>` / the `walkthrough` job export on demand.
     */
    walkthrough: z.boolean().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    /**
     * "contain" (default) = scale to fit + pad the remainder (letterbox bars).
     * "cover" = scale to fill + center-crop the overflow (no bars).
     */
    fit: z.enum(["contain", "cover"]).default("contain"),
    /** Pad color for "contain" (ffmpeg color syntax, e.g. black, 0x1a1a1a). Default black. */
    background: z.string().optional(),
    /**
     * Master loudness normalization. `false` disables the final loudnorm pass;
     * an object overrides the targets (partial objects fill from LoudnessSchema
     * defaults) and also FORCES the pass on even for a narration-only master.
     * Omit for the default: loudnorm when a `music` block is present, none for a
     * plain narration render (so that path stays byte-for-byte unchanged).
     */
    loudness: z.union([z.literal(false), LoudnessSchema]).optional(),
  })
  // Resizing needs both dimensions or neither; loudness works on its own.
  .refine((o) => (o.width == null) === (o.height == null), {
    message: "output.width and output.height must be set together",
  });
export type Output = z.infer<typeof OutputSchema>;


/**
 * What compose does when a scene's narration outlasts its recorded action
 * (after the ≤1.6x slow-down): the remainder is a HOLD on the last frame.
 * Default "freeze" clones that frame (byte-for-byte the pre-`hold` behavior).
 * "drift" instead pushes in very slowly on it (a Ken-Burns-style creep of
 * `driftScale` over the hold), so a 10 s hold reads as a deliberate dwell
 * rather than a stalled video — the fix for narration-heavy demos where half
 * the runtime was a frozen frame (issue #40). `backoffMs` takes the held frame
 * from slightly BEFORE the segment's end, dodging a half-painted transition or
 * a hover state caught mid-flight. Opt-in: omit the key for the old behavior.
 */
export const HoldSchema = z.object({
  mode: z.enum(["freeze", "drift"]).default("freeze"),
  /** Drift mode: zoom level reached at the end of the hold. Default 1.06. */
  driftScale: z.number().min(1).max(1.5).default(1.06),
  /** Take the held frame this many ms before the segment end. Default 0. */
  backoffMs: z.number().min(0).max(2000).default(0),
});
export type HoldConfig = z.infer<typeof HoldSchema>;

/**
 * One cookie to seed into the recording profile before the take. Mirrors
 * Playwright's cookie shape; `domain` + `path` (or `url`) place it.
 */
export const SeedCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  /** Cookie domain, e.g. ".example.com" or "app.example.com". */
  domain: z.string().optional(),
  /** Cookie path. Default "/". */
  path: z.string().optional(),
  /** Alternative to domain+path: the URL the cookie belongs to. */
  url: z.string().optional(),
  /** Unix time in seconds; omit for a session cookie. */
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
});
export type SeedCookie = z.infer<typeof SeedCookieSchema>;

/**
 * How the take is prepared BEFORE the first action — the answer to "the
 * feature is behind a cookie gate / a preview token / a rotating fixture"
 * without a hand-written Playwright seed script (issue #44). Everything here
 * is opt-in; a storyboard without `setup` records exactly as before.
 */
export const SetupSchema = z.object({
  /**
   * Path (relative to the demo dir, or absolute) to a Playwright storageState
   * JSON (`{cookies:[…], origins:[{origin, localStorage:[{name,value}]}]}`),
   * e.g. one saved by `context.storageState({path})`. Its cookies are added
   * to the recording profile and each origin's localStorage entries are set
   * before the storyboard runs. CLI: `--storage-state <file>`.
   */
  storageState: z.string().optional(),
  /** Cookies to add before the take. CLI: `--cookie name=value;domain=host` (repeatable). */
  cookies: z.array(SeedCookieSchema).optional(),
  /**
   * Shell command run from the demo dir before EVERY take (record/probe/render),
   * after the profile is resolved and before Chrome launches — e.g. a script
   * that re-seeds a fixture, or patches the storyboard for whichever variant
   * the app will serve today. Env: AIDEMO_DEMO_DIR, AIDEMO_STORYBOARD (the
   * storyboard path — re-read after the hook, so edits are honored),
   * AIDEMO_PROFILE (the Chrome user-data dir the take will use). A non-zero
   * exit aborts the take.
   */
  preflight: z.string().optional(),
  /**
   * Acknowledge that the recording profile is deliberately seeded (a login,
   * a cookie gate) and silence the carried-over-state warning for this
   * storyboard. Implied when storageState/cookies are given. CLI:
   * `--profile-seeded`.
   */
  expectState: z.boolean().optional(),
});
export type Setup = z.infer<typeof SetupSchema>;

export const StoryboardSchema = z.object({
  title: z.string(),
  /**
   * BCP-47/ISO-639-1 code for the base `narration`'s spoken language (e.g.
   * "et" for Estonian, "de" for German). Optional metadata — distinct from
   * the `--lang` render-selection mechanism (src/i18n.ts), which picks a
   * scene's `narrations[code]` translation; this field describes whatever
   * language the DEFAULT `narration` is already written in (useful for a
   * monolingual non-English demo with no translations at all). `captions`
   * uses it (falling back to an active `--lang`) to hint Whisper's
   * `language` param and to warn that `--offline` is the guaranteed-correct
   * fallback for non-English narration. Omit for English / to auto-detect.
   */
  language: z.string().optional(),
  /**
   * Product names, brands and jargon that Whisper reliably mis-hears — the
   * transcript is what gets burned in, so "fitness.ee" coming back as
   * "fitness topam" ships as a caption (issue #38). Listed here they are sent
   * at the FRONT of the STT prompt, inside the window Whisper actually biases
   * on, even when the script itself is long. Cheaper than `captions --offline`,
   * which fixes spelling but gives up real word timings.
   */
  knownTerms: z.array(z.string()).optional(),
  /**
   * Declared template parameters: name → default value. Enables `{{name}}`
   * placeholders in any storyboard string (narration, action url, `type` text,
   * card title/subtitle, waitFor* textMatches, voice instructions, …). At load
   * time each param resolves to a `--param`/MCP/variant override else its
   * default; unresolved or undeclared placeholders are a hard load-time error.
   * Omit entirely for a non-parameterized storyboard (renders identically).
   */
  params: z.record(z.string(), z.string()).optional(),
  targetLengthSeconds: z.number().optional(),
  /** Recording viewport / video size. Default 1280x720. */
  video: z
    .object({ width: z.number(), height: z.number() })
    .default({ width: 1280, height: 720 }),
  /** Named frames used by actions, mapping name -> iframe selector. */
  frames: z.record(z.string(), z.string()).default({}),
  /** Default voice plan; scenes may override. */
  voice: VoicePlanSchema.optional(),
  music: MusicPlanSchema.optional(),
  /** Auto-zoom on focus. Omit to disable (no zoom). */
  zoom: ZoomConfigSchema.optional(),
  /** Optional title cards around the demo (music plays under both). */
  intro: CardSchema.optional(),
  outro: CardSchema.optional(),
  /** Scene-to-scene transition (opt-in crossfade). Omit for hard cuts. */
  transition: TransitionSchema.optional(),
  /** Final output sizing (opt-in letterbox/crop). Omit to keep recording size. */
  output: OutputSchema.optional(),
  /** Subtle motion blur on fast motion (opt-in, compose-time). Omit to disable. */
  motionBlur: MotionBlurSchema.optional(),
  /** Compose-time cursor control (hide/resize post-hoc). Omit to bake the cursor. */
  cursor: CursorConfigSchema.optional(),
  /** Pre-take preparation: cookies / storageState seeding, a preflight hook. Opt-in. */
  setup: SetupSchema.optional(),
  /** How compose fills narration that outlasts a scene's action (freeze | drift). Opt-in. */
  hold: HoldSchema.optional(),
  /**
   * Trim un-annotated dead air: compose scans the take for spans where nothing
   * on screen moves and treats them as idle (capped like `waitFor*` idle is),
   * so a slow XHR or a long `pause` stops inflating the scene. Opt-in — omit
   * for the old behavior, where only annotated waits count as idle. Pass an
   * object to tune the threshold; per-scene `autoIdle` overrides it.
   */
  autoIdle: z.union([z.boolean(), AutoIdleSchema]).optional(),
  /** Defaults for highlight/spotlight/callout overlays + click rings. Opt-in. */
  attention: AttentionConfigSchema.optional(),
  /** Produced-look frame: padding/background/radius/shadow/chrome. Opt-in. */
  frame: FrameSchema.optional(),
  /** Brand kit: logo watermark, accent, font. Opt-in. */
  brand: BrandSchema.optional(),
  /** Show a keystroke chip on every `press` (per-action `keystrokes` overrides). Opt-in. */
  keystrokes: z.boolean().optional(),
  /** Caption strip placement (bottom | top). Opt-in; per-scene `captions` overrides. */
  captions: CaptionsConfigSchema.optional(),
  /** Regions blurred at compose time throughout the demo. Opt-in. */
  redact: z.array(RedactSchema).optional(),
  /** Selectors hidden (visibility:hidden) at record time throughout the demo. Opt-in. */
  hide: z.array(z.string()).optional(),
  scenes: z.array(SceneSchema).min(1),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

// ---------------------------------------------------------------------------
// Timeline manifest — emitted by the player during recording. Wall-clock
// offsets in ms, relative to record start (t=0). Drives sync + gap-trimming.
// ---------------------------------------------------------------------------

export const IdleSpanSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  label: z.string(),
});
export type IdleSpan = z.infer<typeof IdleSpanSchema>;

/**
 * A point of user attention the player recorded (click, typing start, or an
 * explicit `focus` action). Coordinates are viewport CSS px at the moment of
 * the event; tMs is timeline time. Compose turns these into auto-zoom moves.
 */
export const FocusEventSchema = z.object({
  tMs: z.number(),
  x: z.number(),
  y: z.number(),
  kind: z.string().optional(),
  /** Per-event overrides (from the `focus` action). */
  scale: z.number().optional(),
  holdMs: z.number().optional(),
});
export type FocusEvent = z.infer<typeof FocusEventSchema>;

/**
 * A named still the player recorded (from a `still` action). tMs is timeline
 * time; screenshot mode maps it to take-video time and extracts a PNG at
 * compose time. Default [] keeps pre-screenshot-mode timelines valid.
 */
export const StillEventSchema = z.object({
  tMs: z.number(),
  name: z.string(),
});
export type StillEvent = z.infer<typeof StillEventSchema>;

/**
 * A cursor position the player sampled while gliding the mouse (viewport CSS px
 * at `tMs` timeline time). Only recorded when the storyboard opts into
 * compose-time cursor rendering (`cursor` block) — compose replays these as an
 * overlay along the path. Default [] keeps pre-cursor-overlay timelines valid.
 */
export const CursorSampleSchema = z.object({
  tMs: z.number(),
  x: z.number(),
  y: z.number(),
});
export type CursorSample = z.infer<typeof CursorSampleSchema>;

/**
 * What one storyboard action actually did during the take: wall-clock window,
 * outcome, retries, and anything worth a second look (failed requests seen in
 * its window, an optional skip). The per-action twin of the compose report —
 * an agent reads this to see which action ate the time or was skipped without
 * regex-mining the log. Default [] keeps older timelines valid.
 */
export const TimelineActionSchema = z.object({
  /** 0-based index in the scene's actions[]. */
  index: z.number(),
  op: z.string(),
  /** Resolved target (named→selector, frame-prefixed) / goto URL, when any. */
  target: z.string().optional(),
  startMs: z.number(),
  endMs: z.number(),
  ok: z.boolean(),
  /** An `optional` action whose target never appeared / that failed. */
  skipped: z.boolean().optional(),
  /** Extra attempts consumed before success (from `retry`). */
  retries: z.number().optional(),
  warnings: z.array(z.string()).optional(),
});
export type TimelineAction = z.infer<typeof TimelineActionSchema>;

/** A measured attention beat (highlight/spotlight/callout) — viewport CSS px. */
export const AttentionEventSchema = z.object({
  tMs: z.number(),
  kind: z.enum(["highlight", "spotlight", "callout"]),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  holdMs: z.number(),
  text: z.string().optional(),
  placement: z.string().optional(),
  dimTo: z.number().optional(),
  padding: z.number().optional(),
  style: AttentionStyleSchema.optional(),
});
export type AttentionEvent = z.infer<typeof AttentionEventSchema>;

/** A key press to show as a chip (already prettified, e.g. "⌘ K", "Enter"). */
export const KeyEventSchema = z.object({ tMs: z.number(), keys: z.string() });
export type KeyEvent = z.infer<typeof KeyEventSchema>;

/** A region blurred at compose time over [startMs, endMs] — viewport CSS px. */
export const RedactSpanSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  blur: z.number(),
});
export type RedactSpan = z.infer<typeof RedactSpanSchema>;

export const TimelineSceneSchema = z.object({
  id: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  idleSpans: z.array(IdleSpanSchema).default([]),
  focusEvents: z.array(FocusEventSchema).default([]),
  stillEvents: z.array(StillEventSchema).default([]),
  cursorSamples: z.array(CursorSampleSchema).default([]),
  actions: z.array(TimelineActionSchema).default([]),
  attentionEvents: z.array(AttentionEventSchema).default([]),
  keyEvents: z.array(KeyEventSchema).default([]),
  redactSpans: z.array(RedactSpanSchema).default([]),
  /** Anchored actions: when the beat happened in the raw take (scene-relative like tMs elsewhere). */
  anchorEvents: z.array(z.object({ name: z.string(), tMs: z.number(), action: z.number() })).default([]),
  /**
   * Resume (`record --from-scene`): scenes reused from an earlier take name the
   * raw file they live in (relative to the demo dir) and that take's lead-in;
   * absent = the current take (`recordings/raw.*` + the timeline's leadInMs).
   */
  source: z.string().optional(),
  leadInMs: z.number().optional(),
  /** Identity of the scene's action-spec at record time — resume reuses a scene only when it matches. */
  hash: z.string().optional(),
});
export type TimelineScene = z.infer<typeof TimelineSceneSchema>;

export const TimelineSchema = z.object({
  totalMs: z.number(),
  /**
   * Ms between video-recording start and timeline t=0 (the about:blank lead-in).
   * compose adds this to every scene offset to map timeline time -> video time.
   */
  leadInMs: z.number().default(0),
  scenes: z.array(TimelineSceneSchema),
});
export type Timeline = z.infer<typeof TimelineSchema>;


// ---------------------------------------------------------------------------
// Compose report — written to output/report.json by every compose. The
// structured twin of the compose log: per-scene retime facts (how much was
// stretched, held, trimmed) plus machine-readable warnings, so an agent can
// judge a take without regex-mining logTail (issue #40's 28-scene log
// overflowed the 40-line tail; the freeze-hold dominance was invisible).
// ---------------------------------------------------------------------------

export const ComposeWarningSchema = z.object({
  /** Stable code: scene-freeze | overrun-trim | blank-tail | stale-captions |
   *  focus-dropped | cursor-missing | scene-no-narration */
  code: z.string(),
  scene: z.string().optional(),
  message: z.string(),
});
export type ComposeWarning = z.infer<typeof ComposeWarningSchema>;

export const ComposeSceneReportSchema = z.object({
  id: z.string(),
  /** Recorded (kept, non-idle) ms feeding this scene. */
  srcMs: z.number(),
  /** Narration + gap ms the scene had to fill. */
  targetMs: z.number(),
  /** Time-stretch factor applied (0.5 … 1.6). */
  factor: z.number(),
  /** Ms of hold (frozen / drifting last frame) appended after the stretch. */
  holdMs: z.number(),
  /** holdMs / targetMs — the share of the scene that is a held frame. */
  holdPct: z.number(),
  /** Ms of recorded action cut from the tail because it overran the narration. */
  tailTrimMs: z.number(),
  /** Ms of solid-color tail dropped before holding (white pre-paint). */
  blankTrimMs: z.number(),
  /** Ms of motionless footage `autoIdle` marked trimmable in this scene (0 when off). */
  autoIdleMs: z.number().default(0),
  /** Kept spans the scene was cut from (idle spans trimmed between them). */
  spans: z.number(),
  /** Focus points (zoom) this scene contributed. */
  focusEvents: z.number(),
  /** Narration anchors: where the beat was asked to land vs where it did (content ms, scene-relative). */
  anchors: z
    .array(
      z.object({
        name: z.string(),
        targetMs: z.number(),
        landedMs: z.number(),
        /** landedMs − targetMs; |offMs| > 150 raises `anchor-unreachable`. */
        offMs: z.number(),
      })
    )
    .optional(),
});
export type ComposeSceneReport = z.infer<typeof ComposeSceneReportSchema>;

export const ComposeReportSchema = z.object({
  output: z.string(),
  /** Final video length, ms. */
  durationMs: z.number(),
  scenes: z.array(ComposeSceneReportSchema),
  zoom: z.object({ focusTotal: z.number(), focusDropped: z.number() }),
  cursorPoints: z.number(),
  captions: z.object({ cues: z.number(), passes: z.number() }),
  /** Attention overlays drawn (highlight/spotlight/callout), key chips, click rings, redact spans. */
  attention: z
    .object({
      events: z.number(),
      keys: z.number(),
      clicks: z.number(),
      redactSpans: z.number(),
      captionsFlipped: z.number(),
    })
    .optional(),
  hold: z.string(),
  /** output/poster.png when `output.poster` is set. */
  poster: z.string().optional(),
  warnings: z.array(ComposeWarningSchema),
});
export type ComposeReport = z.infer<typeof ComposeReportSchema>;

// ---------------------------------------------------------------------------
// Voice manifest — emitted by the voice step. compose uses per-scene durations
// as the target length for each scene's video segment.
// ---------------------------------------------------------------------------

export const VoiceManifestSchema = z.object({
  /** Silence inserted between scenes in the narration track, ms. */
  gapMs: z.number(),
  scenes: z.array(
    z.object({
      id: z.string(),
      file: z.string(),
      durationMs: z.number(),
      /**
       * sha256 of (narration + resolved voice plan). Lets a re-run skip TTS for
       * scenes whose narration/voice is unchanged. Optional for back-compat with
       * manifests written before hashing existed.
       */
      hash: z.string().optional(),
    })
  ),
});
export type VoiceManifest = z.infer<typeof VoiceManifestSchema>;

// ---------------------------------------------------------------------------
// Captions manifest — emitted by the captions step. Mirrors voice.json's
// content-hash reuse (VoiceManifest.hash): a captions re-run whose inputs are
// unchanged reuses the stored word timings instead of re-transcribing. Optional
// artifact; captions still work if it's absent (first run / deleted).
// ---------------------------------------------------------------------------

/** A word with scene-relative timing (seconds from the scene's own start). */
export const CaptionWordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
});
export type CaptionWord = z.infer<typeof CaptionWordSchema>;

export const CaptionCueSchema = z.object({
  index: z.number(),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
});

export const CaptionsManifestSchema = z.object({
  /** Which path wrote this: "stt" (Whisper/local STT) or "offline" (script-timed). */
  mode: z.enum(["stt", "offline"]),
  /**
   * Combined hash of every caption-affecting input. A full match means the
   * stored cues can be reused verbatim — no transcription at all.
   */
  inputHash: z.string(),
  /** Cue-grouping config; a change re-segments even with identical words. */
  config: z.object({
    gapMs: z.number(),
    maxWords: z.number(),
    maxCueMs: z.number(),
  }),
  /**
   * Per-scene inputs + reusable scene-relative word timings. Offline path:
   * enables per-scene reuse (only a changed scene is re-derived). STT path:
   * the transcript split per scene, so compose can place narration anchors
   * on the word that was actually spoken.
   */
  scenes: z
    .array(
      z.object({
        id: z.string(),
        /** sha256 of (narration + durationMs + config) — the scene's caption identity. */
        hash: z.string(),
        durationMs: z.number(),
        words: z.array(CaptionWordSchema),
      })
    )
    .optional(),
  /** The assembled cues — the reusable result (both modes). */
  cues: z.array(CaptionCueSchema),
});
export type CaptionsManifest = z.infer<typeof CaptionsManifestSchema>;

// ---------------------------------------------------------------------------
// Probe golden — a normalized, deterministic projection of a probe run, used as
// a checked-in regression baseline (vhs's golden-file pattern). Timing-free by
// design: only stable outcomes (op, resolved target, ok, found, goto final URL)
// so `aidemo probe --golden` fails a CI check when a UI change breaks the flow.
// ---------------------------------------------------------------------------

export const ProbeActionOutcomeSchema = z.object({
  op: z.string(),
  /** For target actions: the resolved selector (named→selector, frame-prefixed).
   *  For goto: the requested URL. Omitted for press/pause/scrollBy. */
  target: z.string().optional(),
  /** The action completed without throwing (deterministic replay outcome). */
  ok: z.boolean(),
  /** Target-bearing actions: did the selector resolve to ≥1 element on the page. */
  found: z.boolean().optional(),
  /** goto only: page URL after navigation (redirects surface here). */
  finalUrl: z.string().optional(),
  key: z.string().optional(),
  ms: z.number().optional(),
  dy: z.number().optional(),
  label: z.string().optional(),
  /**
   * The action is marked `optional` in the storyboard. Optional actions always
   * record ok:true and no `found`: their real outcome is environment-dependent
   * by design (that's what optional is for), so it's normalized out of the
   * golden projection to keep it deterministic across runs.
   */
  optional: z.boolean().optional(),
});
export type ProbeActionOutcome = z.infer<typeof ProbeActionOutcomeSchema>;

export const ProbeGoldenSceneSchema = z.object({
  id: z.string(),
  actions: z.array(ProbeActionOutcomeSchema),
});
export type ProbeGoldenScene = z.infer<typeof ProbeGoldenSceneSchema>;

export const ProbeGoldenSchema = z.object({
  version: z.literal(1),
  title: z.string(),
  video: z.object({ width: z.number(), height: z.number() }),
  scenes: z.array(ProbeGoldenSceneSchema),
});
export type ProbeGolden = z.infer<typeof ProbeGoldenSchema>;

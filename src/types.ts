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

const BaseAction = { comment: z.string().optional() };

/**
 * Scroll easing presets. All are eased wheel scrolls; they differ in feel:
 * smooth = balanced ease-in-out (default), snappy = quick with a soft landing,
 * glide = long cinematic drift, linear = constant rate.
 */
export const EasingPresetSchema = z.enum(["smooth", "snappy", "glide", "linear"]);
export type EasingPreset = z.infer<typeof EasingPresetSchema>;

export const ActionSchema = z.discriminatedUnion("op", [
  z.object({ ...BaseAction, op: z.literal("goto"), url: z.string() }),
  z.object({
    ...BaseAction,
    op: z.literal("click"),
    target: TargetSchema,
  }),
  z.object({
    ...BaseAction,
    op: z.literal("type"),
    target: TargetSchema,
    text: z.string(),
    /** Per-keystroke jitter for a human cadence. Default true. */
    humanize: z.boolean().optional(),
  }),
  z.object({ ...BaseAction, op: z.literal("press"), key: z.string() }),
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
  }),
  z.object({
    ...BaseAction,
    op: z.literal("scrollBy"),
    /** CSS pixels to scroll; positive = down. */
    dy: z.number(),
    /** Scroll feel preset. Default "smooth". */
    easing: EasingPresetSchema.optional(),
    /** Override the preset's duration, ms. */
    durationMs: z.number().optional(),
  }),
  z.object({
    ...BaseAction,
    op: z.literal("waitFor"),
    target: TargetSchema,
    timeoutMs: z.number().optional(),
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

export const SceneSchema = z.object({
  id: z.string(),
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
  voice: VoicePlanSchema.optional(),
  music: MusicCueSchema.optional(),
  /** Set false to suppress auto-zoom for this scene's clicks/typing. */
  zoom: z.boolean().optional(),
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
export const OutputSchema = z
  .object({
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

export const TimelineSceneSchema = z.object({
  id: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  idleSpans: z.array(IdleSpanSchema).default([]),
  focusEvents: z.array(FocusEventSchema).default([]),
  stillEvents: z.array(StillEventSchema).default([]),
  cursorSamples: z.array(CursorSampleSchema).default([]),
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
   * Per-scene inputs + reusable scene-relative word timings (offline path only).
   * Enables per-scene reuse: only a scene whose narration/duration changed is
   * re-derived; the rest keep their stored words.
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

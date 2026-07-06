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
]);
export type Action = z.infer<typeof ActionSchema>;

// ---------------------------------------------------------------------------
// Voice + music plans
// ---------------------------------------------------------------------------

export const VoicePlanSchema = z.object({
  /** OpenAI voice id (alloy, ash, ballad, cedar, coral, echo, fable, marin, nova, onyx, sage, shimmer, verse). */
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
});
export type Card = z.infer<typeof CardSchema>;

export const StoryboardSchema = z.object({
  title: z.string(),
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

export const TimelineSceneSchema = z.object({
  id: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  idleSpans: z.array(IdleSpanSchema).default([]),
  focusEvents: z.array(FocusEventSchema).default([]),
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

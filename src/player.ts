import type { Page, Locator, Frame } from "playwright";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  Storyboard,
  Scene,
  Action,
  Target,
  Timeline,
  TimelineScene,
  IdleSpan,
  FocusEvent,
  StillEvent,
  CursorSample,
  EasingPreset,
  ProbeActionOutcome,
  ProbeGoldenScene,
} from "./types.js";
import {
  easeInOutCubic,
  easeOutCubic,
  easeInOutSine,
  sleep,
  log,
  ensureDir,
  CanceledError,
} from "./util.js";

/** Semantic targets the player resolves without a raw selector. */
const NAMED_SELECTORS: Record<string, string> = {
  // ChatGPT prompt box — the contenteditable with id="prompt-textarea".
  // NOTE: keep this a *single, visible* match. The old broad union added
  // `form textarea`, which matched a HIDDEN fallback textarea that sorted
  // first in the DOM; `.first()` then picked the hidden node and every click
  // timed out. `#prompt-textarea` is unique and visible (confirmed live).
  composer: "#prompt-textarea",
};

interface MouseState {
  x: number;
  y: number;
}

/**
 * Scroll easing presets — duration + curve for the eased wheel scroll. The old
 * behavior was 8 chunky wheel steps; these run ~60Hz micro-deltas along an
 * easing curve so scrolls read as intentional camera moves.
 */
const SCROLL_PRESETS: Record<EasingPreset, { ms: number; fn: (t: number) => number }> = {
  smooth: { ms: 850, fn: easeInOutCubic },
  snappy: { ms: 450, fn: easeOutCubic },
  glide: { ms: 1500, fn: easeInOutSine },
  linear: { ms: 700, fn: (t) => t },
};

export interface PlayerOptions {
  /** Epoch ms captured at record start; timeline offsets are relative to it. */
  t0: number;
  video: { width: number; height: number };
  /** Where to write failure diagnostics (screenshot + frame dump). */
  logsDir?: string;
  /**
   * Called after each scene finishes so the recorder can salvage a partial
   * timeline if a later scene fails (a late failure otherwise discards minutes
   * of good recording).
   */
  onSceneComplete?: (scene: TimelineScene, index: number, total: number) => void;
  /** Called when a scene's first action is about to run (job progress). */
  onSceneStart?: (sceneId: string, index: number, total: number) => void;
  /**
   * Best-effort cancellation, checked before every action. Aborting mid-scene
   * throws CanceledError, which rides the recorder's salvage path (partial
   * timeline + kept footage).
   */
  signal?: AbortSignal;
  /**
   * Golden-probe capture. When present, the player records a normalized,
   * timing-free outcome per action (op, resolved target, ok, found, goto final
   * URL) into this array — and does NOT abort the run on an action failure
   * (records ok:false and continues), so a broken selector yields a complete
   * diffable projection rather than a truncated one. Absent → unchanged behavior
   * (a failing action throws via failAction). See src/golden.ts.
   */
  probe?: ProbeGoldenScene[];
  /**
   * Log the cursor's glide path into each scene's `cursorSamples` (for the
   * compose-time cursor overlay). On only when the storyboard opts into `cursor`
   * control; off by default so a plain take's timeline.json is unchanged.
   */
  captureCursorPath?: boolean;
}

/** Per-scene mutable capture state threaded through actions. */
interface SceneCapture {
  idleSpans: IdleSpan[];
  focusEvents: FocusEvent[];
  stillEvents: StillEvent[];
  cursorSamples: CursorSample[];
}

/** Records a cursor position into the current scene (compose-cursor mode only). */
type CursorSampler = (x: number, y: number) => void;

export async function runStoryboard(
  page: Page,
  storyboard: Storyboard,
  opts: PlayerOptions
): Promise<Timeline> {
  const mouse: MouseState = {
    x: Math.round(opts.video.width / 2),
    y: Math.round(opts.video.height / 2),
  };
  // Establish the cursor position so the overlay appears from the start.
  await page.mouse.move(mouse.x, mouse.y);

  const now = () => Date.now() - opts.t0;
  const scenes: TimelineScene[] = [];

  const total = storyboard.scenes.length;
  for (let si = 0; si < total; si++) {
    const scene = storyboard.scenes[si];
    const startMs = now();
    const capture: SceneCapture = {
      idleSpans: [],
      focusEvents: [],
      stillEvents: [],
      cursorSamples: [],
    };
    // Cursor path sampler — only records when the storyboard opts into the
    // compose-time cursor overlay, so a plain take's timeline stays unchanged.
    const sample: CursorSampler | undefined = opts.captureCursorPath
      ? (x, y) =>
          capture.cursorSamples.push({
            tMs: now(),
            x: Math.round(x),
            y: Math.round(y),
          })
      : undefined;
    log(`scene ${scene.id}: ${scene.actions.length} action(s)`);
    opts.onSceneStart?.(scene.id, si, total);
    const probeOutcomes: ProbeActionOutcome[] = [];

    for (let i = 0; i < scene.actions.length; i++) {
      if (opts.signal?.aborted)
        throw new CanceledError(`canceled during scene ${scene.id}`);
      const action = scene.actions[i];
      const outcome = opts.probe ? initProbeOutcome(storyboard, action) : null;
      try {
        await runAction(page, storyboard, action, mouse, capture, opts, sample);
        if (outcome) outcome.ok = true;
      } catch (err) {
        if (outcome) {
          // Golden probe: record the failure and keep going, so a broken
          // selector shows up as a single flipped field in the diff instead of
          // aborting the whole projection.
          outcome.ok = false;
          log(
            `  ✗ probe: ${action.op} failed — ${firstLine(err)}`
          );
        } else {
          // Name the failing scene/action, screenshot the page, and dump the
          // widget frames present — so a phantom click or a platform
          // interruption is diagnosable from the log instead of by
          // hand-extracting webm frames.
          await failAction(page, storyboard, scene, i, action, opts, err);
        }
      }
      if (outcome) {
        await enrichProbeOutcome(page, storyboard, action, outcome);
        probeOutcomes.push(outcome);
      }
    }
    if (opts.probe) opts.probe.push({ id: scene.id, actions: probeOutcomes });

    const tlScene: TimelineScene = {
      id: scene.id,
      startMs,
      endMs: now(),
      idleSpans: capture.idleSpans,
      focusEvents: capture.focusEvents,
      stillEvents: capture.stillEvents,
      cursorSamples: capture.cursorSamples,
    };
    scenes.push(tlScene);
    opts.onSceneComplete?.(tlScene, si, total);
  }

  // leadInMs is filled in by the recorder (it knows the video start).
  return { totalMs: now(), leadInMs: 0, scenes };
}

/**
 * A frame whose declared selector points at a *.web-sandbox.oaiusercontent.com
 * iframe is a ChatGPT Apps SDK widget. Those render their real markup inside a
 * NESTED `<iframe name="root">` (about:blank) within the sandbox — a single-
 * level frameLocator only reaches the empty sandbox wrapper. When the frame
 * selector opts into this (mentions oaiusercontent), we descend to the nested
 * content frame.
 */
const NESTED_WIDGET_RE = /oaiusercontent\.com/i;

/** Nested widget "root" frames (children of a ChatGPT widget sandbox). */
function widgetRootFrames(page: Page): Frame[] {
  return page.frames().filter((f) => {
    const parent = f.parentFrame();
    return !!parent && NESTED_WIDGET_RE.test(parent.url());
  });
}

/**
 * Pick the nested widget frame that actually CONTAINS `selector`, honoring
 * last/nth. ChatGPT renders two sandbox iframes per widget (one populated, one
 * an empty duplicate) and one sandbox per tool call across a conversation;
 * filtering to frames that contain the selector both skips the empty duplicate
 * and lets `last` mean "newest widget that has this element". Returns null when
 * no content frame is ready yet (callers retry).
 */
async function pickNestedFrame(
  page: Page,
  selector: string,
  target: Target
): Promise<Frame | null> {
  const matching: Frame[] = [];
  for (const f of widgetRootFrames(page)) {
    if (f.isDetached()) continue;
    const count = await f.locator(selector).count().catch(() => 0);
    if (count > 0) matching.push(f);
  }
  if (matching.length === 0) return null;
  const chosen = target.last
    ? matching[matching.length - 1]
    : target.nth != null
      ? matching[target.nth]
      : matching[0];
  return chosen ?? null;
}

async function pickNestedLocator(
  page: Page,
  selector: string,
  target: Target
): Promise<Locator | null> {
  const frame = await pickNestedFrame(page, selector, target);
  return frame ? frame.locator(selector).first() : null;
}

// ---------------------------------------------------------------------------
// Interruption handlers — ChatGPT sometimes injects its own UI between the
// storyboard and the page (an A/B "which response do you prefer?" eval screen,
// a consent wall). Unlike the scroll-to-bottom arrow it can't be scrolled away,
// so a take dies at the next waitForWidget. These best-effort handlers detect
// and try to clear known interruptions before composer typing and during the
// widget wait. They NEVER throw; if one can't self-resolve, the scene still
// fails — but with a named error + screenshot (see failAction), so the operator
// sees it was platform roulette, not a storyboard bug.
//
// Selectors here track live ChatGPT and may drift; keep them permissive
// (text/role based) and treat non-resolution as acceptable.
// ---------------------------------------------------------------------------
interface Interruption {
  name: string;
  detect: (page: Page) => Promise<boolean>;
  /** Try to clear it; return true if an action was taken. */
  resolve: (page: Page) => Promise<boolean>;
}

async function visible(loc: Locator): Promise<boolean> {
  return (
    (await loc.count().catch(() => 0)) > 0 &&
    (await loc.first().isVisible().catch(() => false))
  );
}

const INTERRUPTIONS: Interruption[] = [
  {
    name: "A/B response eval",
    detect: (page) => visible(page.getByText(/which response do you prefer/i)),
    resolve: async (page) => {
      // Prefer a neutral dismissal; only pick a candidate as a last resort so
      // the turn unblocks. (Picking a response may still land on one that
      // doesn't call the app — this is genuinely roulette.)
      for (const name of [/skip/i, /dismiss/i, /prefer this response/i]) {
        const b = page.getByRole("button", { name });
        if (await visible(b)) {
          await b.first().click({ timeout: 2000 }).catch(() => {});
          return true;
        }
      }
      return false;
    },
  },
  {
    name: "cookie/consent wall",
    detect: (page) =>
      visible(page.getByRole("button", { name: /accept all|accept cookies|i agree/i })),
    resolve: async (page) => {
      const b = page.getByRole("button", { name: /accept all|accept cookies|i agree/i });
      await b.first().click({ timeout: 2000 }).catch(() => {});
      return true;
    },
  },
];

/** Warn-once dedupe so a still-blocked interruption doesn't spam the wait loop. */
const warnedInterruptions = new Set<string>();

/**
 * Detect + best-effort clear known ChatGPT interruptions. Gated to chatgpt.com
 * so it never clicks stray "Accept" buttons on other pages. Best-effort — all
 * failures are swallowed.
 */
async function resolveInterruptions(page: Page): Promise<void> {
  if (!/chatgpt\.com|chat\.openai\.com/.test(page.url())) return;
  for (const it of INTERRUPTIONS) {
    let present = false;
    try {
      present = await it.detect(page);
    } catch {
      present = false;
    }
    if (!present) continue;
    let acted = false;
    try {
      acted = await it.resolve(page);
    } catch {
      acted = false;
    }
    if (acted) {
      log(`  ⚠ cleared ChatGPT interruption: ${it.name}`);
      warnedInterruptions.delete(it.name);
    } else if (!warnedInterruptions.has(it.name)) {
      log(`  ⚠ ChatGPT interruption present (not auto-resolvable): ${it.name}`);
      warnedInterruptions.add(it.name);
    }
  }
}

/** ChatGPT's Stop control — visible exactly while a reply is streaming. */
const STOP_BUTTON_SELECTOR =
  'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label*="Stop" i]';

/** ChatGPT's assistant message nodes — the default `waitForReply` counter. */
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';

/**
 * ChatGPT shows a Stop control while a reply streams. Wait until it's gone so
 * the next prompt isn't typed into a still-generating (send-disabled) composer —
 * which drops the Enter and interleaves the following scene's text. Safe no-op
 * if the control isn't found (returns after a short settle).
 */
async function waitComposerReady(page: Page, timeoutMs = 20000): Promise<void> {
  const stop = page.locator(STOP_BUTTON_SELECTOR);
  await sleep(400); // let a just-started generation register the Stop control
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await stop.count().catch(() => 0)) === 0) return;
    await sleep(300);
  }
}

/** How many nested widget frames currently contain `selector`. */
async function countNestedMatches(page: Page, selector: string): Promise<number> {
  let n = 0;
  for (const f of widgetRootFrames(page)) {
    if (f.isDetached()) continue;
    const c = await f.locator(selector).count().catch(() => 0);
    if (c > 0) n++;
  }
  return n;
}

async function resolveTargetLocator(
  page: Page,
  storyboard: Storyboard,
  target: Target
): Promise<Locator> {
  let selector = target.selector;
  if (target.named) {
    selector = NAMED_SELECTORS[target.named];
  }
  if (!selector) {
    throw new Error(
      `Target has neither a selector nor a known 'named' value: ${JSON.stringify(
        target
      )}`
    );
  }
  if (!target.frame) {
    // Frameless targets honor last/nth at the ELEMENT level (e.g. the newest
    // assistant message); previously they silently collapsed to .first().
    const loc = page.locator(selector);
    return target.last ? loc.last() : target.nth != null ? loc.nth(target.nth) : loc.first();
  }
  const frameSelector = storyboard.frames[target.frame];
  if (!frameSelector) {
    throw new Error(
      `Action references frame "${target.frame}" not declared in storyboard.frames`
    );
  }
  if (NESTED_WIDGET_RE.test(frameSelector)) {
    const nested = await pickNestedLocator(page, selector, target);
    if (nested) return nested;
    // No populated widget frame yet; let callers retry against this hint.
    throw new Error(`Widget content frame not ready for selector "${selector}"`);
  }
  // Normal single-level iframe. Disambiguate so multiple matches don't trip
  // Playwright strict mode; newest for multi-turn conversations.
  let frame = page.frameLocator(frameSelector);
  frame = target.last
    ? frame.last()
    : target.nth != null
      ? frame.nth(target.nth)
      : frame.first();
  return frame.locator(selector).first();
}

/**
 * Wait until `target` resolves to a visible element, re-resolving each poll so
 * a nested widget frame that appears (and fills) mid-wait is picked up. Returns
 * the elapsed wait; throws on timeout.
 */
async function waitForTargetVisible(
  page: Page,
  storyboard: Storyboard,
  target: Target,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const loc = await resolveTargetLocator(page, storyboard, target);
      const remaining = deadline - Date.now();
      await loc.waitFor({
        state: "visible",
        timeout: Math.max(400, Math.min(2500, remaining)),
      });
      return;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`waitForTargetVisible timed out for ${JSON.stringify(target)}`);
    }
    await sleep(300);
  }
}

/**
 * Wait for the model's NEW reply widget — not a stale prior one. ChatGPT keeps
 * earlier widgets in the DOM and different tools share selectors (search &
 * detail both render button[data-add-id]; every cart op renders
 * button[data-cart-act]), so a plain "is the selector present" check matches an
 * older widget instantly and the scene advances before the reply renders. We
 * instead capture the match COUNT at wait-start (after the prompt was sent) and
 * wait for it to grow — i.e. a genuinely new widget carrying the selector — then
 * confirm the newest one is visible. Falls back to a plain visible-wait for
 * non-nested (fixture) frames.
 */
async function waitForNewWidget(
  page: Page,
  storyboard: Storyboard,
  target: Target,
  opts: { timeoutMs: number; textMatches?: string }
): Promise<void> {
  const selector = target.named
    ? NAMED_SELECTORS[target.named]
    : target.selector;
  const frameSelector = target.frame ? storyboard.frames[target.frame] : undefined;
  const nested = !!frameSelector && !!selector && NESTED_WIDGET_RE.test(frameSelector);
  if (!nested || !selector) {
    await waitForTargetVisible(page, storyboard, target, opts.timeoutMs);
    return;
  }
  const re = opts.textMatches ? new RegExp(opts.textMatches, "i") : null;
  const deadline = Date.now() + opts.timeoutMs;
  const baseline = await countNestedMatches(page, selector);
  for (;;) {
    // A mid-turn A/B eval / consent wall shows text instead of a widget and
    // would otherwise silently burn the whole timeout; try to clear it.
    await resolveInterruptions(page);
    if ((await countNestedMatches(page, selector)) > baseline) {
      const frame = await pickNestedFrame(page, selector, target).catch(() => null);
      // With textMatches, the chosen NEW widget must also carry the expected
      // text — different tools share selectors (carousel and compare both have
      // button[data-add-id]), so when the model could render either, an
      // unqualified match would pass on the wrong widget type. A mismatch
      // keeps polling: the right widget may still be streaming in.
      let textOk = true;
      if (frame && re) {
        const text = await frame
          .locator("body")
          .textContent({ timeout: 800 })
          .catch(() => null);
        textOk = !!text && re.test(text);
      }
      if (frame && textOk) {
        try {
          await frame.locator(selector).first().waitFor({
            state: "visible",
            timeout: Math.max(400, Math.min(2000, deadline - Date.now())),
          });
          // The widget is up, but the model may still be streaming trailing
          // text. Wait it out here (inside the trimmed idle span) so the next
          // scene types into a ready composer.
          await waitComposerReady(page, Math.max(1000, deadline - Date.now()));
          return;
        } catch {
          /* the new frame is still filling in; keep polling */
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForWidget: no new "${selector}" widget` +
          (re ? ` with text matching ${re}` : "") +
          ` within ${opts.timeoutMs}ms (baseline ${baseline})`
      );
    }
    await sleep(350);
  }
}

/**
 * Wait for a NEW assistant reply that answers in TEXT (no widget) — the
 * main-frame twin of waitForNewWidget, for tools whose result the model
 * narrates without rendering a widget. Baseline = assistant-message count at
 * wait start; satisfied when it grows, then the generation is waited out so
 * the on-screen text is complete before the scene advances. Fallback: if the
 * reply node streamed in BEFORE the baseline sample (fast first token), a
 * Stop-button appear→disappear cycle counts as the reply — the prior turn
 * can't be the one streaming, because `type` waits out the composer first.
 */
async function waitForNewReply(
  page: Page,
  opts: { selector: string; textMatches?: string; timeoutMs: number }
): Promise<void> {
  const messages = page.locator(opts.selector);
  const stop = page.locator(STOP_BUTTON_SELECTOR);
  const re = opts.textMatches ? new RegExp(opts.textMatches, "i") : null;
  const baseline = await messages.count().catch(() => 0);
  let sawStreaming = (await stop.count().catch(() => 0)) > 0;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    await resolveInterruptions(page);
    const streamingNow = (await stop.count().catch(() => 0)) > 0;
    sawStreaming ||= streamingNow;
    const grown = (await messages.count().catch(() => 0)) > baseline;
    if (grown || (sawStreaming && !streamingNow)) {
      await waitComposerReady(page, Math.max(1000, deadline - Date.now()));
      if (re) {
        const text =
          (await messages.last().textContent({ timeout: 2000 }).catch(() => "")) ?? "";
        if (!re.test(text)) {
          throw new Error(
            `waitForReply: new assistant reply does not match ${re} ` +
              `(got ${JSON.stringify(text.replace(/\s+/g, " ").trim().slice(0, 80))})`
          );
        }
      }
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForReply: no new assistant message ("${opts.selector}") within ` +
          `${opts.timeoutMs}ms (baseline ${baseline})`
      );
    }
    await sleep(350);
  }
}

async function runAction(
  page: Page,
  storyboard: Storyboard,
  action: Action,
  mouse: MouseState,
  capture: SceneCapture,
  opts: PlayerOptions,
  sample?: CursorSampler
): Promise<void> {
  const t0 = opts.t0;
  const markFocus = (x: number, y: number, kind: string) =>
    capture.focusEvents.push({ tMs: Date.now() - t0, x, y, kind });

  switch (action.op) {
    case "goto":
      await page.goto(action.url, { waitUntil: "domcontentloaded" });
      await sleep(600);
      return;

    case "click": {
      const loc = await resolveTargetLocator(page, storyboard, action.target);
      const { cx, cy } = await humanClick(page, loc, mouse, !!action.target.frame, sample);
      markFocus(cx, cy, "click");
      return;
    }

    case "type": {
      const loc = await resolveTargetLocator(page, storyboard, action.target);
      const isComposer = action.target.named === "composer";
      // Guard multi-turn ChatGPT: clear any interruption UI (A/B eval, consent
      // wall) then never type while the prior reply is still streaming (the
      // Enter would be dropped and prompts would interleave). The wait is
      // recorded as IDLE: a still-streaming prior turn can hold the composer
      // for tens of seconds, and untrimmed that time blows the scene past its
      // narration and compose tail-trims the scene's PAYOFF instead (bit us
      // on maxfit-chatgpt-v3 s8: 38s raw vs 9s narration).
      if (isComposer) {
        const waitStart = Date.now() - t0;
        await resolveInterruptions(page);
        await waitComposerReady(page);
        const waitEnd = Date.now() - t0;
        // Below ~1s there's nothing worth trimming (waitComposerReady's settle
        // alone is 400ms) and each span costs a keep-interval split in compose.
        if (waitEnd - waitStart > 1000) {
          capture.idleSpans.push({
            startMs: waitStart,
            endMs: waitEnd,
            label: "reply streaming",
          });
          log(`  idle "reply streaming": ${waitEnd - waitStart}ms (pre-type composer wait)`);
        }
      }
      const { cx, cy } = await humanClick(page, loc, mouse, !!action.target.frame, sample);
      markFocus(cx, cy, "type");
      if (isComposer) {
        // Clear any residual text so a new prompt can't concatenate onto it.
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.press("Backspace");
      }
      await humanType(page, loc, action.text, action.humanize !== false);
      return;
    }

    case "press":
      await page.keyboard.press(action.key);
      await sleep(200);
      return;

    case "hover": {
      const loc = await resolveTargetLocator(page, storyboard, action.target);
      const box = await boxOf(page, loc);
      await moveMouseTo(page, mouse, box.cx, box.cy, sample);
      await sleep(300);
      return;
    }

    case "focus": {
      // A camera note, not an interaction: aim the auto-zoom at this element.
      const loc = await resolveTargetLocator(page, storyboard, action.target);
      const box = await boxOf(page, loc);
      capture.focusEvents.push({
        tMs: Date.now() - t0,
        x: box.cx,
        y: box.cy,
        kind: "focus",
        scale: action.scale,
        holdMs: action.holdMs,
      });
      await sleep(150);
      return;
    }

    case "still": {
      // Screenshot mode: a pure timeline marker — no screenshot is taken now.
      // Let the frame settle first, then record the marker at the settled
      // moment so compose-time extraction lands on a clean frame (not mid-
      // transition). The PNG is pulled from the CLEAN take by `aidemo stills`.
      await sleep(120);
      capture.stillEvents.push({ tMs: Date.now() - t0, name: action.name });
      log(`  still "${action.name}" @ ${Date.now() - t0}ms`);
      return;
    }

    case "scrollTo": {
      const loc = await resolveTargetLocator(page, storyboard, action.target);
      // Top-page targets get the cinematic eased scroll; targets inside a
      // frame keep the reliable scrollIntoViewIfNeeded (wheel deltas would go
      // to whatever scroller is under the cursor, not necessarily the frame).
      if (!action.target.frame) {
        const box = await loc.boundingBox().catch(() => null);
        if (box) {
          const dy = box.y + box.height / 2 - opts.video.height * 0.45;
          if (Math.abs(dy) > 30) await easedWheel(page, dy, action);
        }
      }
      await loc.scrollIntoViewIfNeeded();
      await sleep(300);
      return;
    }

    case "scrollBy": {
      await easedWheel(page, action.dy, action);
      return;
    }

    case "waitFor": {
      await waitForTargetVisible(
        page,
        storyboard,
        action.target,
        action.timeoutMs ?? 15000
      );
      return;
    }

    case "waitForWidget": {
      const start = Date.now() - t0;
      await waitForNewWidget(page, storyboard, action.target, {
        timeoutMs: action.timeoutMs ?? 30000,
        textMatches: action.textMatches,
      });
      const end = Date.now() - t0;
      capture.idleSpans.push({ startMs: start, endMs: end, label: action.label });
      log(`  idle "${action.label}": ${end - start}ms`);
      return;
    }

    case "waitForReply": {
      const start = Date.now() - t0;
      await waitForNewReply(page, {
        selector: action.selector ?? ASSISTANT_MESSAGE_SELECTOR,
        textMatches: action.textMatches,
        timeoutMs: action.timeoutMs ?? 30000,
      });
      const end = Date.now() - t0;
      capture.idleSpans.push({ startMs: start, endMs: end, label: action.label });
      log(`  idle "${action.label}": ${end - start}ms`);
      return;
    }

    case "waitForChange": {
      const start = Date.now() - t0;
      await waitForChange(page, storyboard, action.target, {
        textMatches: action.textMatches,
        timeoutMs: action.timeoutMs ?? 15000,
      });
      if (action.idle) {
        const end = Date.now() - t0;
        capture.idleSpans.push({ startMs: start, endMs: end, label: action.label });
        log(`  idle "${action.label}": ${end - start}ms`);
      }
      return;
    }

    case "pause":
      await sleep(action.ms);
      return;
  }
}

// ---------------------------------------------------------------------------
// Golden-probe outcome capture — a normalized, timing-free projection of each
// action's result. Deterministic across runs by construction: op + resolved
// selector (from the storyboard, not the clock) + ok + a page-side element-found
// check + goto's final URL. See src/golden.ts for how these are diffed.
// ---------------------------------------------------------------------------

/** A stable, resolved description of a target: named→selector, frame-prefixed. */
function describeProbeTarget(storyboard: Storyboard, target: Target): string {
  const selector = target.named
    ? NAMED_SELECTORS[target.named] ?? `named:${target.named}`
    : target.selector ?? "<no-selector>";
  const prefix = target.frame
    ? `${storyboard.frames[target.frame] ?? target.frame} >> `
    : "";
  const suffix = target.last
    ? " [last]"
    : target.nth != null
      ? ` [nth=${target.nth}]`
      : "";
  return `${prefix}${selector}${suffix}`;
}

/** Seed an outcome with the action's stable, storyboard-derived fields. */
function initProbeOutcome(
  storyboard: Storyboard,
  action: Action
): ProbeActionOutcome {
  const o: ProbeActionOutcome = { op: action.op, ok: false };
  switch (action.op) {
    case "goto":
      o.target = action.url;
      break;
    case "press":
      o.key = action.key;
      break;
    case "pause":
      o.ms = action.ms;
      break;
    case "scrollBy":
      o.dy = action.dy;
      break;
    case "waitForReply":
      o.target = action.selector ?? ASSISTANT_MESSAGE_SELECTOR;
      o.label = action.label;
      break;
    case "waitForWidget":
    case "waitForChange":
      o.target = describeProbeTarget(storyboard, action.target);
      o.label = action.label;
      break;
    case "click":
    case "type":
    case "hover":
    case "scrollTo":
    case "waitFor":
    case "focus":
      o.target = describeProbeTarget(storyboard, action.target);
      break;
  }
  return o;
}

/** Add the post-run stable signals: goto's final URL, target element-found. */
async function enrichProbeOutcome(
  page: Page,
  storyboard: Storyboard,
  action: Action,
  o: ProbeActionOutcome
): Promise<void> {
  if (action.op === "goto") {
    o.finalUrl = page.url();
    return;
  }
  if (action.op === "waitForReply") {
    o.found = await selectorResolves(
      page,
      action.selector ?? ASSISTANT_MESSAGE_SELECTOR
    );
    return;
  }
  if ("target" in action) {
    o.found = await targetResolves(page, storyboard, action.target);
  }
}

/** Does `target` currently resolve to ≥1 element? Never throws (→ false). */
async function targetResolves(
  page: Page,
  storyboard: Storyboard,
  target: Target
): Promise<boolean> {
  try {
    const loc = await resolveTargetLocator(page, storyboard, target);
    return (await loc.count().catch(() => 0)) > 0;
  } catch {
    return false;
  }
}

async function selectorResolves(page: Page, selector: string): Promise<boolean> {
  return (await page.locator(selector).count().catch(() => 0)) > 0;
}

/** First line of an error message — a compact reason for the probe log. */
function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0];
}

/**
 * A stable-ish signature of `target`: whether it currently resolves, and its
 * normalized text. Missing/unresolvable targets read as absent (empty) — so a
 * mutation that first *introduces* the selector (e.g. the basket bar rendering
 * into an empty [data-cart-bar]) also counts as a change.
 */
async function signatureOf(
  page: Page,
  storyboard: Storyboard,
  target: Target
): Promise<{ present: boolean; text: string }> {
  try {
    const loc = await resolveTargetLocator(page, storyboard, target);
    const txt = await loc.textContent({ timeout: 800 }).catch(() => null);
    return { present: true, text: (txt ?? "").replace(/\s+/g, " ").trim() };
  } catch {
    return { present: false, text: "" };
  }
}

/**
 * Wait until `target` mutates in place. Baseline = its signature now; satisfied
 * when the signature differs (presence or text). With `textMatches`, additionally
 * require the NEW text to match — so it waits for a change *to* the desired state,
 * never firing on a stale widget that already matches.
 */
async function waitForChange(
  page: Page,
  storyboard: Storyboard,
  target: Target,
  opts: { textMatches?: string; timeoutMs: number }
): Promise<void> {
  const re = opts.textMatches ? new RegExp(opts.textMatches, "i") : null;
  const base = await signatureOf(page, storyboard, target);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const cur = await signatureOf(page, storyboard, target);
    const changed = cur.present !== base.present || cur.text !== base.text;
    if (changed && (!re || re.test(cur.text))) {
      await sleep(250); // let the re-render settle before the next action
      return;
    }
    if (Date.now() >= deadline) {
      const sel = target.named ? NAMED_SELECTORS[target.named] : target.selector;
      throw new Error(
        `waitForChange: "${sel}" did not change` +
          (re ? ` to match ${re}` : "") +
          ` within ${opts.timeoutMs}ms (baseline text ${JSON.stringify(
            base.text.slice(0, 40)
          )})`
      );
    }
    await sleep(250);
  }
}

// ---------------------------------------------------------------------------
// Failure diagnostics — on any action error, name the scene/action, screenshot
// the page, and dump the widget frames present + selector match counts. Turns a
// silent phantom-click failure into something diagnosable from the log.
// ---------------------------------------------------------------------------

function truncateUrl(url: string, n = 90): string {
  return url.length > n ? url.slice(0, n) + "…" : url;
}

/** Never returns — enriches the error with scene/action context + diagnostics. */
async function failAction(
  page: Page,
  storyboard: Storyboard,
  scene: Scene,
  index: number,
  action: Action,
  opts: PlayerOptions,
  err: unknown
): Promise<never> {
  const prefix = `scene ${scene.id}, action #${index + 1} (${action.op})`;
  const base = err instanceof Error ? err.message : String(err);
  let diag = "";
  if (opts.logsDir) {
    diag = await dumpDiagnostics(page, storyboard, scene.id, index, action, opts.logsDir).catch(
      () => ""
    );
  }
  throw new Error(`${prefix}: ${base}${diag ? `\n${diag}` : ""}`);
}

async function dumpDiagnostics(
  page: Page,
  storyboard: Storyboard,
  sceneId: string,
  index: number,
  action: Action,
  logsDir: string
): Promise<string> {
  await ensureDir(logsDir);
  const stem = join(logsDir, `fail-${sceneId}-${index + 1}`);
  const lines: string[] = [];

  await page.screenshot({ path: `${stem}.png`, timeout: 5000 }).catch(() => {});
  lines.push(`  screenshot → ${stem}.png`);

  // Selector diagnostics for targeted actions: how many widget frames (and the
  // main frame) currently match the selector we were after.
  const target = "target" in action ? (action.target as Target) : undefined;
  const selector = target?.named ? NAMED_SELECTORS[target.named] : target?.selector;
  const roots = widgetRootFrames(page);
  lines.push(`  widget frames present: ${roots.length}`);
  const frameCounts: Array<{ url: string; matches: number }> = [];
  if (selector) {
    for (const f of roots) {
      const c = await f.locator(selector).count().catch(() => -1);
      frameCounts.push({ url: f.url(), matches: c });
      lines.push(`    widget ${truncateUrl(f.url())}: ${c} match(es)`);
    }
    const mainC = await page.locator(selector).count().catch(() => -1);
    lines.push(`    main frame: ${mainC} match(es) for "${selector}"`);
  }

  const detail = {
    sceneId,
    actionIndex: index + 1,
    action,
    selector: selector ?? null,
    url: page.url(),
    widgetFrames: frameCounts,
    allFrames: page.frames().map((f) => truncateUrl(f.url())),
  };
  await fs.writeFile(`${stem}.json`, JSON.stringify(detail, null, 2)).catch(() => {});
  lines.push(`  detail → ${stem}.json`);
  return lines.join("\n");
}

/**
 * Eased wheel scroll: many small deltas along an easing curve (~60Hz), instead
 * of a handful of chunky steps. Fractional remainders are carried so the total
 * lands exactly on `dy`.
 */
async function easedWheel(
  page: Page,
  dy: number,
  opts: { easing?: EasingPreset; durationMs?: number }
): Promise<void> {
  const preset = SCROLL_PRESETS[opts.easing ?? "smooth"];
  const durationMs = Math.max(80, opts.durationMs ?? preset.ms);
  const tickMs = 16;
  const steps = Math.max(2, Math.round(durationMs / tickMs));
  let emitted = 0;
  for (let i = 1; i <= steps; i++) {
    const target = dy * preset.fn(i / steps);
    const delta = target - emitted;
    await page.mouse.wheel(0, delta);
    emitted = target;
    await sleep(tickMs);
  }
  await sleep(250);
}

// ---------------------------------------------------------------------------
// Human-like motion helpers
// ---------------------------------------------------------------------------

/**
 * Center of `loc` in MAIN-viewport CSS px, guaranteed to be inside the
 * viewport's comfortable band. scrollIntoViewIfNeeded alone is NOT enough for
 * ChatGPT widget targets: the sandbox iframe is out-of-process, and a scroll
 * initiated inside an OOPIF cannot scroll the embedding page — the element
 * stays off-screen and a coordinate click lands on nothing (probe recording
 * 2026-07-06: a below-the-fold click-Add never fired). When the measured
 * center is outside the band, nudge the main scroller with an eased wheel
 * (dispatched at the current mouse position, over the conversation column)
 * and re-measure. The bottom margin also clears ChatGPT's sticky composer
 * footer, which would otherwise swallow clicks on "visible" elements under it.
 */
async function boxOf(page: Page, loc: Locator): Promise<{ cx: number; cy: number }> {
  // Short timeout: with the default 30s action timeout, an element Playwright
  // deems "unstable" (e.g. a still-animating widget card) silently stalls the
  // recording for half a minute — the catch below hides the failure and the
  // wheel loop makes the element reachable anyway (live 2026-07-06: a stalled
  // focus beat inflated one scene's active video by 31s).
  await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  let box = await loc.boundingBox();
  // External capture runs un-emulated (viewport: null → viewportSize() is
  // null); fall back to the real window content size, which the recorder has
  // sized to the storyboard viewport.
  const vp =
    page.viewportSize() ??
    (await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    })));
  for (let i = 0; i < 3 && box && vp; i++) {
    const cy = box.y + box.height / 2;
    if (cy >= 80 && cy <= vp.height - 120) break;
    await easedWheel(page, cy - vp.height * 0.55, { durationMs: 500 });
    box = await loc.boundingBox();
  }
  if (!box) throw new Error("Element has no bounding box (not visible?)");
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

/** Eased cursor glide via many small mouse.move steps. */
async function moveMouseTo(
  page: Page,
  mouse: MouseState,
  targetX: number,
  targetY: number,
  sample?: CursorSampler
): Promise<void> {
  const startX = mouse.x;
  const startY = mouse.y;
  const dist = Math.hypot(targetX - startX, targetY - startY);
  const steps = Math.max(12, Math.min(40, Math.round(dist / 12)));
  for (let i = 1; i <= steps; i++) {
    const t = easeInOutCubic(i / steps);
    const x = startX + (targetX - startX) * t;
    const y = startY + (targetY - startY) * t;
    await page.mouse.move(x, y);
    sample?.(x, y);
    await sleep(8);
  }
  mouse.x = targetX;
  mouse.y = targetY;
}

/**
 * True when something OTHER than the target would receive a click at (x, y).
 * Evaluated in the MAIN frame: for widget-frame targets the top-level hit must
 * be an <iframe> (the sandbox); anything else is an overlay that would swallow
 * a raw coordinate click. Seen live 2026-07-06: ChatGPT's floating
 * scroll-to-bottom arrow hovered exactly over the cart's Checkout button and
 * ate the click. Playwright's locator.click() hit-tests this itself, but we
 * click via page.mouse for the cinematic cursor, so we must check ourselves.
 */
async function clickObstructed(
  page: Page,
  loc: Locator,
  inFrame: boolean,
  x: number,
  y: number
): Promise<boolean> {
  try {
    if (inFrame) {
      const tag = await page.evaluate(
        ([px, py]) => document.elementFromPoint(px, py)?.tagName ?? "",
        [x, y] as [number, number]
      );
      return tag.toLowerCase() !== "iframe";
    }
    return await loc.evaluate(
      (el, [px, py]) => {
        const hit = document.elementFromPoint(px, py);
        return !(hit && (hit === el || el.contains(hit) || hit.contains(el)));
      },
      [x, y] as [number, number]
    );
  } catch {
    return false; // never block the click on a failed probe
  }
}

async function humanClick(
  page: Page,
  loc: Locator,
  mouse: MouseState,
  inFrame: boolean,
  sample?: CursorSampler
): Promise<{ cx: number; cy: number }> {
  let { cx, cy } = await boxOf(page, loc);
  // Dodge floating overlays: ChatGPT's scroll-to-bottom arrow only shows when
  // the conversation isn't at the bottom, so wheeling further down dismisses
  // it; re-measure (boxOf keeps the target in the viewport band) and re-test.
  for (let i = 0; i < 3; i++) {
    if (!(await clickObstructed(page, loc, inFrame, cx, cy))) break;
    if (i === 2) {
      log(`  ! click point still obstructed after scrolling; clicking anyway`);
      break;
    }
    await easedWheel(page, 240, { durationMs: 350 });
    ({ cx, cy } = await boxOf(page, loc));
  }
  await moveMouseTo(page, mouse, cx, cy, sample);
  await sleep(120);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await sleep(150);
  return { cx, cy };
}

async function humanType(
  page: Page,
  loc: Locator,
  text: string,
  humanize: boolean
): Promise<void> {
  await loc.focus().catch(() => {});
  if (!humanize) {
    await loc.pressSequentially(text, { delay: 25 });
    return;
  }
  for (const ch of text) {
    await page.keyboard.type(ch);
    // Jittered cadence; brief extra pause after spaces/punctuation.
    const base = 45 + Math.random() * 55;
    const extra = /[\s.,!?]/.test(ch) ? 60 : 0;
    await sleep(base + extra);
  }
}

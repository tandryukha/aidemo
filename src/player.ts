import type { Page, Locator, Frame, Request, Response } from "playwright";
import { scanInteractive, rankCandidates, type DriftCandidate } from "./inspect.js";
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
  WaitState,
  ProbeActionOutcome,
  ProbeGoldenScene,
  TimelineAction,
  AttentionEvent,
  KeyEvent,
  RedactSpan,
  Redact,
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
  actions: TimelineAction[];
  attentionEvents: AttentionEvent[];
  keyEvents: KeyEvent[];
  redactSpans: RedactSpan[];
  anchorEvents: Array<{ name: string; tMs: number; action: number }>;
}

/** Record-time dwell for an attention beat (the hold itself is compose-time). */
const ATTENTION_DWELL_MAX_MS = 800;
const ATTENTION_HOLD_DEFAULT_MS = 1600;
const CALLOUT_HOLD_DEFAULT_MS = 2000;
/** Max matches per redact selector measured after each action. */
const REDACT_MAX_MATCHES = 8;

/** Pretty keystroke label for the chip: "Meta+K" → "⌘ K", "Enter" → "Enter". */
export function prettyKeys(key: string): string {
  const map: Record<string, string> = {
    meta: "⌘",
    cmd: "⌘",
    command: "⌘",
    control: "Ctrl",
    ctrl: "Ctrl",
    shift: "⇧",
    alt: "⌥",
    option: "⌥",
    enter: "Enter",
    return: "Enter",
    escape: "Esc",
    backspace: "⌫",
    delete: "Del",
    tab: "Tab",
    space: "Space",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    pageup: "PgUp",
    pagedown: "PgDn",
  };
  return key
    .split("+")
    .map((k) => map[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k))
    .join(" ");
}

/** Ops `retry` applies to: interactions whose failure is usually transient. */
const RETRYABLE_OPS = new Set([
  "click",
  "type",
  "hover",
  "scrollTo",
  "focus",
  "moveTo",
  "assert",
  "highlight",
  "spotlight",
  "callout",
]);
const RETRY_GAP_MS = 400;

/** After `goto`'s domcontentloaded: how long we're willing to wait for quiet. */
const GOTO_QUIET_CAP_MS = 3400;

/** Records a cursor position into the current scene (compose-cursor mode only). */
type CursorSampler = (x: number, y: number) => void;

/** A failed network exchange seen during the take (issue #44). */
export interface FailedRequest {
  /** Timeline offset (ms since t0) when the response/failure arrived. */
  tMs: number;
  method: string;
  url: string;
  /** HTTP status, or null when the request never got a response. */
  status: number | null;
  /** Playwright's failure text for a request that never got a response. */
  error?: string;
  resourceType: string;
  /** First bytes of an xhr/fetch error body — often the actual reason. */
  body?: string;
}

const NET_WATCH_CAP = 300;
const NET_BODY_MAX = 300;

/**
 * Passive watch for HTTP ≥400 responses and failed requests across the page
 * (all frames). The engine has no other visibility into app-side writes: a
 * backend 500 on a check-in click looks exactly like a missed click in the
 * screenshot (issue #44), so a failing action's window is dumped into
 * logs/fail-*.json. Ring-buffered; never throws.
 */
class NetworkWatch {
  private entries: FailedRequest[] = [];
  private readonly onResponse: (res: Response) => void;
  private readonly onFailed: (req: Request) => void;

  constructor(
    private readonly page: Page,
    private readonly t0: number
  ) {
    this.onResponse = (res: Response) => {
      if (res.status() < 400) return;
      const req = res.request();
      const entry: FailedRequest = {
        tMs: Date.now() - t0,
        method: req.method(),
        url: truncateUrl(res.url(), 200),
        status: res.status(),
        resourceType: req.resourceType(),
      };
      this.push(entry);
      if (/^(xhr|fetch)$/.test(entry.resourceType)) {
        res
          .text()
          .then((b) => {
            const snippet = b.replace(/\s+/g, " ").trim().slice(0, NET_BODY_MAX);
            if (snippet) entry.body = snippet;
          })
          .catch(() => {});
      }
    };
    this.onFailed = (req: Request) => {
      const err = req.failure()?.errorText ?? "failed";
      // Navigations cancel in-flight requests; that's not an app failure.
      if (/ERR_ABORTED/.test(err)) return;
      this.push({
        tMs: Date.now() - t0,
        method: req.method(),
        url: truncateUrl(req.url(), 200),
        status: null,
        error: err,
        resourceType: req.resourceType(),
      });
    };
  }

  private push(e: FailedRequest): void {
    this.entries.push(e);
    if (this.entries.length > NET_WATCH_CAP) this.entries.shift();
  }

  start(): void {
    this.page.on("response", this.onResponse);
    this.page.on("requestfailed", this.onFailed);
  }

  stop(): void {
    this.page.off("response", this.onResponse);
    this.page.off("requestfailed", this.onFailed);
  }

  /** Failures that arrived at or after `tMs` (a failing action's window). */
  since(tMs: number): FailedRequest[] {
    return this.entries.filter((e) => e.tMs >= tMs);
  }
}

/** One-line-per-entry summary for the log (≤ `max` lines). */
function describeFailedRequests(list: FailedRequest[], max = 5): string[] {
  const lines = list
    .slice(-max)
    .map(
      (e) =>
        `    ${e.status ?? "ERR"} ${e.method} ${e.url}` +
        (e.error ? ` — ${e.error}` : "") +
        (e.body ? ` — ${JSON.stringify(e.body.slice(0, 120))}` : "")
    );
  if (list.length > max) lines.unshift(`    … ${list.length - max} earlier`);
  return lines;
}

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
  const net = new NetworkWatch(page, opts.t0);
  net.start();
  let prevActionStartMs = 0;

  try {
  const total = storyboard.scenes.length;
  for (let si = 0; si < total; si++) {
    const scene = storyboard.scenes[si];
    const startMs = now();
    const capture: SceneCapture = {
      idleSpans: [],
      focusEvents: [],
      stillEvents: [],
      cursorSamples: [],
      actions: [],
      attentionEvents: [],
      keyEvents: [],
      redactSpans: [],
      anchorEvents: [],
    };
    // Per-scene `hide` (top-level hides are injected by the recorder's init
    // script so they survive navigations); applied now, removed at scene end.
    if (scene.hide?.length) await setSceneHide(page, scene.hide);
    const redactList: Redact[] = [...(storyboard.redact ?? []), ...(scene.redact ?? [])];
    const redactOpen = new Map<string, RedactSpan>();
    const measureRedact = async (): Promise<void> => {
      if (!redactList.length) return;
      await measureRedactions(page, storyboard, redactList, redactOpen, capture, now);
    };
    await measureRedact();
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
      // Failed-request window for diagnostics: from the PREVIOUS action's
      // start — the failing action is usually the wait after the click whose
      // XHR actually failed (issue #44).
      const netWindowMs = prevActionStartMs;
      prevActionStartMs = now();
      const rec: TimelineAction = {
        index: i,
        op: action.op,
        startMs: now(),
        endMs: 0,
        ok: false,
      };
      const recTarget = describeActionTarget(storyboard, action);
      if (recTarget) rec.target = recTarget;
      const recWarnings: string[] = [];
      try {
        if (await optionalTargetAbsent(page, storyboard, action)) {
          log(`  ⚠ optional ${action.op} skipped — target not present`);
          rec.skipped = true;
          recWarnings.push("optional: target not present");
        } else {
          const retries = await runActionWithRetry(
            page,
            storyboard,
            action,
            mouse,
            capture,
            opts,
            sample
          );
          if (retries > 0) {
            rec.retries = retries;
            recWarnings.push(`succeeded after ${retries} retr${retries === 1 ? "y" : "ies"}`);
          }
        }
        if (outcome) outcome.ok = true;
        rec.ok = true;
      } catch (err) {
        if (action.optional) {
          // Best-effort by authoring contract: log and continue. Counts as ok
          // for the golden projection too (see ProbeActionOutcomeSchema) —
          // an optional action's outcome varies by environment state, which
          // is the point of marking it optional.
          if (outcome) outcome.ok = true;
          rec.ok = true;
          rec.skipped = true;
          recWarnings.push(`optional: ${firstLine(err)}`);
          log(`  ⚠ optional ${action.op} skipped — ${firstLine(err)}`);
        } else if (outcome) {
          // Golden probe: record the failure and keep going, so a broken
          // selector shows up as a single flipped field in the diff instead of
          // aborting the whole projection.
          outcome.ok = false;
          recWarnings.push(firstLine(err));
          log(
            `  ✗ probe: ${action.op} failed — ${firstLine(err)}`
          );
          const failed = net.since(netWindowMs);
          if (failed.length) {
            log(`    ${failed.length} failed request(s) since the previous action:`);
            for (const l of describeFailedRequests(failed)) log(l);
          }
        } else {
          // Name the failing scene/action, screenshot the page, and dump the
          // widget frames present — so a phantom click or a platform
          // interruption is diagnosable from the log instead of by
          // hand-extracting webm frames.
          rec.endMs = now();
          recWarnings.push(firstLine(err));
          rec.warnings = recWarnings;
          capture.actions.push(rec);
          await failAction(page, storyboard, scene, i, action, opts, err, {
            failedRequests: net.since(netWindowMs),
          });
        }
      }
      rec.endMs = now();
      const failedInWindow = net.since(rec.startMs);
      if (failedInWindow.length) {
        recWarnings.push(
          `${failedInWindow.length} failed request(s): ` +
            failedInWindow
              .slice(-3)
              .map((e) => `${e.status ?? "ERR"} ${e.method} ${e.url}`)
              .join("; ")
        );
      }
      if (recWarnings.length) rec.warnings = recWarnings;
      capture.actions.push(rec);
      if (action.anchor && !rec.skipped) {
        // The beat = the action's focus moment when it produced one (a click
        // fires its focus event right after the press), else the action start.
        const focusAt = capture.focusEvents.length
          ? capture.focusEvents[capture.focusEvents.length - 1].tMs
          : -1;
        const tMs = focusAt >= rec.startMs && focusAt <= rec.endMs ? focusAt : rec.startMs;
        capture.anchorEvents.push({ name: action.anchor, tMs, action: i });
      }
      await measureRedact();
      if (outcome) {
        // Optional actions skip the found-enrichment: whether their target
        // resolves is environment-dependent, and the golden projection must
        // stay deterministic across runs.
        if (!action.optional) {
          await enrichProbeOutcome(page, storyboard, action, outcome);
        }
        probeOutcomes.push(outcome);
      }
    }
    if (opts.probe) opts.probe.push({ id: scene.id, actions: probeOutcomes });
    // Close every open redact span at the scene boundary and drop the scene hide.
    for (const span of redactOpen.values()) {
      span.endMs = now();
      capture.redactSpans.push(span);
    }
    redactOpen.clear();
    if (scene.hide?.length) await setSceneHide(page, []);

    const tlScene: TimelineScene = {
      id: scene.id,
      startMs,
      endMs: now(),
      idleSpans: capture.idleSpans,
      focusEvents: capture.focusEvents,
      stillEvents: capture.stillEvents,
      cursorSamples: capture.cursorSamples,
      actions: capture.actions,
      attentionEvents: capture.attentionEvents,
      keyEvents: capture.keyEvents,
      redactSpans: capture.redactSpans,
      anchorEvents: capture.anchorEvents,
    };
    scenes.push(tlScene);
    opts.onSceneComplete?.(tlScene, si, total);
  }
  } finally {
    net.stop();
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

/** Human-readable target for error messages: `frame >> selector [last]`. */
function describeTarget(storyboard: Storyboard, target: Target): string {
  return describeProbeTarget(storyboard, target);
}

/**
 * Wait until `target` resolves to an element in `state` ("visible" by default,
 * or merely "attached" for zero-size mount points), re-resolving each poll so
 * a nested widget frame that appears (and fills) mid-wait is picked up.
 * Throws on timeout — naming the TOTAL budget waited, not Playwright's last
 * ~2.5 s poll chunk (which read as "Timeout 1945ms exceeded" against a 30 s
 * storyboard budget and sent people hunting a bug that didn't exist, #44).
 */
async function waitForTargetVisible(
  page: Page,
  storyboard: Storyboard,
  target: Target,
  timeoutMs: number,
  state: WaitState = "visible"
): Promise<void> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const loc = await resolveTargetLocator(page, storyboard, target);
      const remaining = deadline - Date.now();
      await loc.waitFor({
        state,
        timeout: Math.max(400, Math.min(2500, remaining)),
      });
      return;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      const waited = Date.now() - started;
      const reason = lastErr instanceof Error ? firstLine(lastErr) : String(lastErr);
      const hint = /Timeout \d+ms exceeded/.test(reason)
        ? "" // Playwright's chunk timeout — nothing more to say than the budget
        : ` (last error: ${reason})`;
      throw new Error(
        `waitFor: "${describeTarget(storyboard, target)}" not ${state} after ` +
          `${waited}ms (budget ${timeoutMs}ms)${hint}` +
          (state === "visible"
            ? ` — if the element is a zero-size mount point that fills later, use state: "attached"`
            : "")
      );
    }
    await sleep(300);
  }
}

/**
 * Wait until the scroll position has been still for `settleMs` (bounded at
 * 3 s total) — an honest "scroll finished" for smooth-scrolling pages, where a
 * fixed pause is a race. `sampleAt` reads a position signature; the default is
 * the main document's scroll offset.
 */
async function waitScrollSettled(
  page: Page,
  settleMs: number,
  loc?: Locator
): Promise<void> {
  const quiet = Math.max(50, settleMs);
  const deadline = Date.now() + Math.max(quiet, 3000);
  const sampleAt = async (): Promise<string> => {
    if (loc) {
      const box = await loc.boundingBox().catch(() => null);
      if (box) return `${Math.round(box.x)},${Math.round(box.y)}`;
    }
    return page
      .evaluate(() => `${Math.round(scrollX)},${Math.round(scrollY)}`)
      .catch(() => "");
  };
  let last = await sampleAt();
  let stillSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(50);
    const cur = await sampleAt();
    if (cur !== last) {
      last = cur;
      stillSince = Date.now();
    } else if (Date.now() - stillSince >= quiet) {
      return;
    }
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

/**
 * Ops that interact with a target element. An absent target would stall these
 * for the full Playwright action timeout (~30s of dead recording) before the
 * optional-skip even triggers, so optional interactions get a short existence
 * probe first. Wait ops are excluded — waiting is their whole job, and they
 * carry their own timeoutMs.
 */
const INTERACTION_OPS = new Set([
  "click",
  "type",
  "hover",
  "scrollTo",
  "focus",
  "moveTo",
  "highlight",
  "spotlight",
  "callout",
]);
const OPTIONAL_PROBE_MS = 3000;

/**
 * For an `optional` interaction, briefly probe whether the target is present
 * (state-dependent UI may still be rendering, so give it a beat). Returns true
 * when the action should be skipped. Non-optional actions and wait ops always
 * return false — they run normally.
 */
async function optionalTargetAbsent(
  page: Page,
  storyboard: Storyboard,
  action: Action
): Promise<boolean> {
  const target = (action as { target?: Target }).target;
  if (!action.optional || !INTERACTION_OPS.has(action.op) || !target) {
    return false;
  }
  const state = (action as { state?: WaitState }).state ?? "visible";
  try {
    await waitForTargetVisible(page, storyboard, target, OPTIONAL_PROBE_MS, state);
    return false;
  } catch {
    return true;
  }
}

/**
 * Run an action, re-attempting it `action.retry` times (retryable ops only)
 * with a beat between attempts. Returns the number of extra attempts used.
 * The last failure propagates so the normal fail/optional paths apply.
 */
async function runActionWithRetry(
  page: Page,
  storyboard: Storyboard,
  action: Action,
  mouse: MouseState,
  capture: SceneCapture,
  opts: PlayerOptions,
  sample?: CursorSampler
): Promise<number> {
  const budget = action.retry && RETRYABLE_OPS.has(action.op) ? action.retry : 0;
  for (let attempt = 0; ; attempt++) {
    try {
      await runAction(page, storyboard, action, mouse, capture, opts, sample);
      return attempt;
    } catch (err) {
      if (attempt >= budget || opts.signal?.aborted) throw err;
      log(
        `  ↻ ${action.op} failed (${firstLine(err)}) — retry ${attempt + 1}/${budget}`
      );
      await sleep(RETRY_GAP_MS);
    }
  }
}

/**
 * After a navigation's domcontentloaded: wait for the page to go quiet (no
 * network for 500 ms, fonts loaded), capped. The wait beyond the classic
 * 600 ms settle is recorded as an idle span so compose trims it — the take
 * doesn't get slower, but the first click no longer lands on a half-fetched
 * page (a skeleton screen, a still-loading nav) and gets misread as a miss.
 */
async function awaitGotoReadiness(
  page: Page,
  capture: SceneCapture,
  t0: number
): Promise<void> {
  await sleep(600);
  const start = Date.now();
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: GOTO_QUIET_CAP_MS }).catch(() => {}),
    page
      .evaluate(() => (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready)
      .catch(() => {}),
  ]);
  const waited = Date.now() - start;
  if (waited > 150) {
    capture.idleSpans.push({ startMs: start - t0, endMs: Date.now() - t0, label: "load" });
    log(`  page quiet after +${waited}ms (idle "load")`);
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
      await awaitGotoReadiness(page, capture, t0);
      return;

    case "moveTo": {
      if (!action.target && (action.x == null || action.y == null)) {
        throw new Error("moveTo needs a target or both x and y");
      }
      let x = action.x ?? mouse.x;
      let y = action.y ?? mouse.y;
      if (action.target) {
        const loc = await resolveTargetLocator(page, storyboard, action.target);
        const box = await boxOf(page, loc);
        x = box.cx;
        y = box.cy;
      }
      await moveMouseTo(page, mouse, x, y, sample);
      await sleep(150);
      return;
    }

    case "assert": {
      if (!action.target && !action.url) {
        throw new Error("assert needs a target and/or a url");
      }
      const timeoutMs = action.timeoutMs ?? 5000;
      const deadline = Date.now() + timeoutMs;
      const textRe = action.textMatches ? new RegExp(action.textMatches) : null;
      const urlRe = action.url ? new RegExp(action.url) : null;
      let why = "";
      if (action.target) {
        // Visible first (honest total-budget error if it never shows up).
        await waitForTargetVisible(page, storyboard, action.target, timeoutMs);
      }
      for (;;) {
        why = "";
        if (urlRe && !urlRe.test(page.url())) {
          why = `url ${JSON.stringify(page.url())} does not match /${action.url}/`;
        } else if (textRe && action.target) {
          const loc = await resolveTargetLocator(page, storyboard, action.target);
          const text =
            ((await loc.first().textContent({ timeout: 800 }).catch(() => null)) ?? "")
              .replace(/\s+/g, " ")
              .trim();
          if (!textRe.test(text)) {
            why =
              `text ${JSON.stringify(text.slice(0, 80))} does not match ` +
              `/${action.textMatches}/`;
          }
        }
        if (!why) return;
        if (Date.now() >= deadline) break;
        await sleep(200);
      }
      throw new Error(
        `assert failed after ${timeoutMs}ms: ${why}` +
          (action.comment ? ` — ${action.comment}` : "")
      );
    }

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
      if (action.keystrokes ?? storyboard.keystrokes) {
        capture.keyEvents.push({ tMs: Date.now() - t0, keys: prettyKeys(action.key) });
      }
      await page.keyboard.press(action.key);
      await sleep(200);
      return;

    case "highlight":
    case "spotlight":
    case "callout": {
      const loc = await resolveTargetLocator(page, storyboard, action.target);
      const rect = await rectOf(page, loc);
      const holdMs =
        action.holdMs ??
        (action.op === "callout" ? CALLOUT_HOLD_DEFAULT_MS : ATTENTION_HOLD_DEFAULT_MS);
      const ev: AttentionEvent = {
        tMs: Date.now() - t0,
        kind: action.op,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        holdMs,
      };
      if (action.style) ev.style = action.style;
      if (action.op === "callout") {
        ev.text = action.text;
        if (action.placement) ev.placement = action.placement;
      }
      if (action.op === "spotlight") {
        if (action.dimTo != null) ev.dimTo = action.dimTo;
        if (action.padding != null) ev.padding = action.padding;
      }
      capture.attentionEvents.push(ev);
      await sleep(Math.min(holdMs, ATTENTION_DWELL_MAX_MS));
      return;
    }

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
      const state = action.state ?? "visible";
      const loc = await resolveTargetLocator(page, storyboard, action.target);
      if (state === "attached") {
        // A zero-size mount point has no visibility to wait for; require it
        // to be in the DOM, then scroll by geometry alone (issue #44).
        await waitForTargetVisible(page, storyboard, action.target, 15000, "attached");
      }
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
      if (state === "attached") {
        // scrollIntoViewIfNeeded needs a visible element; a plain
        // scrollIntoView on the node works for an empty one.
        await loc
          .evaluate((el) => el.scrollIntoView({ block: "center" }))
          .catch(() => {});
      } else {
        await loc.scrollIntoViewIfNeeded();
      }
      if (action.settleMs != null) {
        await waitScrollSettled(page, action.settleMs, loc);
      } else {
        await sleep(300);
      }
      return;
    }

    case "scrollBy": {
      let dy = action.dy;
      let loc: Locator | undefined;
      if (action.target) {
        // Target-scoped scroll (issue #43): wheel OVER the element, and never
        // more than its own scroller has room for — a bottomed-out inner
        // panel otherwise chains the wheel to the page and the whole app
        // slides off-screen mid-take with nothing failing.
        loc = await resolveTargetLocator(page, storyboard, action.target);
        await waitForTargetVisible(page, storyboard, action.target, 15000, "attached");
        const box = await loc.boundingBox().catch(() => null);
        if (box) {
          const vp = page.viewportSize() ?? opts.video;
          const cx = Math.min(Math.max(box.x + box.width / 2, 2), vp.width - 2);
          const cy = Math.min(Math.max(box.y + box.height / 2, 2), vp.height - 2);
          await moveMouseTo(page, mouse, cx, cy, sample);
        }
        // NOTE: no inner named functions inside evaluate callbacks — tsx's
        // esbuild keepNames wraps them in a `__name` helper that doesn't
        // exist in the page (ReferenceError, swallowed → no clamp).
        const room = await loc
          .evaluate((el, want) => {
            let n: Element | null = el;
            while (
              n &&
              !(
                /(auto|scroll|overlay)/.test(getComputedStyle(n).overflowY) &&
                n.scrollHeight > n.clientHeight + 1
              )
            ) {
              n = n.parentElement;
            }
            const sc = n ?? document.scrollingElement ?? document.documentElement;
            return want > 0
              ? sc.scrollHeight - sc.clientHeight - sc.scrollTop
              : sc.scrollTop;
          }, dy)
          .catch((err: Error) => {
            log(`  ! scrollBy: could not measure target scroller (${firstLine(err)}); unclamped`);
            return Math.abs(dy);
          });
        if (Math.abs(dy) > room) {
          log(
            `  scrollBy clamped ${dy} → ${Math.sign(dy) * Math.round(room)}px ` +
              `(target's scroller has no more room)`
          );
          dy = Math.sign(dy) * room;
        }
      }
      if (Math.abs(dy) >= 1) await easedWheel(page, dy, action);
      if (action.settleMs != null) await waitScrollSettled(page, action.settleMs, loc);
      return;
    }

    case "waitFor": {
      await waitForTargetVisible(
        page,
        storyboard,
        action.target,
        action.timeoutMs ?? 15000,
        action.state ?? "visible"
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
  if (action.optional) o.optional = true;
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
      if (action.target) o.target = describeProbeTarget(storyboard, action.target);
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
    case "highlight":
    case "spotlight":
    case "callout":
      o.target = describeProbeTarget(storyboard, action.target);
      break;
    case "moveTo":
      o.target = action.target
        ? describeProbeTarget(storyboard, action.target)
        : `${action.x},${action.y}`;
      break;
    case "assert":
      o.target = action.target
        ? describeProbeTarget(storyboard, action.target)
        : `url:${action.url}`;
      break;
  }
  return o;
}

/** The timeline.json `actions[].target` string for any action (or undefined). */
function describeActionTarget(storyboard: Storyboard, action: Action): string | undefined {
  const t = initProbeOutcome(storyboard, action).target;
  return t;
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
  const target = (action as { target?: Target }).target;
  if (target) {
    o.found = await targetResolves(page, storyboard, target);
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
  err: unknown,
  extra: { failedRequests: FailedRequest[] }
): Promise<never> {
  const prefix = `scene ${scene.id}, action #${index + 1} (${action.op})`;
  const base = err instanceof Error ? err.message : String(err);
  let diag = "";
  if (opts.logsDir) {
    diag = await dumpDiagnostics(
      page,
      storyboard,
      scene.id,
      index,
      action,
      opts.logsDir,
      extra.failedRequests
    ).catch(() => "");
  }
  throw new Error(`${prefix}: ${base}${diag ? `\n${diag}` : ""}`);
}

async function dumpDiagnostics(
  page: Page,
  storyboard: Storyboard,
  sceneId: string,
  index: number,
  action: Action,
  logsDir: string,
  failedRequests: FailedRequest[] = []
): Promise<string> {
  await ensureDir(logsDir);
  const stem = join(logsDir, `fail-${sceneId}-${index + 1}`);
  const lines: string[] = [];

  await page.screenshot({ path: `${stem}.png`, timeout: 5000 }).catch(() => {});
  lines.push(`  screenshot → ${stem}.png`);

  // Selector diagnostics for targeted actions: how many widget frames (and the
  // main frame) currently match the selector we were after.
  const target = (action as { target?: Target }).target;
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

  // App-side failures in this action's window (issue #44): a backend 500 on
  // the click's XHR is invisible in a screenshot and reads as a click miss.
  if (failedRequests.length) {
    lines.push(
      `  failed requests since the previous action: ${failedRequests.length} ` +
        `(an app-side write that failed reads as a click miss on screen)`
    );
    lines.push(...describeFailedRequests(failedRequests));
  } else {
    lines.push(`  failed requests since the previous action: none`);
  }

  // Drift suggestions: when the selector matched nothing, scan the page (and
  // the widget frames) for the elements that look most like what it asked
  // for, so the fix is one edit away instead of a round of guessing.
  let drift: DriftCandidate[] = [];
  let driftFile: string | null = null;
  const nothingMatched =
    !!selector && frameCounts.every((c) => c.matches <= 0) &&
    ((await page.locator(selector).count().catch(() => 0)) === 0);
  if (nothingMatched) {
    const scanned: DriftCandidate[] = [];
    const targets: Array<Page | Frame> = [page, ...roots];
    for (const t of targets) {
      const res = await scanInteractive(t, 120).catch(() => null);
      if (!res) continue;
      const frameTag = t === page ? undefined : truncateUrl((t as Frame).url());
      scanned.push(
        ...rankCandidates(selector!, res.elements, 8).map((c) =>
          frameTag ? { ...c, frame: frameTag } : c
        )
      );
    }
    drift = scanned.sort((a, b) => b.score - a.score).slice(0, 8);
    driftFile = join(logsDir, `drift-${sceneId}-${index + 1}.json`);
    await fs
      .writeFile(
        driftFile,
        JSON.stringify({ sceneId, actionIndex: index + 1, selector, url: page.url(), candidates: drift }, null, 2)
      )
      .catch(() => {});
    if (drift.length) {
      lines.push(`  nearest elements to "${selector}" (drift suggestions → ${driftFile}):`);
      for (const c of drift.slice(0, 3)) {
        lines.push(
          `    ${c.role} "${c.name.slice(0, 40)}"${c.frame ? ` [frame ${c.frame}]` : ""} → ${c.selector || "(no unique selector)"}  (score ${c.score})`
        );
      }
    } else {
      lines.push(`  no similar interactive element on the page (drift file → ${driftFile}) — is this the right screen / state?`);
    }
  }

  const detail = {
    sceneId,
    actionIndex: index + 1,
    action,
    selector: selector ?? null,
    url: page.url(),
    widgetFrames: frameCounts,
    allFrames: page.frames().map((f) => truncateUrl(f.url())),
    failedRequests,
    ...(driftFile ? { driftFile, driftCandidates: drift } : {}),
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

/** Full viewport rect of an element (after boxOf's bring-into-view nudge). */
async function rectOf(
  page: Page,
  loc: Locator
): Promise<{ x: number; y: number; w: number; h: number }> {
  await boxOf(page, loc);
  const box = await loc.boundingBox();
  if (!box) throw new Error("Element has no bounding box (not visible?)");
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    w: Math.round(box.width),
    h: Math.round(box.height),
  };
}

/** CSS used for `hide` selectors (record-time, the one non-compose exception). */
export function hideCss(selectors: string[]): string {
  return selectors.length
    ? `${selectors.join(",")}{visibility:hidden !important;}`
    : "";
}

/** Install / replace the per-scene hide stylesheet in the main frame. */
async function setSceneHide(page: Page, selectors: string[]): Promise<void> {
  const css = hideCss(selectors);
  await page
    .evaluate((text) => {
      const id = "__aidemo_scene_hide";
      let el = document.getElementById(id);
      if (!text) {
        el?.remove();
        return;
      }
      if (!el) {
        el = document.createElement("style");
        el.id = id;
        document.documentElement.appendChild(el);
      }
      el.textContent = text;
    }, css)
    .catch(() => {});
}

/**
 * Re-measure every redact selector and update the open spans: a box that
 * moved or vanished closes its span; a new/moved box opens one. Cheap (one
 * boundingBox per match), runs after every action.
 */
async function measureRedactions(
  page: Page,
  storyboard: Storyboard,
  list: Redact[],
  open: Map<string, RedactSpan>,
  capture: SceneCapture,
  now: () => number
): Promise<void> {
  const seen = new Set<string>();
  const t = now();
  for (const r of list) {
    let boxes: Array<{ x: number; y: number; width: number; height: number } | null> = [];
    try {
      const loc = await resolveTargetLocator(page, storyboard, {
        selector: r.selector,
        ...(r.frame ? { frame: r.frame } : {}),
      });
      const n = Math.min(await loc.count().catch(() => 0), REDACT_MAX_MATCHES);
      for (let i = 0; i < n; i++) {
        boxes.push(await loc.nth(i).boundingBox().catch(() => null));
      }
    } catch {
      boxes = [];
    }
    boxes.forEach((b, i) => {
      if (!b || b.width < 1 || b.height < 1) return;
      const key = `${r.frame ?? ""}>>${r.selector}#${i}`;
      seen.add(key);
      const rect = {
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.width),
        h: Math.round(b.height),
      };
      const cur = open.get(key);
      const same =
        cur &&
        Math.abs(cur.x - rect.x) <= 2 &&
        Math.abs(cur.y - rect.y) <= 2 &&
        Math.abs(cur.w - rect.w) <= 2 &&
        Math.abs(cur.h - rect.h) <= 2;
      if (same) return;
      if (cur) {
        cur.endMs = t;
        capture.redactSpans.push(cur);
      }
      open.set(key, { startMs: t, endMs: t, ...rect, blur: r.blur ?? 14 });
    });
  }
  for (const [key, span] of open) {
    if (seen.has(key)) continue;
    span.endMs = t;
    capture.redactSpans.push(span);
    open.delete(key);
  }
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

/**
 * `aidemo lint` / MCP `lint_storyboard` — a browser-free preflight over a
 * parsed storyboard. Schema validation says "this is a storyboard"; lint says
 * "this storyboard will produce a bad video": scenes whose narration outlasts
 * their action (compose will freeze-hold most of them — every real-world demo
 * hit this), selectors that match the wrong node, ops that need a partner op,
 * and no-op keys. Every rule here used to be a prose gotcha in AUTHORING.md
 * that authors learned by burning a take.
 *
 * Pure: no Chrome, no ffmpeg, no network. Estimates are constants read off the
 * player's sleeps (src/player.ts) and the compose retime bounds
 * (src/compose.ts) — good to ±25 %, which is enough to flag a scene that will
 * be 60 % frozen frame before TTS is paid for.
 */

import type { Storyboard, Scene, Action } from "./types.js";
import { clampScaleForWidth } from "./zoom.js";

export type LintSeverity = "error" | "warn" | "info";

export interface LintIssue {
  severity: LintSeverity;
  /** Stable rule id, e.g. "scene-pacing". */
  code: string;
  scene?: string;
  /** 0-based action index within the scene. */
  action?: number;
  message: string;
  /** What to change. */
  fix?: string;
}

export interface LintSceneEstimate {
  id: string;
  words: number;
  /** Predicted narration ms (words / rate). */
  narrationMs: number;
  /** Predicted recorded action ms (after idle trimming). */
  actionMs: number;
  /** Predicted hold share after compose's ≤1.6x slow-down (0..1). */
  holdPct: number;
  /** Predicted tail trim ms when the action outruns 2x speed-up. */
  overrunMs: number;
}

export interface LintResult {
  issues: LintIssue[];
  /** Per-scene pacing forecast (what report.json will say after compose). */
  estimate: LintSceneEstimate[];
  /** Predicted narration total (scenes + gaps), ms. */
  narrationTotalMs: number;
  /** Words-per-second rate the estimate used. */
  wordsPerSec: number;
}

/**
 * Spoken words per second by language, at speed 1.0. English is the guide's
 * planning figure; others are measured from real OpenAI TTS takes (Estonian
 * `marin` ≈ 1.75–1.8 w/s, issue #15) or interpolated for similar morphology.
 */
const WORDS_PER_SEC: Record<string, number> = {
  en: 2.5,
  et: 1.8,
  fi: 1.85,
  hu: 1.8,
  de: 2.0,
  nl: 2.1,
  sv: 2.1,
  da: 2.1,
  no: 2.1,
  fr: 2.2,
  es: 2.3,
  it: 2.2,
  pt: 2.2,
  pl: 1.9,
  cs: 1.9,
  ru: 1.9,
  uk: 1.9,
  ja: 2.0,
  zh: 2.4,
  ko: 2.0,
};
const DEFAULT_WPS = 2.2;

/** Inter-scene silence in the narration track (src/voice.ts GAP_MS). */
const GAP_MS = 300;
/** Compose retime bounds (src/compose.ts). */
const MAX_STRETCH = 1.6;
const MIN_FACTOR = 0.5;
/** Idle spans survive trimming as a sliver of this length (src/compose.ts). */
const IDLE_CAP_MS = 400;
/** Hold share past which compose itself warns (`scene-freeze`). */
const FREEZE_WARN_PCT = 0.4;

/** Default `autoIdle.minMs` — the forecast's view of what counts as dead air. */
const AUTO_IDLE_MIN_MS = 1500;

const EASING_MS: Record<string, number> = {
  smooth: 850,
  snappy: 450,
  glide: 1500,
  linear: 700,
};

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Predicted recorded ms one action contributes AFTER compose trims idle.
 * `autoIdle` (compose-time idle detection) also collapses motionless waits the
 * storyboard never marked — a long `pause` is the one the forecast can see.
 */
export function estimateActionMs(a: Action, autoIdle = false): number {
  switch (a.op) {
    case "goto":
      return 1400; // domcontentloaded + 600 ms settle + typical paint
    case "click":
      return 700; // glide ≈250 + 120 + 60 + 150 sleeps + scrollIntoView
    case "type": {
      const chars = a.text.length;
      const spaces = (a.text.match(/[\s.,!?]/g) ?? []).length;
      return 700 + (a.humanize === false ? chars * 25 : chars * 72 + spaces * 60);
    }
    case "press":
      return 200;
    case "hover":
      return 600;
    case "scrollTo":
      return (a.durationMs ?? EASING_MS[a.easing ?? "smooth"]) + (a.settleMs ?? 300);
    case "scrollBy":
      return (a.durationMs ?? EASING_MS[a.easing ?? "smooth"]) + (a.settleMs ?? 250);
    case "pause":
      // Nothing moves during a pause, so autoIdle trims it to the same cap an
      // annotated wait gets — but only past the detector's own threshold.
      return autoIdle && a.ms >= AUTO_IDLE_MIN_MS ? IDLE_CAP_MS : a.ms;
    case "focus":
      return 150; // the zoom hold is compose-time and adds NO record time
    case "still":
      return 120;
    case "waitFor":
      return 500; // active (not idle-marked); usually resolves fast
    case "waitForWidget":
    case "waitForReply":
      return IDLE_CAP_MS; // idle-marked → trimmed to the cap
    case "waitForChange":
      return a.idle ? IDLE_CAP_MS : 900;
    case "highlight":
    case "spotlight":
    case "callout":
      // Record-time dwell only; the overlay hold itself is compose-time.
      return Math.min(a.holdMs ?? (a.op === "callout" ? 2000 : 1600), 800) + 150;
    case "moveTo":
      return 450; // glide + 150 ms settle
    case "assert":
      return 250; // usually already true; the poll returns on first check
    case "select":
      return 900; // click + programmatic pick + settle
    case "drag":
      return 1100; // two glides + press/release sleeps
    case "upload":
      return 800;
    case "back":
      return 1400; // like goto
    default:
      return 300;
  }
}

function languageOf(sb: Storyboard, lang?: string): string {
  const code = (lang ?? sb.language ?? "en").toLowerCase().split(/[-_]/)[0];
  return code;
}

/** Narration text a render of `lang` would speak for this scene. */
function narrationFor(scene: Scene, lang?: string): string {
  if (lang && scene.narrations?.[lang]) return scene.narrations[lang];
  return scene.narration ?? "";
}

/**
 * Lint a parsed storyboard. `lang` selects `narrations[lang]` (multi-language
 * renders) and the pacing rate; omit for the base narration.
 */
export function lintStoryboard(
  sb: Storyboard,
  opts: { lang?: string } = {}
): LintResult {
  const issues: LintIssue[] = [];
  const push = (i: LintIssue): void => {
    issues.push(i);
  };
  const code = languageOf(sb, opts.lang);
  const baseWps = WORDS_PER_SEC[code] ?? DEFAULT_WPS;
  const speed = sb.voice?.speed ?? 1;
  const wps = baseWps * speed;

  const estimate: LintSceneEstimate[] = [];
  let narrationTotalMs = 0;
  const stillNames = new Map<string, string>();
  const hasZoom = !!sb.zoom && sb.zoom.enabled !== false;

  sb.scenes.forEach((scene, si) => {
    const sceneWps = (sb.voice?.speed ?? 1) !== (scene.voice?.speed ?? sb.voice?.speed ?? 1)
      ? baseWps * (scene.voice?.speed ?? 1)
      : wps;
    const text = narrationFor(scene, opts.lang);
    const words = countWords(text);
    const narrationMs = words > 0 ? Math.round((words / sceneWps) * 1000) : 0;
    if (narrationMs > 0) narrationTotalMs += narrationMs + GAP_MS;

    let actionMs = 0;
    const sceneAutoIdle =
      scene.autoIdle ??
      (sb.autoIdle === true ||
        (typeof sb.autoIdle === "object" && sb.autoIdle.enabled !== false));
    for (const a of scene.actions) actionMs += estimateActionMs(a, sceneAutoIdle);

    // --- pacing: what compose will have to do with this scene ---
    let holdPct = 0;
    let overrunMs = 0;
    if (narrationMs > 0) {
      const targetMs = narrationMs + GAP_MS;
      const stretched = actionMs * MAX_STRETCH;
      if (stretched < targetMs) {
        holdPct = (targetMs - stretched) / targetMs;
      } else if (actionMs * MIN_FACTOR > targetMs) {
        overrunMs = Math.round(actionMs * MIN_FACTOR - targetMs);
      }
      if (holdPct > FREEZE_WARN_PCT) {
        const holdSec = ((targetMs - stretched) / 1000).toFixed(1);
        push({
          severity: holdPct > 0.6 ? "warn" : "info",
          code: "scene-pacing",
          scene: scene.id,
          message:
            `≈${(actionMs / 1000).toFixed(1)}s of action for ≈${(narrationMs / 1000).toFixed(1)}s ` +
            `of narration (${words} words @ ${sceneWps.toFixed(1)} w/s) — compose will hold ` +
            `a frame for ≈${holdSec}s (${Math.round(holdPct * 100)}% of the scene)`,
          fix:
            "add on-screen beats (hover, scrollTo/scrollBy, focus + pause) so the action " +
            "carries the narration, shorten the narration, or set `hold: {mode: \"drift\"}` " +
            "so the hold reads as a slow push-in instead of a freeze",
        });
      } else if (overrunMs > 0) {
        push({
          severity: "warn",
          code: "scene-overrun",
          scene: scene.id,
          message:
            `≈${(actionMs / 1000).toFixed(1)}s of action for ≈${(narrationMs / 1000).toFixed(1)}s ` +
            `of narration — even at 2x speed-up compose must cut ≈${(overrunMs / 1000).toFixed(1)}s ` +
            `from the scene's tail (where the payoff usually is)`,
          fix:
            "lengthen the narration, mark long waits idle (waitForWidget/waitForReply, " +
            "waitForChange idle:true), shorten `pause`s or `type` text, or split the scene",
        });
      }
    } else if (scene.actions.length > 0 && !opts.lang) {
      push({
        severity: "info",
        code: "scene-no-narration",
        scene: scene.id,
        message: "scene has actions but no narration — compose skips scenes without audio",
        fix: "add narration (or drop the scene; probe runs it anyway)",
      });
    }
    if (scene.actions.length === 0 && si > 0) {
      push({
        severity: "info",
        code: "scene-no-actions",
        scene: scene.id,
        message: "scene has no actions — its whole narration plays over a held frame",
        fix: "add a `pause`/`hover`/`focus` beat, or fold the narration into the neighbour scene",
      });
    }
    estimate.push({ id: scene.id, words, narrationMs, actionMs, holdPct: Number(holdPct.toFixed(3)), overrunMs });

    // --- narration anchors: every {{@name}} needs an action and vice versa ---
    const anchorDefs =
      (opts.lang && scene.narrations?.[opts.lang] ? scene.narrationAnchors?.[opts.lang] : undefined) ??
      scene.anchors ??
      {};
    const anchorUse = new Map<string, number[]>();
    scene.actions.forEach((a, ai) => {
      if (!a.anchor) return;
      anchorUse.set(a.anchor, [...(anchorUse.get(a.anchor) ?? []), ai]);
    });
    for (const [name, idxs] of anchorUse) {
      if (!(name in anchorDefs)) {
        push({
          severity: "error",
          code: "anchor-missing",
          scene: scene.id,
          action: idxs[0],
          message: `action anchor "${name}" has no {{@${name}}} marker in this scene's narration — compose can't place the beat`,
          fix: `write {{@${name}}} right before the word the action should land on`,
        });
      }
      if (idxs.length > 1) {
        push({
          severity: "error",
          code: "anchor-duplicate",
          scene: scene.id,
          action: idxs[1],
          message: `anchor "${name}" is on ${idxs.length} actions — a marker can only place one beat`,
          fix: "use distinct anchor names ({{@add}}, {{@checkout}})",
        });
      }
    }
    for (const name of Object.keys(anchorDefs)) {
      if (anchorUse.has(name)) continue;
      push({
        severity: "warn",
        code: "anchor-unused",
        scene: scene.id,
        message: `narration marks {{@${name}}} but no action in this scene has anchor: "${name}" — the marker does nothing`,
        fix: `add anchor: "${name}" to the click/type/press that should land on that word`,
      });
    }

    // --- structural rules over the action list ---
    scene.actions.forEach((a, ai) => {
      const next = scene.actions[ai + 1];
      const rest = scene.actions.slice(ai + 1);
      const sel = "target" in a && a.target ? a.target.selector ?? "" : "";

      if (a.op === "moveTo" && !a.target && (a.x == null || a.y == null)) {
        push({
          severity: "error",
          code: "moveto-no-point",
          scene: scene.id,
          action: ai,
          message: "`moveTo` needs a `target` or both `x` and `y` — the take fails at this action",
          fix: "give it a target, or an absolute viewport point {x, y}",
        });
      }
      if (a.op === "assert") {
        if (!a.target && !a.url) {
          push({
            severity: "error",
            code: "assert-no-check",
            scene: scene.id,
            action: ai,
            message: "`assert` needs a `target` and/or a `url` — the take fails at this action",
            fix: "assert the payoff element ({target, textMatches?}) or the destination ({url})",
          });
        } else if (a.textMatches && !a.target) {
          push({
            severity: "warn",
            code: "assert-text-no-target",
            scene: scene.id,
            action: ai,
            message: "`assert.textMatches` is ignored without a `target`",
            fix: "add the target whose text should match",
          });
        }
        for (const re of [a.textMatches, a.url]) {
          if (re == null) continue;
          try {
            new RegExp(re);
          } catch (e) {
            push({
              severity: "error",
              code: "assert-bad-regex",
              scene: scene.id,
              action: ai,
              message: `\`assert\` regex ${JSON.stringify(re)} is invalid: ${(e as Error).message}`,
            });
          }
        }
      }
      if (
        a.retry &&
        !["click", "type", "hover", "scrollTo", "focus", "moveTo", "assert", "select", "drag", "upload"].includes(a.op)
      ) {
        push({
          severity: "info",
          code: "retry-noop",
          scene: scene.id,
          action: ai,
          message: `\`retry\` does nothing on \`${a.op}\` — only interactions and assert re-attempt`,
        });
      }

      if (a.op === "type" && next?.op === "press" && /^enter$/i.test(next.key)) {
        const waits = rest.some((r) => /^wait/.test(r.op));
        if (!waits) {
          push({
            severity: "warn",
            code: "type-enter-no-wait",
            scene: scene.id,
            action: ai,
            message: "`type` + `press Enter` with no wait afterwards — the scene ends (or the next action fires) before the result renders",
            fix: "follow it with waitFor (destination content), waitForChange, or waitForWidget/waitForReply",
          });
        }
      }
      if (a.op === "type" && a.target.named === "composer" && a.humanize !== false) {
        push({
          severity: "warn",
          code: "composer-humanize",
          scene: scene.id,
          action: ai,
          message: "typing into the ChatGPT composer with humanized keystrokes makes the scene's active video shorter than the reply it waits for",
          fix: "set `humanize: false` on composer `type` actions (see AUTHORING → ChatGPT Apps SDK)",
        });
      }
      if (a.op === "focus" && !hasZoom) {
        push({
          severity: "warn",
          code: "focus-without-zoom",
          scene: scene.id,
          action: ai,
          message: "`focus` is a zoom marker, but the storyboard has no `zoom` block — it renders as a 150 ms no-op",
          fix: 'add a top-level `"zoom": {}` (or remove the focus)',
        });
      }
      if (a.op === "still") {
        const prev = stillNames.get(a.name);
        if (prev) {
          push({
            severity: "error",
            code: "still-duplicate",
            scene: scene.id,
            action: ai,
            message: `still "${a.name}" is also declared in scene ${prev} — stills extraction fails on duplicate names`,
            fix: "give each still a unique slug",
          });
        } else {
          stillNames.set(a.name, scene.id);
        }
      }
      if (sel.includes(":text-is(")) {
        push({
          severity: "info",
          code: "text-is-selector",
          scene: scene.id,
          action: ai,
          message: "`:text-is()` matches the innermost node with that exact text — on nested labels (RN-web, icon+label buttons) it resolves to the inner <div>, not the button",
          fix: 'use `:has-text("…")` on the interactive wrapper (e.g. `[role="button"]:has-text("Library")`)',
        });
      }
      if (a.op === "waitForChange" && a.textMatches && /^\^|\$$/.test(a.textMatches)) {
        push({
          severity: "info",
          code: "waitforchange-anchored",
          scene: scene.id,
          action: ai,
          message: `waitForChange matches the NEW text against /${a.textMatches}/ — if the element already reads that way (e.g. "+10" vs /^10$/) it never fires`,
          fix: "match a substring the change introduces, or wait on an element the change creates",
        });
      }
      if (
        (a.op === "waitFor" || a.op === "waitForWidget" || a.op === "waitForChange") &&
        a.timeoutMs != null &&
        a.timeoutMs > 60000
      ) {
        push({
          severity: "info",
          code: "long-timeout",
          scene: scene.id,
          action: ai,
          message: `${a.op} timeoutMs ${a.timeoutMs} — a missing element stalls the take for over a minute before failing`,
          fix: "keep wait budgets ≤ 30 s unless the app is genuinely that slow",
        });
      }
      if (a.optional && /^wait/.test(a.op)) {
        push({
          severity: "info",
          code: "optional-wait",
          scene: scene.id,
          action: ai,
          message: `optional ${a.op} still burns its full timeout as recorded (non-idle) time when the target never appears`,
          fix: "give it a short timeoutMs, or make the interaction optional instead",
        });
      }
    });

    // Pre-navigate hint: a scene (not the first) that opens with navigation
    // shows the OLD screen for the cursor glide, so its narration starts over
    // the wrong page.
    const first = scene.actions[0];
    if (si > 0 && first && (first.op === "goto" || first.op === "click")) {
      const lastPrev = sb.scenes[si - 1].actions.at(-1);
      const prevEndsWithNav = lastPrev && (lastPrev.op === "goto" || lastPrev.op === "click");
      if (first.op === "goto" || !prevEndsWithNav) {
        push({
          severity: "info",
          code: "nav-first",
          scene: scene.id,
          action: 0,
          message: `scene opens with a ${first.op} — the previous screen stays up (and this scene's narration starts over it) while the navigation lands`,
          fix: "pre-navigate: move the nav action to the END of the previous scene so this scene opens on its screen",
        });
      }
    }

    if (scene.music?.cue) {
      push({
        severity: "info",
        code: "music-cue-noop",
        scene: scene.id,
        message: "per-scene `music.cue` is informational only and ignored (the bed plays continuously)",
        fix: "remove it, or accept the continuous ducked bed",
      });
    }
  });

  // --- storyboard-level rules ---

  if (sb.attention?.clicks && !sb.cursor) {
    push({
      severity: "info",
      code: "clicks-without-cursor",
      message: "`attention.clicks` draws click rings only with the compose-time cursor — no `cursor` block, so no rings",
      fix: "add a `cursor: {}` block (the take is then recorded cursor-free and the cursor is overlaid at compose)",
    });
  }
  if (sb.zoom && sb.zoom.enabled !== false) {
    const capped = clampScaleForWidth(sb.zoom.scale, sb.video.width);
    if (capped < sb.zoom.scale) {
      push({
        severity: "info",
        code: "zoom-scale-viewport",
        message: `zoom.scale ${sb.zoom.scale} exceeds what a ${sb.video.width}px-wide viewport can show; compose caps it to ${capped.toFixed(2)}`,
        fix: `set zoom.scale ≤ ${capped.toFixed(2)} (or widen the viewport)`,
      });
    }
  }
  if (sb.targetLengthSeconds != null) {
    const introMs = sb.intro?.durationMs ?? 0;
    const outroMs = sb.outro?.durationMs ?? 0;
    const totalMs = narrationTotalMs + introMs + outroMs;
    const targetMs = sb.targetLengthSeconds * 1000;
    if (totalMs > targetMs * 1.1) {
      const totalWords = estimate.reduce((a, e) => a + e.words, 0);
      const budget = Math.round(((targetMs - introMs - outroMs) / 1000) * wps);
      push({
        severity: "warn",
        code: "target-length",
        message:
          `≈${(totalMs / 1000).toFixed(0)}s predicted (${totalWords} words @ ${wps.toFixed(1)} w/s` +
          (introMs || outroMs ? " + cards" : "") +
          `) vs targetLengthSeconds ${sb.targetLengthSeconds}`,
        fix: `trim the script to ≈${budget} words, or raise targetLengthSeconds`,
      });
    }
  }
  if (sb.cursor && !sb.cursor.hidden && sb.motionBlur && sb.motionBlur.enabled !== false) {
    const scrolls = sb.scenes.reduce(
      (n, s) => n + s.actions.filter((a) => a.op === "scrollTo" || a.op === "scrollBy").length,
      0
    );
    if (scrolls >= 3) {
      push({
        severity: "info",
        code: "motionblur-scroll",
        message: `motionBlur is on and the storyboard scrolls ${scrolls} times — tmix smears scrolling text`,
        fix: "drop motionBlur on scroll-heavy demos (or use frames: 2)",
      });
    }
  }

  const order: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { issues, estimate, narrationTotalMs, wordsPerSec: wps };
}

/** Log-friendly one-liners. */
export function formatLintIssue(i: LintIssue): string {
  const glyph = i.severity === "error" ? "✗" : i.severity === "warn" ? "⚠" : "·";
  const where = i.scene
    ? ` ${i.scene}${i.action != null ? `#${i.action + 1}` : ""}`
    : "";
  return `${glyph} [${i.code}]${where}: ${i.message}${i.fix ? `\n    → ${i.fix}` : ""}`;
}

/** Log every issue (used by probe/record/render as a non-fatal preflight). */
export function logLint(result: LintResult, logFn: (s: string) => void): void {
  if (result.issues.length === 0) return;
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of result.issues) counts[i.severity]++;
  logFn(
    `lint: ${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} note(s)` +
      ` — predicted narration ≈${(result.narrationTotalMs / 1000).toFixed(0)}s` +
      ` @ ${result.wordsPerSec.toFixed(1)} w/s`
  );
  for (const i of result.issues) logFn(`  ${formatLintIssue(i)}`);
}

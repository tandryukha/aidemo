/**
 * Narration-anchored beats. An author writes `{{@add}}` in the narration
 * right before the word the beat should land on and puts `anchor: "add"`
 * on the action. Parse strips the markers (word indexes survive on the
 * scene), the player timestamps the anchored action, captions know when
 * the word is spoken, and compose retimes the scene piecewise so the click
 * lands on the word. No LLM, no steering — one more deterministic mapping.
 */

import type { Storyboard } from "./types.js";

/** `{{@name}}` — the params syntax with an @, so PLACEHOLDER_RE never sees it. */
export const ANCHOR_RE = /\{\{\s*@([\w.-]+)\s*\}\}/g;

export interface ExtractedAnchors {
  /** Narration with the markers removed (whitespace collapsed at the seam). */
  text: string;
  /** name → 0-based index of the word the marker precedes. */
  anchors: Record<string, number>;
  /** Names that appeared more than once (the last one wins). */
  duplicates: string[];
}

/** Strip `{{@name}}` markers and record which word each one precedes. */
export function extractAnchors(narration: string): ExtractedAnchors {
  const anchors: Record<string, number> = {};
  const duplicates: string[] = [];
  let out = "";
  let last = 0;
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(narration))) {
    out += narration.slice(last, m.index);
    last = m.index + m[0].length;
    const before = out.trim();
    const idx = before ? before.split(/\s+/).length : 0;
    // A marker glued to the end of a word ("basket{{@x}}") still means the
    // NEXT word — unless nothing follows.
    const gluedToWord = before.length > 0 && !/\s$/.test(out);
    const name = m[1];
    if (name in anchors) duplicates.push(name);
    anchors[name] = gluedToWord ? idx : idx;
  }
  out += narration.slice(last);
  const text = out.replace(/[ \t]{2,}/g, " ").replace(/ +([,.;:!?])/g, "$1").trim();
  const wordCount = text ? text.split(/\s+/).length : 0;
  for (const k of Object.keys(anchors)) anchors[k] = Math.min(anchors[k], Math.max(0, wordCount - 1));
  return { text, anchors, duplicates };
}

/** Plain text without markers (for consumers that never need positions). */
export function stripAnchors(narration: string): string {
  return extractAnchors(narration).text;
}

/**
 * Parse-time pass: strip markers from `narration` / `narrations[*]` and
 * record the word indexes on the scene (`anchors`, `narrationAnchors`), so
 * every downstream stage sees clean text and can still find the beats.
 */
export function applyAnchors(sb: Storyboard): Storyboard {
  let touched = false;
  const scenes = sb.scenes.map((scene) => {
    const base = extractAnchors(scene.narration);
    let narrationAnchors: Record<string, Record<string, number>> | undefined;
    let narrations = scene.narrations;
    if (scene.narrations) {
      narrations = {};
      for (const [lang, text] of Object.entries(scene.narrations)) {
        const ex = extractAnchors(text);
        narrations[lang] = ex.text;
        if (Object.keys(ex.anchors).length) {
          narrationAnchors ??= {};
          narrationAnchors[lang] = ex.anchors;
        }
      }
    }
    const hasBase = Object.keys(base.anchors).length > 0;
    if (!hasBase && !narrationAnchors && base.text === scene.narration) return scene;
    touched = true;
    return {
      ...scene,
      narration: base.text,
      ...(narrations ? { narrations } : {}),
      ...(hasBase ? { anchors: base.anchors } : {}),
      ...(narrationAnchors ? { narrationAnchors } : {}),
    };
  });
  return touched ? { ...sb, scenes } : sb;
}

/** Normalize a token for script ↔ transcript matching. */
function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * When is script word #`wordIndex` spoken? `words` are the scene's timed
 * words (STT transcript or script-timed), `script` the narration text.
 * Aligns by normalized token near the proportional position, so a transcript
 * that split "add-on" or heard "to" as "too" still lands on the right beat;
 * falls back to proportional interpolation. Returns scene-relative ms.
 */
export function wordStartMs(
  words: Array<{ word: string; start: number; end: number }>,
  script: string,
  wordIndex: number
): number | null {
  if (!words.length) return null;
  const tokens = script.split(/\s+/).filter(Boolean);
  const idx = Math.max(0, Math.min(wordIndex, tokens.length - 1));
  const target = norm(tokens[idx] ?? "");
  // Exact count match — the common case for script-timed captions.
  if (tokens.length === words.length && norm(words[idx].word) === target) {
    return Math.round(words[idx].start * 1000);
  }
  const guess = Math.round((idx / Math.max(1, tokens.length)) * words.length);
  const window = Math.max(3, Math.ceil(words.length * 0.15));
  let best: { d: number; i: number } | null = null;
  for (let i = Math.max(0, guess - window); i < Math.min(words.length, guess + window + 1); i++) {
    if (!target || norm(words[i].word) !== target) continue;
    const d = Math.abs(i - guess);
    if (!best || d < best.d) best = { d, i };
  }
  if (best) return Math.round(words[best.i].start * 1000);
  const i = Math.min(words.length - 1, guess);
  return Math.round(words[i].start * 1000);
}

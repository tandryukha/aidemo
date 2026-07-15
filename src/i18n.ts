import type { Card, Storyboard } from "./types.js";

/**
 * Multi-language renders from ONE take.
 *
 * The recorded take (raw video + timeline.json) is language-independent — it's
 * a deterministic replay of the browser action-spec, which never mentions the
 * spoken words. So a storyboard can carry translated narration (per scene) and
 * translated card copy (intro/outro), and the engine can voice → caption →
 * compose it once per language over the SAME footage. compose already stretches
 * each scene's video to its own narration length, so a longer/shorter
 * translation just retimes the shared take — no re-record.
 *
 * Translations are AUTHORED into the storyboard (scene `narrations`, card
 * `i18n`); the engine never calls an LLM to translate. This keeps the capture
 * loop — and the render pipeline — LLM-free.
 */

/**
 * Every language code that appears in a storyboard's `narrations` / card `i18n`
 * maps (the default `narration`/card copy is the implicit base language and is
 * NOT listed). Order-stable, de-duplicated.
 */
export function storyboardLangs(sb: Storyboard): string[] {
  const langs = new Set<string>();
  for (const scene of sb.scenes)
    for (const code of Object.keys(scene.narrations ?? {})) langs.add(code);
  for (const card of [sb.intro, sb.outro])
    for (const code of Object.keys(card?.i18n ?? {})) langs.add(code);
  return [...langs];
}

/** Scene ids that have no translation for `lang` (fall back to the base narration). */
export function missingNarrations(sb: Storyboard, lang: string): string[] {
  return sb.scenes
    .filter((s) => s.narrations?.[lang] == null)
    .map((s) => s.id);
}

/** Apply a card's per-language title/subtitle override (untouched if none). */
function localizeCard(card: Card | undefined, lang: string): Card | undefined {
  if (!card) return card;
  const override = card.i18n?.[lang];
  if (!override) return card;
  return {
    ...card,
    title: override.title ?? card.title,
    subtitle: override.subtitle ?? card.subtitle,
  };
}

/**
 * A language-specific VIEW of the storyboard: each scene's `narration` becomes
 * its `narrations[lang]` translation (falling back to the base narration where
 * a scene isn't translated), and intro/outro cards pick up any `i18n` override.
 * Everything else — actions, timing, voice/music/zoom — is identical, so the
 * shared take composes unchanged. Pure and side-effect-free; the original
 * storyboard is left intact.
 */
export function localizeStoryboard(sb: Storyboard, lang: string): Storyboard {
  return {
    ...sb,
    intro: localizeCard(sb.intro, lang),
    outro: localizeCard(sb.outro, lang),
    scenes: sb.scenes.map((scene) => ({
      ...scene,
      narration: scene.narrations?.[lang] ?? scene.narration,
    })),
  };
}

/**
 * The spoken language of a given render, for STT purposes (Whisper's
 * `language` hint in src/captions.ts) — NOT the same lookup as
 * `localizeStoryboard`'s translation selection. An active `--lang <code>`
 * render wins (it names the translation being spoken); otherwise the
 * storyboard's own optional `language` field describes the base narration
 * (e.g. a monolingual non-English demo with no `narrations` translations at
 * all). Undefined when neither is set — Whisper auto-detects.
 */
export function resolveNarrationLanguage(
  sb: Storyboard | undefined,
  lang?: string
): string | undefined {
  return lang ?? sb?.language;
}

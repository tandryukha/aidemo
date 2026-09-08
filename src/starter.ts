/** Templates written by `aidemo init`. Kept in code so init has no file deps.
 *
 * The storyboard scaffolds a common shape — search → results → act → confirm —
 * with placeholder selectors you MUST replace with your app's real hooks
 * (confirm them by driving the real page once; `aidemo probe` dry-runs the
 * actions without narration). For ChatGPT Apps SDK widgets and other
 * iframe-embedded apps, see the record-demo skill for the frames pattern.
 */

export const STARTER_BRIEF = (name: string): string => `# Demo Brief — ${name}

## Product
<your product> (a web app; for ChatGPT apps / Apps SDK widgets see the record-demo skill)

## Demo goal
Show a user completing <the core flow> end-to-end — e.g. search for an item,
compare results, add to basket, and check out.

## Audience
<who is this demo for>

## Tone
Friendly, practical, founder-style. Brisk.

## Length
~45-60 seconds.

## CTA
<what should the viewer do next>

---

Authoring notes (see the record-demo skill for the full schema + principles):
- 4-6 scenes, ONE idea each; ~2.5 words/second of narration per scene.
- Use waitForWidget (with label "thinking") for every async/loading wait so the
  dead time gets trimmed out of the final cut.
- Set humanize:false on typing when the narration (not the typing) should set
  the scene's pace.
- Placeholder selectors in the scaffold storyboard will NOT match your app —
  replace them with real hooks and confirm with \`aidemo probe\`.
- If your app renders inside an iframe (e.g. a ChatGPT Apps SDK widget), declare
  it under "frames" and target elements with { "frame": "<name>", ... } — the
  skill documents the nested-iframe pattern and real-world gotchas.
`;

export const STARTER_STORYBOARD = (name: string): string =>
  JSON.stringify(
    {
      _README:
        "Scaffold with PLACEHOLDER selectors — replace every #search / [data-demo=...] with your app's real hooks, then verify with `aidemo probe`. Keep scenes to one idea each; use waitForWidget for async waits so they get trimmed. For iframe-embedded apps (ChatGPT widgets), add a 'frames' entry and target with {frame:'<name>'} — see the record-demo skill.",
      title: name,
      targetLengthSeconds: 55,
      video: { width: 1280, height: 800 },
      // For iframe-embedded apps, name the iframe here and target elements with
      // { "frame": "widget", "selector": "..." }. Example (ChatGPT Apps SDK —
      // the 'oaiusercontent' substring makes the engine descend into the nested
      // widget iframe automatically):
      //   frames: { widget: 'iframe[src*="web-sandbox.oaiusercontent.com"]' }
      frames: {},
      voice: {
        voiceId: "marin",
        instructions: "Confident, friendly founder. Clear and warm, brisk but not rushed.",
        speed: 1.05,
      },
      // Screen-Studio-style auto-zoom on every click/typed prompt. Delete this
      // key to disable, or set "zoom": false on a busy scene.
      zoom: { scale: 1.55, easeMs: 600, holdMs: 1700 },
      intro: {
        title: name,
        subtitle: "<one-line value prop>",
        durationMs: 2600,
      },
      outro: {
        title: "<call to action>",
        subtitle: "<your-domain.example>",
        durationMs: 2600,
      },
      // Optional: drop a track at assets/music.mp3 for a music bed. It ducks
      // under narration automatically (sidechain) and swells over the cards.
      // music: { track: "assets/music.mp3", gainDb: -14 },
      scenes: [
        {
          id: "s1-search",
          narration:
            "Meet <product> — describe what you need in plain language, and it searches the live catalog for you.",
          actions: [
            { op: "goto", url: "https://your-app.example/" },
            { op: "pause", ms: 1200 },
            {
              op: "type",
              target: { selector: "#search" },
              humanize: false,
              text: "<a realistic search query>",
            },
            { op: "press", key: "Enter" },
            {
              op: "waitForWidget",
              target: { selector: "[data-demo=result-card]" },
              label: "thinking",
              timeoutMs: 30000,
            },
            { op: "pause", ms: 1600 },
          ],
        },
        {
          id: "s2-results",
          narration:
            "Results come back with the details that matter — so the best option jumps right out.",
          actions: [
            { op: "scrollTo", target: { selector: "[data-demo=result-card]" }, easing: "smooth" },
            { op: "pause", ms: 1400 },
          ],
        },
        {
          id: "s3-act",
          narration: "Pick one, and it goes straight into the basket — no forms, no friction.",
          actions: [
            { op: "click", target: { selector: "[data-demo=add-to-cart]" } },
            { op: "pause", ms: 1400 },
          ],
        },
        {
          id: "s4-confirm",
          narration:
            "Check out in a single click, and you're done. That's <product> — <value prop, restated>.",
          actions: [
            { op: "click", target: { selector: "[data-demo=checkout]" } },
            {
              op: "waitForWidget",
              target: { selector: "[data-demo=order-confirmed]" },
              label: "thinking",
              timeoutMs: 25000,
            },
            { op: "pause", ms: 2200 },
          ],
        },
      ],
    },
    null,
    2
  ) + "\n";

// ---------------------------------------------------------------------------
// `init --from-url`: a draft built from what `inspect` saw on the page — real
// headings become scenes, real unique selectors become the beats. No LLM: the
// agent still writes the narration and decides the flow; this only removes
// the selector archaeology from the first draft.
// ---------------------------------------------------------------------------

import type { InspectElement, InspectResult } from "./inspect.js";

function slug(text: string, max = 24): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "scene";
}

function jsonText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Headings worth a scene: h1/h2 (h3 when there are too few), deduped, ≤ 4. */
function sceneHeadings(res: InspectResult): Array<{ level: number; text: string }> {
  const clean = res.headings
    .map((h) => ({ level: h.level, text: h.text.replace(/\s+/g, " ").trim() }))
    .filter((h) => h.text.length >= 3 && h.text.length <= 80);
  const seen = new Set<string>();
  const pick = (maxLevel: number) =>
    clean.filter((h) => {
      if (h.level > maxLevel || seen.has(h.text.toLowerCase())) return false;
      seen.add(h.text.toLowerCase());
      return true;
    });
  let out = pick(2);
  if (out.length < 2) out = [...out, ...pick(3)];
  return out.slice(0, 4);
}

/** The most promising interactive elements: named, unique, in the viewport first. */
function candidateElements(res: InspectResult, max = 8): InspectElement[] {
  const score = (e: InspectElement): number =>
    (e.selectors.length ? 2 : 0) +
    (e.inViewport ? 2 : 0) +
    (e.role === "button" || e.role === "textbox" || e.role === "searchbox" ? 1 : 0) +
    (e.name ? 1 : 0) +
    (e.testid ? 1 : 0);
  return [...res.elements]
    .filter((e) => e.selectors.length && e.name)
    .sort((a, b) => score(b) - score(a))
    .slice(0, max);
}

export function storyboardFromInspect(name: string, res: InspectResult): string {
  const headings = sceneHeadings(res);
  const cands = candidateElements(res);
  const search = cands.find((e) => e.role === "textbox" || e.role === "searchbox");
  const cta = cands.find((e) => e.role === "button" || e.role === "link");
  const title = res.title?.trim() || name;
  const scenes: unknown[] = [];

  scenes.push({
    id: "s1-open",
    narration: `<hook: what ${title} does, in one sentence>`,
    actions: [
      { op: "goto", url: res.finalUrl || res.url },
      { op: "pause", ms: 1200 },
      ...(search
        ? [
            {
              op: "type",
              target: { selector: search.selector },
              humanize: false,
              text: "<a realistic query>",
              comment: `textbox "${search.name}" — delete this beat if the story doesn't start with a search`,
            },
            { op: "press", key: "Enter" },
            { op: "pause", ms: 1400 },
          ]
        : []),
    ],
  });

  headings.slice(search ? 0 : 1).forEach((h, i) => {
    scenes.push({
      id: `s${scenes.length + 1}-${slug(h.text)}`,
      narration: `<narrate the "${h.text}" section>`,
      actions: [
        {
          op: "scrollTo",
          target: { selector: `h${h.level}:has-text("${jsonText(h.text)}")` },
          easing: "smooth",
        },
        { op: "pause", ms: 1400 },
      ],
      ...(i === 0 ? {} : {}),
    });
  });

  if (cta) {
    scenes.push({
      id: `s${scenes.length + 1}-${slug(cta.name)}`,
      narration: `<the payoff: what happens after "${cta.name}">`,
      actions: [
        {
          op: "hover",
          target: { selector: cta.selector },
          comment: `${cta.role} "${cta.name}" — change to click once the flow after it is known, then assert the result`,
        },
        { op: "pause", ms: 1400 },
      ],
    });
  }

  const frames: Record<string, string> = {};
  for (const f of res.iframes.slice(0, 3)) frames[f.name || `frame${Object.keys(frames).length + 1}`] = f.selector;

  const doc = {
    _README:
      `Draft from \`inspect ${res.url}\` — headings became scenes, unique selectors became beats. ` +
      "Write the narration (one idea per scene, ~2.5 words/s), turn the candidate hover into the real click + an assert, " +
      "drop scenes that don't serve the story, then `aidemo probe`. `_candidates` lists more selectors seen on the page.",
    title,
    targetLengthSeconds: 45,
    video: { width: res.viewport.width, height: res.viewport.height },
    ...(Object.keys(frames).length ? { frames } : {}),
    voice: {
      voiceId: "marin",
      instructions: "Confident, friendly founder. Clear and warm, brisk but not rushed.",
      speed: 1.05,
    },
    zoom: { scale: 1.55, easeMs: 600, holdMs: 1700 },
    intro: { title, subtitle: "<one-line value prop>", durationMs: 2600 },
    outro: { title: "<call to action>", subtitle: "<your-domain.example>", durationMs: 2600 },
    scenes,
    _candidates: cands.map((e) => ({
      role: e.role,
      name: e.name,
      selector: e.selector,
      ...(e.frame ? { frame: e.frame } : {}),
      ...(e.inViewport ? {} : { belowFold: true }),
    })),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

export function briefFromInspect(name: string, res: InspectResult): string {
  const headings = res.headings.map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}- h${h.level} ${h.text}`);
  const cands = candidateElements(res, 12).map(
    (e) => `| ${e.role} | ${e.name.replace(/\|/g, "/")} | \`${e.selector}\` | ${e.inViewport ? "" : "below fold"} |`
  );
  return `# Demo Brief — ${name}

Drafted from \`aidemo inspect ${res.url}\` (page title: ${res.title || "—"}).
Fill in the product, audience, tone and CTA; the storyboard next to this file
already has the page's real selectors.

## Product
<your product>

## Demo goal
<the core flow, end to end>

## Audience
<who is this for>

## Tone
Friendly, practical, founder-style. Brisk.

## Length
~45-60 seconds.

## CTA
<what should the viewer do next>

---

## What inspect saw

Headings:
${headings.join("\n") || "- (none)"}

Interactive elements (unique selectors):

| role | name | selector | |
|---|---|---|---|
${cands.join("\n") || "| — | — | — | |"}
${res.iframes.length ? `\niframes: ${res.iframes.map((f) => `${f.name || "?"} → \`${f.selector}\``).join(", ")}\n` : ""}
Next: write the narration, replace the candidate hover with the real click +
\`assert\`, then \`aidemo probe\` (or the MCP \`probe\` job).
`;
}

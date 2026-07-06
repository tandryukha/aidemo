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

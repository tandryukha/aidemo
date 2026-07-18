# Storyboard design patterns for demos as code

July 18, 2026 · Demos as Code · 8 min read · https://aidemo.top/blog/storyboard-design-patterns/

> When the demo is a JSON file, authoring becomes a design-patterns problem: the moves that keep a storyboard readable, and the smells that wreck it.

**Key takeaways**

- Keep two channels apart: a scene's narration (what's heard) and its action-spec (what's clicked). That wall is what lets one recorded take render in five languages with no re-record.
- Seven patterns recur across vhs, Remotion, and browser storyboards; the two most underused are wait-on-a-condition (not a fixed sleep) and pre-navigate (end a scene on the click that opens the next).
- Rank the anti-patterns: the mega-scene forfeits the diff; the sleep-driven wait flakes in the least reviewable way, rendering a beat early on a slow runner instead of crashing.
- Worked refactor: split one mega-scene into three one-claim beats, and a copy edit becomes a one-scene diff, the pause becomes a condition wait, and role selectors survive a redesign.
- A pattern is a heuristic, not a rule (Kent Beck's 'code smell'): don't parameterize a one-off, and a 15-second single-screen clip needs one scene, not four.

## The two channels every storyboard keeps apart

A demo storyboard is a text file a machine executes, and like any such file it carries more than one kind of information at once. The most consequential design choice in the format is which kinds you let touch.

The declarative demo formats that hold up over time keep two channels strictly apart: the narration, meaning what a viewer hears, and the action-spec, meaning what the browser is driven to do. In the storyboard format for aidemo, the engine we build, a scene is a `narration` string sitting next to an `actions` array, and the actions never name the spoken words. That wall is not cosmetic. It is the reason one recorded take can ship in several languages at once: the take replays the action-spec, which mentions no words, so only the narration and captions have to localize, which is what turns [one recording into a matrix of localized renders](/blog/multi-language-product-demo-videos) ([aidemo, accessed July 2026](https://github.com/tandryukha/aidemo/blob/main/docs/AUTHORING.md)). Weld the sentence to the click and that property is gone.

Remotion draws the same boundary from the opposite direction. A Remotion composition is a reusable structure, and the data it renders arrives separately as input props that "will be merged together with default props, where input props have priority" ([Remotion, accessed July 2026](https://www.remotion.dev/docs/parameterized-rendering)). The composition is the how, the props are the what, and changing the props renders a different video from the same structure, which is the working definition of a template. Whether the pixels are captured from a real browser or drawn by React, the lesson holds: the thing you say and the thing you show are different data, and a storyboard that stores them as different data can be localized, personalized, and reviewed one channel at a time.

| Channel | Holds | Never holds | What the wall buys |
|---|---|---|---|
| Narration | the spoken script, per scene | selectors, timing, URLs | rewrite or translate the words with no re-record |
| Action-spec | ordered browser operations and waits | the sentences being spoken | replay the same flow under any narration |

Once you read a storyboard as channels instead of a screenplay, a small set of reusable patterns falls out, and so do their opposites.

## A pattern catalog for demo storyboards

The moves below recur across three unrelated declarative formats: Charmbracelet's vhs (terminal tapes), Remotion (React video), and browser-capture storyboards. A pattern earns a name when the same move solves the same problem in formats that never talked to each other.

| Pattern | The problem it solves | How the formats express it |
|---|---|---|
| One idea per scene | a viewer holds one claim at a time; a reviewer diffs one beat | a single narrated claim per scene, four to six scenes for a 45-second demo |
| Wait on a condition | timing varies run to run, so a fixed pause is a race | `Wait /regex/` over `Sleep`; a wait that fires when the element actually appears |
| Pre-navigate the next scene | narration for screen N plays over screen N-1 | put the navigation click at the end of scene N-1 |
| Address by intent | a redesign rewrites classes and layout, not roles and labels | role and accessible name over `nth-child` or a hashed class |
| Parameterize the variable | one flow, many prospects or locales | Remotion input props; storyboard `{{placeholders}}` with declared defaults |
| Mark idle explicitly | a loading beat should be trimmed, not narrated over | tag the wait as trimmable idle so compose speeds or cuts it |
| Polish at compose time | a zoom or caption tweak should not cost a new take | keep zoom, transitions, and captions as post-processing over one recording |

The sequential-scene shape is not unique to captured demos. Remotion ships a `<Series>` component precisely to "stitch together scenes that should play sequentially," each `<Series.Sequence>` given its own `durationInFrames` before the next mounts ([Remotion, accessed July 2026](https://www.remotion.dev/docs/series)). One-idea-per-scene is that same discretization applied to meaning rather than time: a scene is the unit a viewer can absorb and a reviewer can approve in one read.

Two patterns are underused enough to earn a sentence each. *Wait on a condition* is the one every imperative recorder gets wrong. vhs, whose tapes are otherwise a linear script of `Type` and `Enter`, still ships a `Wait` command that "takes a regular expression as an argument" and blocks until the pattern appears on screen, exactly so a tape does not depend on a `Sleep` landing on the right frame ([Charmbracelet, accessed July 2026](https://raw.githubusercontent.com/charmbracelet/vhs/main/README.md)). Playwright makes the point structurally: it "auto-waits for all the relevant checks to pass and only then performs the requested action," confirming an element is visible, stable, and hit-testable before it clicks ([Playwright, accessed July 2026](https://playwright.dev/docs/actionability)). A storyboard should encode the same intent, a wait keyed to a condition, and reserve a fixed pause for a deliberate on-screen beat only. Making the browser replay identically under those waits is [its own determinism problem](/blog/deterministic-browser-automation-for-video), but the authoring move is simply to name the condition.

*Pre-navigate* is unique to narrated demos and invisible until it bites. If every scene opens by clicking its own way in, the cursor spends the first two or three seconds gliding across the previous screen, so scene N's narration plays over screen N-1. The fix is a reordering, not a feature: end each scene with the click that opens the next one, and every scene starts already on the screen its words describe. It is the storyboard equivalent of prefetching.

## Anti-patterns, ranked by what they cost

Kent Beck coined "code smell" while helping Martin Fowler with the Refactoring book, for "a surface indication that usually corresponds to a deeper problem in the system," with the caveat that smells "don't always indicate a problem" ([Fowler, accessed July 2026](https://martinfowler.com/bliki/CodeSmell.html)). Storyboards have smells with the same character: each one usually, not always, marks a coupling you will regret the week the product ships next.

| Anti-pattern | The smell | What it breaks | The refactor |
|---|---|---|---|
| The mega-scene | one scene, a paragraph of narration, eight actions | can't diff to a beat, can't retime, narration drifts from action | split into one-claim scenes |
| The sleep-driven wait | a fixed pause where a load should be awaited | flakes on a slow runner; races the server | wait on the condition, mark it idle |
| The hardcoded index | `nth-child(3)`, a magic scene index, a positional handle | a relayout moves the target; the cursor clicks empty space | address by role and accessible name |
| Narration welded to timing | hand-authored per-step durations | a two-word script edit desyncs the scene | let the engine time video to narration length |
| Selectors in the prose | a URL or class name inside the narration string | the demo can't localize; the channels are fused | move it to the action-spec |

The sleep-driven wait sits at the top of the flaky pile because it fails in the least reviewable way. A fixed two-second pause that passed on your laptop is a bet that two seconds also covers the load on a slower CI runner, and when the bet loses the video does not crash. It renders the flow arriving a beat early, which nobody notices until a buyer does. Both vhs and Playwright treat that fixed pause as the thing to design out, and the fix is always to name the condition you were really waiting for.

The mega-scene tops the overall list because it forfeits the entire reason to hold a demo as text. The payoff of a committed spec is that a change is a small diff a reviewer can read; a scene that does eight things at once diffs as a wall no reviewer can rule on. It is the storyboard version of the thousand-line function.

## Refactor: one mega-scene, split into beats

Here is the mega-scene, from a supplement-finder demo (the format here is ours, and browser-only):

```json
{
  "id": "s1",
  "narration": "Welcome to DemoFit, the supplement finder that searches your whole catalog, so just type what you want, hit search, open the first result, check the price, and add it to your cart.",
  "actions": [
    { "op": "goto", "url": "http://localhost:8787/" },
    { "op": "type", "target": { "selector": "#search" }, "text": "whey isolate under 30 euros" },
    { "op": "click", "target": { "selector": ".btn:nth-child(2)" } },
    { "op": "pause", "ms": 2000 },
    { "op": "click", "target": { "selector": ".result:nth-child(1) a" } },
    { "op": "click", "target": { "selector": ".card > button:nth-child(3)" } }
  ]
}
```

Five smells in one object: a run-on narration carrying four claims, an `nth-child` search button, a `pause` standing in for a load, a positional result link, and a positional add-to-cart button. Split it into beats, name the conditions, address by intent:

```json
[
  {
    "id": "search",
    "narration": "Tell DemoFit what you need in plain words.",
    "actions": [
      { "op": "goto", "url": "http://localhost:8787/" },
      { "op": "type", "target": { "selector": "#search" }, "text": "whey isolate under 30 euros" },
      { "op": "click", "target": { "selector": "[role=\"button\"][name=\"Search\"]" } }
    ]
  },
  {
    "id": "result",
    "narration": "It ranks the whole catalog and opens the best match.",
    "actions": [
      { "op": "waitForWidget", "target": { "selector": "[data-testid=\"result\"]" } },
      { "op": "click", "target": { "selector": "[data-testid=\"result\"]", "first": true } }
    ]
  },
  {
    "id": "cart",
    "narration": "One click adds it, price and all.",
    "actions": [
      { "op": "click", "target": { "selector": "[role=\"button\"][name=\"Add to cart\"]" } },
      { "op": "waitForChange", "target": { "selector": "[data-cart-bar]" }, "textMatches": "1 item" }
    ]
  }
]
```

Three things are now true that were false before. A copy edit lands in one scene's `narration` and touches nothing else. The `pause` is gone, so the demo no longer bets on a fixed two seconds. And every selector names its control the way a user would, so a redesign that reshuffles the markup leaves the flow intact. That last property is a discipline of its own, ranked in the [selector-resilience ladder](/blog/selectors-that-survive-redesigns); the point here is that the split is what made room to apply it.

The split unlocks the demo's second job too. Because each scene's actions are now a clean, condition-gated flow, running them against tomorrow's build with no voice and no encode is a fast check: a selector that stopped resolving is a failed step, which is how a storyboard doubles as [a golden-file regression test of the UI it depicts](/blog/testing-demos-like-code).

## When reaching for a pattern is the mistake

Fowler's caveat is load-bearing: a smell is a prompt to look, not a verdict. Every pattern above has a cost, and a demo with no future rarely earns it.

- A 15-second, single-screen clip does not need four scenes. One scene with one claim is the whole storyboard, and splitting it buys nothing.
- Do not parameterize a demo you will render once. Declaring `{{customer}}` and a defaults map is pure overhead until a second variant exists; add it the day you render the second prospect, not before, which is when the per-render abstraction finally pays for itself.
- A demo you will throw away next week does not need role-based selectors or a golden baseline. If the flow never re-runs, its selectors only have to survive one take.

The patterns earn their keep on the demo you keep: the one bound to a product that ships weekly, rebuilt in CI, reviewed like code, and increasingly [authored by a coding agent](/blog/coding-agents-that-make-demo-videos) that does its best work when the storyboard has a clean, channel-separated shape to fill in. On that demo, every pattern here is the gap between a spec a person can read and a wall nobody will. On a throwaway, a screen recording is faster and fine. The format behind these examples has real limits worth naming: it records a browser and nothing native, an agent writes the storyboard as text with no drag-and-drop timeline, and it ships no visual editor. Those constraints are also what make a storyboard the kind of text these patterns apply to. Deciding whether your demo is [a document you commit or a performance you record](/blog/demos-as-code) is the choice upstream of every pattern in this catalog.

## Sources

- [aidemo — AUTHORING.md, the storyboard schema and demo-director principles (ours)](https://github.com/tandryukha/aidemo/blob/main/docs/AUTHORING.md)
- [Remotion — Parameterized rendering (input props merge over default props)](https://www.remotion.dev/docs/parameterized-rendering)
- [Remotion — Series (stitch scenes that play sequentially, each with durationInFrames)](https://www.remotion.dev/docs/series)
- [Charmbracelet vhs — tape command vocabulary: Wait takes a regex, Sleep pauses capture, golden-file testing](https://raw.githubusercontent.com/charmbracelet/vhs/main/README.md)
- [Playwright — Actionability (auto-waits for visible, stable, receives-events, enabled checks)](https://playwright.dev/docs/actionability)
- [Martin Fowler — CodeSmell (a surface indication of a deeper problem; a heuristic, not a certainty)](https://martinfowler.com/bliki/CodeSmell.html)

## FAQ

### What is a demo storyboard?

A demo storyboard is a structured text file, usually JSON, that describes a demo as data instead of footage: an ordered list of scenes, each carrying the narration to speak and an action-spec of browser operations to perform. A deterministic player turns that file into a video, so the storyboard is the source and the MP4 is build output. Because it is text, it diffs in a pull request, regenerates when the product changes, and can be authored by a coding agent rather than performed by a person.

### How many scenes should a demo storyboard have?

Roughly one scene per idea, which for a 45-second demo lands at four to six scenes. The arithmetic behind that: spoken narration runs near 2.5 words per second in English, so a 6-second scene is about 15 words, which is enough for exactly one claim and its supporting action. If a scene's narration carries three claims or its action list runs past a handful of steps, it is a mega-scene and wants splitting, both so a viewer can follow it and so a reviewer can diff one beat at a time.

### Why shouldn't I put a fixed sleep in a demo script?

Because a fixed pause is a bet on timing that the demo loses silently. A `Sleep 2` that covers a load on your laptop can fall short on a slower CI runner, and the result is not a crash but a video where the next step fires before the screen is ready, which only a careful viewer catches. Both vhs and Playwright are built to avoid it: vhs offers a `Wait` keyed to a regex on screen, and Playwright auto-waits for an element to be actionable before acting. Encode the condition you are actually waiting for, and keep a deliberate pause only for an intentional on-screen beat.

# Selectors that survive a redesign

July 18, 2026 · Demos as Code · 7 min read · https://aidemo.top/blog/selectors-that-survive-redesigns/

> A demo pinned to nth-child and hashed CSS classes breaks the day a designer touches the layout. Here are the selectors that outlast a redesign.

**Key takeaways**

- A visual redesign rewrites presentation (classes, layout, DOM) and is constrained to preserve semantics (role + accessible name). Pin selectors to the half it cannot touch.
- Rank selectors by change type: role/name and text survive a restyle and relayout but break on a copy edit; data-testid survives cosmetic change; nth-child and hashed classes die on relayout.
- Worked case: a card moved to CSS-in-JS kept getByRole({name:"Upgrade"}) and getByText but broke .btn--primary and :nth-child(3) — half the selectors survived a full markup rewrite.
- For an icon-only or canvas target with no name, add aria-label first (it fixes accessibility and yields a user-facing handle); fall back to data-testid only where semantics run out.
- A demo needs more than a test: the selector must resolve AND land in a predictable spot for the cursor and zoom, so resilient selectors double as a near-free preflight drift check.

## A redesign rewrites the look and leaves the job alone

A visual redesign is a promise about what will not change. The team recolors, respaces, and re-lays out the interface, ships a new component library, swaps hand-written CSS for utility classes or a CSS-in-JS runtime. What it does not touch, on purpose, is the work the screen does. The Submit button still submits, the search field still searches, the account menu still opens the account menu. A redesign that changed those would not be a redesign, it would be a different product.

So a demo that breaks the morning after a redesign broke on the half that was contracted to change. The click that used to land on a button now lands on empty space, the cursor travels to the wrong spot, the narration describes a step that did not happen, and none of that is because the button left. It is because the selector was pinned to the paint, not to the plumbing.

That split has a name in the browser. What renders on screen is backed by two overlapping trees: the render tree of tags, classes, and geometry that a stylesheet owns, and the accessibility tree of roles and names that assistive technology reads. A redesign is free to rewrite the first and is strongly constrained not to break the second, because breaking it breaks screen readers. The W3C's first rule of ARIA is to reach for "a native HTML element ... with the semantics and behavior you require already built in" before repurposing markup ([W3C, accessed July 2026](https://www.w3.org/TR/using-aria/)), and an accessible name comes straight from the visible text, a label, or an `aria-label`, which is "the text associated with an HTML element that provides users of assistive technology with a label for the element" ([MDN, accessed July 2026](https://developer.mozilla.org/en-US/docs/Glossary/Accessible_name)). That is why a button stays a `button` named "Submit" across three restyles: the name is the element's contract with every user who cannot see it. Pin your selectors to the tree a redesign is not allowed to wreck, and most redesigns pass over the demo without touching it.

## Rank a selector by what a redesign can touch

"Resilient selector" is not one property, it is resilience against a specific kind of change. Sort the changes a redesign actually makes:

- **Restyle** — class names, colors, and spacing swap out while the DOM and text stay put. Moving to Tailwind or a CSS-in-JS library does this to every class name at once.
- **Relayout** — the DOM restructures: wrappers get added, elements reorder, a two-column grid becomes a stack. This is what breaks anything that counts position.
- **Recopy** — the visible words change, so "Submit" becomes "Save," or the app is localized and every label is now in German.
- **Refunction** — the control is genuinely removed or replaced. No selector should survive this, and one that does is lying to you.

Cross the common selector strategies against those four and the ranking stops being a matter of taste. A yes survives the change, a no breaks on it, and "breaks as it should" is the one case where a broken selector is the correct outcome.

| Selector strategy | Restyle | Relayout | Recopy | Refunction |
|---|---|---|---|---|
| Role + accessible name (`getByRole` with a name) | yes | yes | no | breaks as it should |
| Visible text or label (`getByText`, `getByLabel`) | yes | yes | no | breaks as it should |
| `data-testid` / `data-cy` | yes | yes | yes | breaks as it should |
| Semantic attribute (`#id`, `name=`, `type=`, `href`) | yes | yes | yes | breaks as it should |
| Structural CSS (`nth-child`, `>`, descendant chains) | yes | no | yes | no |
| Generated class (`.css-1q2w3e`, `.sc-bdVaJa`) | no | no | yes | no |
| Absolute XPath (`/html/body/div[2]/…`) | no | no | yes | no |

The three testing frameworks converge on the top rows for the same reason. Testing Library ranks `getByRole` first because it queries "every element that is exposed in the accessibility tree," and puts `getByTestId` last, only "for cases where you can't match by role or text," because "the user cannot see (or hear)" a test id ([Testing Library, accessed July 2026](https://testing-library.com/docs/queries/about/)). Playwright's rule is blunter: "Prefer user-facing attributes to XPath or CSS selectors," because "your DOM can easily change so having your tests depend on your DOM structure can lead to failing tests" ([Playwright, accessed July 2026](https://playwright.dev/docs/best-practices)). Cypress tells you not to target `id`, `class`, or `tag`, and not to "target elements that may change their textContent" ([Cypress, accessed July 2026](https://docs.cypress.io/app/core-concepts/best-practices)).

Read down the columns and two distinct failure modes separate out. The bottom three rows are the ones a routine restyle or relayout kills, and they are exactly the selectors an auto-generated recorder emits by default. The top two rows survive a redesign but die on a copy edit or a translation, which is fine for a single-locale demo and a live problem the day you localize the narration and the UI. Only the middle rows, an explicit attribute someone put there on purpose, survive everything short of the control being deleted.

## One card, before and after a redesign

Take a pricing card with an upgrade button, written first in hand-authored CSS:

```html
<div class="card card--pro">
  <h3 class="card__title">Pro</h3>
  <p class="card__price">$29/mo</p>
  <button class="btn btn--primary">Upgrade</button>
</div>
```

Four ways to grab that button, all of which work today:

```js
page.getByRole('button', { name: 'Upgrade' })    // role + name
page.getByText('Upgrade')                         // visible text
page.locator('.btn--primary')                     // class
page.locator('.card--pro > button:nth-child(3)')  // structure
```

Now the team adopts a component library and a CSS-in-JS runtime. Same card, same button, same word on it, but the markup is unrecognizable:

```html
<div class="css-1a2b3c" data-variant="pro">
  <div class="css-9z8y7x">
    <span class="css-4d5e6f">Pro</span>
    <span class="css-7g8h9i">$29/mo</span>
  </div>
  <button class="css-0j1k2l">Upgrade</button>
</div>
```

A wrapper `div` pushed the button out of position three, the class names are machine-generated hashes, and a library like styled-components, which "generates unique class names for your styles" by design ([styled-components, accessed July 2026](https://styled-components.com/docs/basics)), hands you a fresh hash the moment anyone edits the styles. Re-run the same four selectors:

| Selector | After the redesign |
|---|---|
| `getByRole('button', { name: 'Upgrade' })` | still one button named Upgrade |
| `getByText('Upgrade')` | the word did not change |
| `.btn--primary` | that class no longer exists |
| `.card--pro > button:nth-child(3)` | wrong parent, wrong index |

Half the selectors survived a change that touched every line of markup, and the half that survived is the half that describes the button the way a person does: the thing you click that says "Upgrade." The two that broke described it the way the old stylesheet happened to arrange it. Nothing about the redesign was hostile to the demo. The fragile selectors simply bet on the layer whose entire job is to change.

## When the element has no name to grab

The ranking assumes the thing you click carries an accessible name or stable text. Plenty of demo targets do not: an icon-only button, a chart or a `canvas`, a drag handle, a bare marketing hero, a third-party embed. For those the honest answer is the one every framework reaches for last on purpose, which is to add a hook.

The two ways to add one are not equal, and the better one fixes a real bug on the way. An icon button with no text is invisible to a screen reader too, so `aria-label="Delete row"` both names it for assistive tech and hands your selector a durable, user-facing handle in one move, since the same string then resolves as `getByRole('button', { name: 'Delete row' })`. Only when even that does not fit, a `canvas` or a purely decorative node, fall back to an explicit `data-testid`, which Cypress recommends precisely because it is "isolated from all changes" to CSS or behavior ([Cypress, accessed July 2026](https://docs.cypress.io/app/core-concepts/best-practices)). The tradeoff is real: a test id survives every cosmetic change but is invisible, so it can be dropped by someone who never knew a demo relied on it, and it asserts nothing about whether the visible label is still correct. Prefer the accessible name, and keep the test id for where semantics genuinely run out. Which elements deserve a permanent hook is an [instrumentation question that pays off for tests, agents, and demo capture at once](/blog/agent-friendly-app-instrumentation), not a demo-only tax.

## What a demo asks of a selector that a test does not

A passing test needs one thing from a selector: that it resolves to the right element. A demo needs two. It needs the selector to resolve, and it needs the element to sit in a predictable place, because a demo does not merely assert against the element, it moves a cursor to it, holds a beat, and often zooms the frame around it. A selector that resolves to a correct-but-relocated element turns a green check into a cursor gliding to the wrong corner on camera. That is the extra bar a redesign raises for footage specifically, and it is why "the selector still resolves" is necessary but not sufficient: resilience buys you the element, and [pinning the viewport, the clock, and the fonts](/blog/deterministic-browser-automation-for-video) buys you where it lands.

The payoff is that resilient selectors do double duty. Because a demo built as [a committed spec you rebuild rather than re-record](/blog/demos-as-code) re-runs its selectors on every render, the selector list is also a change detector: run the storyboard's actions against tomorrow's build with no voice and no encode, and any selector that stopped matching turns into a failed step instead of a broken video shipped to a buyer, which is the cheapest way to [catch a UI change before the demo lies about the product](/blog/detecting-ui-drift). This is also why the durable part of the work belongs at authoring time. When [a coding agent writes the storyboard](/blog/coding-agents-that-make-demo-videos), the highest-value thing it can do is verify every selector resolves against the live app and choose the role-and-name handle over whatever a screen scrape suggested, because a selector chosen well once survives the redesigns the demo will outlive. aidemo, the engine we build, leans on exactly this: its storyboards address elements by role, text, and test id and dry-run those selectors against the live UI as a preflight, so a redesign that moved a button fails loudly rather than rendering a cursor clicking nothing. The honest limits are worth stating plainly: it captures the browser and nothing native, the storyboard is authored by an agent instead of assembled in a visual editor, and there is no timeline you drag clips around in. Those constraints are the price of the property that matters here: a selector pinned to the accessibility tree is what keeps one storyboard recording the same demo across a year of restyles.

## Sources

- [W3C — Using ARIA, the First Rule of ARIA Use (prefer native HTML semantics)](https://www.w3.org/TR/using-aria/)
- [MDN — Accessible name (what it is and where it comes from)](https://developer.mozilla.org/en-US/docs/Glossary/Accessible_name)
- [Testing Library — About Queries and the query priority order (getByRole first, getByTestId last)](https://testing-library.com/docs/queries/about/)
- [Playwright — Best Practices (prefer user-facing attributes over CSS or XPath)](https://playwright.dev/docs/best-practices)
- [Cypress — Best Practices, Selecting Elements (use data-* attributes isolated from all changes)](https://docs.cypress.io/app/core-concepts/best-practices)
- [styled-components — Basics (generates unique class names for your styles)](https://styled-components.com/docs/basics)

## FAQ

### What is the most durable way to select a UI element for automation?

Match the element the way a user identifies it: by its role and its accessible name, for example a button named "Upgrade." That handle lives in the accessibility tree, which a visual redesign is constrained not to break because breaking it breaks screen readers, so it survives the class-name and layout churn that kills CSS and XPath selectors. When an element has no name, add an `aria-label` first and a `data-testid` only where semantics genuinely run out.

### Why did my demo break after a redesign when the app still works?

Because the selector was pinned to the presentation layer the redesign exists to change, not to the behavior it preserves. A redesign rewrites class names, spacing, and DOM structure while keeping the same buttons and labels, so a selector built on `nth-child` position or a generated class like `.css-1q2w3e` stops matching even though the button is right there doing its job. Rewrite those selectors to target the role, the accessible name, or an explicit test id and the same redesign passes over them.

### Should I add data-testid attributes just for a demo video?

Add them sparingly, and prefer an accessible name where one fits. A `data-testid` is the most change-proof hook because it is isolated from CSS and layout, but it is invisible to users, asserts nothing about the visible label, and can be deleted by someone who never knew the demo depended on it. Reach for `aria-label` on an unnamed control first, since it fixes accessibility and gives you a user-facing handle in the same edit, and reserve test ids for targets with no semantics at all, like a chart or a canvas.

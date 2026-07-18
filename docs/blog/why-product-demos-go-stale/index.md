# Why every product demo is out of date (and what rot costs)

July 18, 2026 · Demo Automation · 7 min read · https://aidemo.top/blog/why-product-demos-go-stale/

> Linear redrew every header, icon, and nav in one release, and every demo filmed before that day went wrong in every frame. This is how fast demos rot.

**Key takeaways**

- Linear, Figma, and Notion each ship a user-visible UI change most weeks; from public changelogs, Linear alone logged ~20 in the 11 weeks to July 2, 2026.
- A fast-shipping product's demo has a ~2-month half-life between redesigns — half its screens stop matching — and a redesign collapses that to zero on one day.
- Linear's March 12, 2026 UI refresh redrew every header, nav, and icon; every demo filmed before it was wrong in every frame overnight, not just the changed features.
- The real cost isn't re-recording hours, it's trust: a prospect who watches a demo the trial doesn't match reads neglect before the product says a word.
- Video rots worse than the doc screenshots shot-scraper was built to fix in 2022 — more frames, plus cursor path, timing, and narration to keep in sync.

## Reading the rot rate off a public changelog

A product demo freezes one version of your software and plays it back forever. The software does not hold still, and you can measure exactly how fast it moves, because the best-run companies publish the receipts. A public changelog is a dated ledger of everything that shipped, and for a product with a UI a large share of every entry is something a user can see — which makes it something a demo might show, and therefore something a demo can now get wrong.

Count them. In the eleven weeks from April 16 to July 2, 2026, Linear's changelog recorded about twenty user-visible changes: new initiative statuses, per-tab navigation history, private sub-teams, a native code-review view, drag-to-reorder groups in every list and board. That is roughly two a week, each a surface a walkthrough might feature ([Linear, accessed July 2026](https://linear.app/changelog)). Figma keeps a comparable tempo. Across the month from mid-June to mid-July 2026 its release notes list five user-visible releases, and the Config 2026 drop alone put a motion timeline, 3D transforms, and code layers on the canvas ([Figma, accessed July 2026](https://www.figma.com/release-notes/)). Notion ships a small feature most weeks and a numbered major version about every two months, 3.5 on May 13 and 3.6 on July 1, 2026, with a rebuilt mobile home in between ([Notion, accessed July 2026](https://www.notion.com/releases)).

| Product | Changelog window | User-visible changes | Cadence | Redesign inside the window |
|---|---|---|---|---|
| Linear | Apr 16 – Jul 2, 2026 (11 weeks) | ~20 | ~2 / week | Full UI refresh, Mar 12 |
| Figma | Jun 17 – Jul 16, 2026 (4 weeks) | ~5, plus the Config megadrop | ~1+ / week | Config 2026 canvas additions, Jun 24 |
| Notion | May – Jul 2026 | weekly feature, 3.5 to 3.6 | ~weekly, ~2-month major | Rebuilt mobile home, May 4 |

None of these three is a chaotic shipper. They are the products other teams cite as disciplined, and they still change what the user sees about twice a week. A demo you recorded once is standing still in a room where the furniture is rearranged on that schedule.

## From rot rate to demo half-life

Define a demo's half-life as the time until half its frames no longer match the live product. Two clocks run at once, and they run at very different speeds.

The slow clock is incremental drift. A typical sixty-second walkthrough shows a handful of surfaces — call it eight distinct screens. Not every changelog entry lands on one of them; a new admin toggle or an MCP connection may never appear in your cut. Say one user-visible change in four touches a surface your demo shows. At Linear's two-a-week, that is about one demoed surface drifting every two weeks, so four of eight — half — are wrong in roughly eight weeks. A two-month half-life, before anything dramatic happens. A demo recorded in January is contradicting the live product by three or four screens by March.

The fast clock is the redesign, and it does not tick, it detonates. On March 12, 2026, Linear redrew the whole interface in one release: "Headers, navigation, and view controls are now consistent across projects, issues, reviews, and documents," and "icons across the app have been redrawn and resized" ([Linear, March 2026](https://linear.app/changelog/2026-03-12-ui-refresh)). A change like that does not invalidate the few screens your demo features. It invalidates the chrome around every screen, so a demo captured on March 11 was wrong in every frame on March 12 — not half its frames, all of them. Figma's Config drops and Notion's mobile rebuild are the same species of event: one release resets the visual baseline the demo was filmed against.

So the honest half-life is bimodal. Between redesigns, a demo of a fast-shipping product decays with a half-life near two months. At a redesign, that half-life collapses to a single, unannounced date. Either way the demo you are proud of this quarter is a liability the next one, and you do not get to pick which quarter.

## Which parts of a demo rot fastest

Footage does not decay uniformly, and knowing the order lets you film defensively. Rank a demo's contents by how exposed each is to the changelog.

| What the frame shows | Rots when | Rate |
|---|---|---|
| Chrome: nav, headers, icons, color | any global redesign | rare but total — one release voids every frame |
| Feature surfaces: panels, menus, buttons | the feature ships an update | about monthly for a fast product |
| Seeded data: names, numbers, dates | the data reads as dated or the schema moves | slow, but glaring when it breaks |
| The core value flow: the job the product does | the fundamental workflow changes | slowest — this is the stable spine |

The lesson is not to show less. It is that the most durable demo leans on the core value flow and the least redesign-exposed chrome you can frame, so ordinary ships graze it rather than gut it. No framing survives a March-12-style refresh, which is why [what you choose to put on screen](/blog/how-to-make-a-product-demo-video) only delays the reckoning. It never cancels it, because the reckoning is maintenance.

## The trust cost: a demo the trial doesn't match

Re-recording hours are the visible cost, and [the case for regenerating demos instead](/blog/automated-product-demo-videos) does that arithmetic. The larger cost is quieter, and it lands on the prospect.

A demo's job is to set an expectation the product then has to meet. When the two disagree, the disagreement itself is the message. Picture a buyer who watches a crisp Linear walkthrough recorded in February, likes it, and signs up in mid-March. The app they reach has a redrawn navigation, resized icons, and a different visual rhythm than the video promised, because the March 12 refresh changed all of it. Nothing is broken. But the first thing the product taught them is that the marketing is out of date, and the second thing they wonder is what else is.

This is the documentation problem with a bigger blast radius. Simon Willison built the shot-scraper tool in 2022 for precisely this reason: "It's very easy for feature screenshots in documentation for a web application to drift out-of-date with the latest design" ([Willison, 2022](https://simonwillison.net/2022/Oct/14/automating-screenshots/)). One stale screenshot is a small lie a reader can route around. A demo video multiplies the surface: every frame can drift, and the cursor path, the timing, and the narration all have to keep matching the screen beneath them. When a demo goes wrong it goes wrong more visibly than a screenshot, and it is watched by people earlier in the funnel with less patience to forgive it.

## Drift is debt, and it compounds

Left alone, a demo is not a fixed cost. Every ship that touches a demoed surface widens the gap between what the video shows and what the product does, and that gap is a debt: you either pay it down by re-recording or you carry it and let every viewer see the interest. Unlike code debt, nothing goes red when a demo drifts. No test fails. The video just keeps playing, confidently wrong, until a human happens to notice — and the human who notices is usually a prospect, the worst possible auditor.

The market already concedes the pain. Trainn sells a demo tool whose headline promise is that when the UI changes you swap the outdated clips and it updates the video everywhere, "no re-recording needed" ([Trainn, accessed July 2026](https://trainn.co/product-demo-video-maker/)), a feature you build only if staleness is what customers fear most. It helps with a clip library a person still curates, but it does not touch the expensive step, which is diagnosis: knowing which of your videos the last release just falsified.

The only way to make the debt stop compounding is to stop treating the demo as a recording you own and start treating it as output you regenerate. If the flow is a committed specification rather than a captured take, a machine can replay it against the current build and produce a current video, so the re-render can ride the same release that caused the drift — the mechanics of that live in [rendering demo videos in CI](/blog/demo-videos-in-ci). Stills submit to the same treatment one level down, which is the subject of [automating product screenshots](/blog/automating-product-screenshots): a named shot re-captured from a spec cannot drift in silence. Our own engine, aidemo, is one browser-only, agent-authored instance of that pattern, and it earns its keep only on demos you mean to keep. The half-life does not change. What changes is who pays for it: a CI runner on the day of the ship, instead of a prospect three months later.

## Sources

- [Linear — Changelog](https://linear.app/changelog)
- [Linear — UI refresh (March 12, 2026)](https://linear.app/changelog/2026-03-12-ui-refresh)
- [Figma — Release notes](https://www.figma.com/release-notes/)
- [Notion — What's New / releases](https://www.notion.com/releases)
- [Simon Willison — Automating screenshots for the Datasette documentation (2022)](https://simonwillison.net/2022/Oct/14/automating-screenshots/)
- [Trainn — Product Demo Video Maker](https://trainn.co/product-demo-video-maker/)

## FAQ

### How often do SaaS products change their user interface?

Faster than most demos assume. Reading recent public changelogs, Linear shipped about twenty user-visible changes in eleven weeks (roughly two a week), Figma listed five in a month plus its Config megadrop, and Notion ships a small feature most weeks with a major version about every two months. For a normally fast product, budget one to two visible UI changes a week.

### How long does it take for a product demo video to go out of date?

Between redesigns, roughly two months to a half-life: at one to two visible changes a week, about half the screens in a typical eight-surface demo no longer match within eight to ten weeks. A full redesign resets that instantly. Linear's March 12, 2026 refresh redrew every header, icon, and navigation element, so any demo filmed before it was outdated in every frame overnight.

### Do outdated screenshots and demo videos hurt conversion or trust?

They cost more than the re-recording time. A demo sets an expectation the trial has to meet, and when a prospect signs up to find an interface that looks nothing like the video, the first thing the product communicates is that the marketing is stale. Tools like shot-scraper exist because drifted documentation screenshots erode credibility, and a demo video, with far more frames to drift, carries the same risk to a warmer, earlier-funnel audience.

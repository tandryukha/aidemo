# Keeping a tutorial video library current at scale

July 18, 2026 · Video Documentation & Tutorials · 7 min read · https://aidemo.top/blog/keeping-tutorial-libraries-current/

> Two hundred tutorials meet one redesign, and the re-record backlog no docs team gets funded to clear. Here is the maintenance math, and the one way out.

**Key takeaways**

- A fast-shipping product's UI changes 1-2 times a week (GitHub's changelog: ~25-30/week in July 2026), so a tutorial library needs re-recording ~1.3 times over per year.
- The maintenance bill is linear: ~2 hours per video per year, so a 200-clip library burns ~390 hours (~10 FTE-weeks) annually just to stop lying about the product.
- Three options: accept the rot (paid in trust), prune aggressively (HubSpot cut ~3,000 pages and traffic rose), or regenerate every clip from a committed spec.
- Pruning only shrinks library size, so cost stays linear; regeneration decouples it, one CI run re-renders 20 clips or 2,000 for the same human hours.
- A spec costs ~3h to write vs ~1.5h to record once, but pays back after a single re-record (inside year one for a fast shipper), then costs only CI minutes.

## The re-record backlog that closes video programs

Ask a docs team why they stopped shipping tutorial videos and the answer is rarely "nobody watched them." It is that the library got big enough to become a liability. A dozen clips are a nice-to-have you re-shoot on a slow Friday. Two hundred clips are a standing obligation, and the day a designer renames the navigation or reworks the empty state, every one of them is a little bit wrong at once. The cost of a video library is not the recording. It is the derivative: how fast the product moves, times how many videos you own.

That derivative is why the [pillar case for video documentation](/blog/video-documentation) treats maintenance, not production quality, as the thing that sinks most programs. A single stale clip is a nuisance. A shelf of them is an accusation, a whole wing of the product's own documentation quietly contradicting the product. And unlike a broken build, nothing turns red. The videos keep playing, confidently narrating a button that moved, until a user files a ticket asking why the app looks nothing like the help center. This piece is about the arithmetic underneath that failure, and the three things you can do about it.

## Sizing the maintenance debt in hours, not vibes

Start with the two numbers that set the bill: how fast your interface moves, and how many videos it can falsify.

Ship velocity is measurable. [How fast a demo actually rots](/blog/why-product-demos-go-stale) works the rate off public changelogs: a disciplined mid-size SaaS changes something a user can see roughly one to two times a week, which gives any single clip a half-life of roughly two months between redesigns, collapsing to one unannounced day whenever the team reskins the app. Bigger platforms move faster. GitHub's public changelog posted on the order of twenty-five to thirty user-visible product changes a week across July 1-17, 2026, a rebuilt repository overview, a pull-request archive, mobile changes, at a company whose docs and video library run to the thousands ([GitHub, accessed July 2026](https://github.blog/changelog/)).

Now multiply. Two rot clocks run against a library at once. The slow one is incremental drift: feature surfaces move, and over a year a meaningful share of any clip picks up at least one change worth re-shooting for. The fast one is the redesign, which does not tick, it detonates, one release redrawing the chrome behind every clip on the same day. Budget one visual refresh a year, conservative for a fast shipper, and it alone demands N re-records. Add incremental drift on, say, a third of the remaining clips and the annual demand lands near 1.3 times the whole library. A fast-shipping product asks you to re-record its entire tutorial library, and then a bit more, every single year.

Put hours on it. A short tutorial clip is not free to redo: you diagnose what changed, re-shoot the flow, re-edit, re-record the narration, re-sync captions, and re-publish, call it one to two hours each, more honestly than the "just re-record it" hand-wave suggests. At 1.5 hours a clip and 1.3 re-records per clip per year, the bill is roughly two hours per video per year.

| Library size | Full re-records demanded / year (~1.3x) | Maintenance hours / year (~2h x N) | In FTE-weeks |
|---|---|---|---|
| 40 clips | ~52 | ~80 | ~2 weeks |
| 120 clips | ~156 | ~235 | ~6 weeks |
| 200 clips | ~260 | ~390 | ~10 weeks |

Ten weeks of one person's year, producing zero net-new content, just to stop the library from lying. That is the line item nobody writes into the plan, and it is why the library quietly stops growing at whatever size the team can bear to babysit. Plug your own N and ship rate in; the shape does not change. The human cost is linear in the size of the thing you built.

## Three strategies, and only one that scales with the library

There are three honest responses to that bill. You can pay it in trust, pay it in headcount, or refuse the premise that a video is a recording you maintain.

| Strategy | Up-front cost | Recurring cost | Scales with library? | Coverage you can sustain | Honest when |
|---|---|---|---|---|---|
| Accept the rot | none | none in cash, all in trust | irrelevant, everything drifts | any size, all of it aging | archival or clearly-dated content only |
| Prune aggressively | an audit | a quarterly re-audit | linear, bigger library, bigger audit | small and curated | you can bear a deliberately small library |
| Regenerate from source | write the specs | CI minutes | flat in human hours | large | the product ships from a repo you control |

Accepting the rot is the default nobody chooses on purpose; you back into it the first time a redesign outpaces the team. It is defensible for content you date and freeze ("here is the 2024 flow") and indefensible for a help center a paying user trusts today. Pruning and regenerating are the two real strategies, and they answer different questions: pruning asks how small the library should be, regeneration asks how the library rebuilds. The rest of this piece takes each in turn.

## What pruning buys, and where it stops

Pruning is underrated and it works. HubSpot deleted about 3,000 pages from its blog in a single audit and watched traffic climb rather than fall, partly because a leaner corpus indexed faster and stopped cannibalizing itself ([HubSpot, accessed July 2026](https://blog.hubspot.com/marketing/remove-outdated-content)). The same logic transfers to a video library: most tutorial clips get almost no views, cover a flow that barely changed, or duplicate a paragraph that reads faster than the clip plays. Cutting them is not loss, it is focus.

A workable triage keeps a clip only when it clears two bars at once: it earns its views, and it shows a flow stable enough to survive an ordinary sprint. Rank every video by watch-through and by rot exposure. A clip of a settings page that gets reworked quarterly is a maintenance sink no matter how good it is, while a clip of the core value flow that rarely changes is worth keeping. Deciding which clips a given release actually falsified is its own discipline, and a cheap one: a selector probe against the live build tells you which flows broke before a human watches a single frame, which is the subject of [detecting UI drift](/blog/detecting-ui-drift). Run the audit on a cadence, quarterly is the going rate for content pruning, so the library shrinks back to sustainable between growth spurts.

Here is where pruning stops. It attacks the wrong variable. The bill is ship rate times library size, and pruning can only shrink the second factor. You buy a smaller number to multiply, not a smaller multiplier, so the cost stays linear: a curated 60-clip library still bleeds three-plus FTE-weeks a year, and every clip you were forced to cut is a question a user now has to answer some other way. Pruning lets you afford a small library honestly. It cannot let you afford a large one.

## Regeneration decouples the bill from the library size

The only strategy that changes the shape of the cost, rather than the size of one input, is to stop treating a tutorial as a captured performance and treat it as output you rebuild from a committed source. This is not exotic. It is what every other artifact in your docs already does. The [Write the Docs testing guide](https://www.writethedocs.org/guide/tools/testing/) puts documentation checks "on each commit of your project" through continuous integration so the docs stay "in a consistent state," and Simon Willison built shot-scraper in 2022 for the image version of this problem, because feature screenshots in a web app's docs drift out of date as the design moves; you declare the shots in a YAML file once and regenerate them all with one command ([Willison, 2022](https://simonwillison.net/2022/Oct/14/automating-screenshots/)). Video is the same move one level up: describe the flow once as a spec, and let a machine replay it against the current build to emit a current clip. The full case for [regenerating demos instead of re-recording them](/blog/automated-product-demo-videos) lays out the mechanism.

Watch what that does to the arithmetic. Writing a spec costs more than a single recording, call it three hours against one and a half, because you are encoding intent rather than performing it once. But after the spec exists, a re-render is CI minutes and roughly zero human hours. Per clip, the spec pays for itself after a single re-record, which for a fast-shipping product arrives inside the first year. The library-level effect is the one that matters: a single CI run re-renders every spec, so the human cost of a redesign is fixed whether you own 20 clips or 2,000. The two-hours-per-video-per-year line goes flat. You wire it to the same triggers your other jobs use, a push that touches a UI path, a nightly cron (GitHub Actions caps scheduled runs at once every five minutes and warns they "can be delayed during periods of high loads," so a 4am rebuild is fine and a to-the-second promise is not), and a manual dispatch for the human in a hurry ([GitHub, accessed July 2026](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows)). The [CI plumbing](/blog/demo-videos-in-ci) and the [nightly rebuild habit](/blog/nightly-demo-builds) are where the runner specifics live.

Our own engine, aidemo, is one instance of this pattern, and it belongs in a docs pipeline only on honest terms: it is ours, it captures a browser and nothing else, its storyboards are written by a coding agent rather than dragged together on a timeline, and it ships no GUI editor. It fits a team that keeps its flows in a repo and wants them to rebuild on the ship that broke them, not a one-off marketing reel. The tool is incidental. The principle is that a tutorial library stays current at scale only if "the product changed" and "the video is current" are the same event, which is possible only when the video is a function of a source you commit, not a file you babysit.

## Sources

- [GitHub — Changelog](https://github.blog/changelog/)
- [HubSpot — Why We Removed 3,000 Pieces of Outdated Content From the HubSpot Blog](https://blog.hubspot.com/marketing/remove-outdated-content)
- [Write the Docs — Testing your documentation](https://www.writethedocs.org/guide/tools/testing/)
- [Simon Willison — Automating screenshots for the Datasette documentation (2022)](https://simonwillison.net/2022/Oct/14/automating-screenshots/)
- [GitHub Actions — Events that trigger workflows](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows)

## FAQ

### How do you keep a tutorial video library up to date?

Pick a maintenance model before the library outgrows your ability to re-shoot it by hand. For a small, curated set you can prune on a quarterly audit and re-record the survivors. Past a few dozen clips the only model that holds is regeneration: commit each flow as a spec, wire a CI job to re-render on the commits and the nightly cron, and "the product changed" and "the video is current" become one event instead of a backlog.

### When should you delete a tutorial video instead of updating it?

Delete it when it fails either of two tests: nobody watches it, or it covers a surface that changes so often that keeping it current costs more than the coverage is worth. HubSpot removed about 3,000 pages in one audit and saw traffic rise, because a leaner library indexes better and stops competing with itself. A clip of a rarely-used settings page that gets reworked every quarter is a maintenance sink; cut it and answer the question in text.

### How much time does maintaining a video tutorial library take?

More than teams budget. A short tutorial clip takes roughly one to two hours to diagnose, re-shoot, re-edit, re-narrate, and re-publish, and a fast-shipping product falsifies its whole library about 1.3 times a year. That works out to around two hours per video per year, so a 200-clip library costs on the order of 390 hours, about ten weeks of one person's time, annually, just to keep it honest.

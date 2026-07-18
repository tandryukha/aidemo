# Nightly demo builds: re-render the demo while you sleep

July 18, 2026 · Demo Automation · 7 min read · https://aidemo.top/blog/nightly-demo-builds/

> Compilers rebuild themselves overnight so breakage lands in a log, not a release. Point the habit at your demo and it quits quietly lying about the product.

**Key takeaways**

- Borrow the compiler habit: Chrome Canary ships daily and Firefox Nightly once or twice a day, so a nightly demo build surfaces UI drift the next morning, not in a customer call.
- A nightly catches drift an on-merge path filter can't: a restyled third-party embed, a dependency bump, changed seed data, a flipped feature flag — none touch a file in src/.
- Green is not correct: fail the build on a broken storyboard selector, open a PR on a pixel diff a human should approve, auto-publish only low-stakes assets like a README GIF.
- Cost is a rounding error: 30 nightly runs at ~5 min = 150 runner-minutes/month, well under GitHub's free 2,000; public repos are free, Linux extra minutes $0.006 each.
- Two silent-stop traps: GitHub delays cron at the top of the hour (schedule 3:17, not 3:00) and disables a public repo's schedule after 60 days of no activity.

## The daily build, pointed at a demo instead of a binary

Compiler teams solved this problem thirty years ago and named the fix after the clock. A nightly build takes whatever code is in the tree and rebuilds the whole thing overnight, so any breakage introduced during the day is sitting in a log the next morning instead of hiding until release. Joel Spolsky made the case in 2001: run the build on a schedule, keep every one in an archive, and when a strange bug appears you can binary-search the history to find the day it entered ([Spolsky, 2001](https://www.joelonsoftware.com/2001/01/27/daily-builds-are-your-friend/)). Browser vendors turned the same habit into a shipping channel. Chrome Canary "is released daily" ([Chrome for Developers, accessed July 2026](https://developer.chrome.com/docs/web-platform/chrome-release-channels)); Firefox Nightly "will update approximately once or twice a day" and exists as an unstable platform for surfacing problems in the newest code ([Mozilla, accessed July 2026](https://www.firefox.com/en-US/channel/desktop/)). All three do one thing: rebuild the artifact against the current world on a fixed cadence, and let the schedule, not a person's memory, be what never forgets.

A product demo is exactly the kind of artifact that benefits, because it depends on something it does not own. The video froze one state of a UI that keeps moving, which is [why every product demo drifts out of date](/blog/why-product-demos-go-stale) whether or not anyone touches the file. A nightly demo build applies the compiler reflex: a scheduled job re-runs the recording against the live app every night, so the morning after a change lands you either have a fresh, correct demo or a red build telling you the old one has become a lie. It only works if the demo is a spec you can [regenerate from source instead of re-recording by hand](/blog/automated-product-demo-videos) — a captured performance cannot rebuild itself, but a committed storyboard can.

## What a nightly catches that an on-merge render can't

The obvious trigger is on-merge: filter a workflow to your UI source and re-render the moment a relevant file lands, which catches code-driven drift at the lowest possible latency. That wiring — the runner, ffmpeg, the path filter, and where the finished file goes — is a job of its own, covered in [rendering demo videos in CI](/blog/demo-videos-in-ci). But a path filter only sees your repository, and a demo leans on more than your repository. Whole classes of drift never touch a file you would think to filter on:

- A third-party widget you embed (a chat launcher, a payment form, a map) restyles itself on the vendor's deploy, not yours.
- A dependency bump moves a component's padding or default variant, and the change rides in through the lockfile, not through anything you edited.
- The seed data behind the demo changes shape, so a table that had three rows now has none, or a chart flattens to a single bar.
- A feature flag flips on its own timer, hiding or revealing the exact button the cursor is about to click.
- An external API changes a field the UI renders, and the screen the demo depends on now shows an error state.

None of these arrive as a diff in `src/`, so an on-merge trigger stays silent while the demo quietly goes wrong. A wall-clock rebuild is the only trigger that sees them, which is why compiler teams kept the nightly even after per-commit CI existed: the nightly is the integration check, the per-commit run is the unit check. Turning that render into a pass-or-fail verdict rather than a fresh file nobody looks at is its own discipline, laid out in [detecting UI drift](/blog/detecting-ui-drift).

## The cron line, and the two ways GitHub silently stops it

The scheduling itself is one block. GitHub Actions reads standard cron, in UTC by default, so a nightly at 3:17 a.m. is:

```yaml
on:
  schedule:
    - cron: "17 3 * * *"   # 03:17 UTC, every night
  workflow_dispatch:        # plus a manual button
```

The odd minute is deliberate. GitHub warns that the schedule event is delayed when workflow load is high and flags the top of every hour as the busiest window, so a job pinned to `0 3 * * *` queues behind everything else that chose the round number ([GitHub Docs, accessed July 2026](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)). A nightly does not need to be punctual, but it should not wait behind the whole platform either.

Two failure modes are specific to a job meant to run for months unattended, and both are silent. The first is that same delay: a nightly that "did not run" often did run, late, and you checked before it landed. The second is worse. In a public repository, GitHub automatically disables a scheduled workflow after 60 days with no repository activity ([GitHub Docs, accessed July 2026](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)) — so the nightly on your stable, finished side project switches off right when the product is most likely to shift under it without you watching. A nightly you cannot trust to run is worse than none, so give the workflow a heartbeat: have it post to a channel on success, not only on failure, so a silent stop becomes its own alarm.

## Green is not the same as correct: what a nightly does with a diff

A nightly that re-renders and publishes unconditionally has only swapped yesterday's stale demo for today's unreviewed one. The value is entirely in what the job does with the difference it finds, and the right move depends on how much judgment that difference demands. Two facts decide it: whether the change is ambiguous (a broken selector is not; a shifted gradient is) and how public the asset is (a landing-page hero versus a GIF in an internal runbook). That yields four exits.

| What the nightly found | Ambiguous? | Right exit | Fits |
|---|---|---|---|
| A storyboard selector no longer resolves | No — the flow is broken | Fail the build red | Every demo |
| Pixels moved past threshold, flow still runs | Yes — needs an eye | Open a PR with the new render | Public, marketing, sales assets |
| Pixels moved, the asset is low-stakes | No — newest wins | Auto-commit and publish | README GIF, internal docs |
| Nothing changed | No | Do nothing (but log the heartbeat) | All |

The first two rows carry the whole idea: an assertion failure is a fact, a pixel diff is an opinion. A selector that no longer resolves means the cursor lands on empty space and the voiceover narrates a click that never happens, so the build should go red and block with no human vote required. A pixel difference means something merely looks different, which could be an intended redesign or could be breakage, so the honest response is a pull request that puts the new cut in front of a person rather than a bot overwriting the live asset on a guess. Producing that pixel signal cleanly, without paging you over anti-aliasing, is a tuning problem mapped in [the visual-regression tools compared by diff engine](/blog/visual-regression-testing-tools); the nightly's job is only to decide what each verdict is allowed to do.

## The arithmetic of running it every night

The instinct is that rendering a video every single night must be expensive. It is not, and the numbers are worth writing down because they change which trigger you should argue about. A GitHub-hosted Linux runner bills extra minutes at $0.006 each, and every account carries a monthly free grant — 2,000 minutes on the Free plan, 3,000 on Pro and Team, 50,000 on Enterprise — while standard runners on public repositories are free outright ([GitHub Docs, accessed July 2026](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). Call a full browser render five minutes, generously. A drift-checking nightly is cheaper still, because it need not re-voice anything: text-to-speech is deterministic from the script, so when the narration text is unchanged the render is browser capture plus compose, with no paid speech call at all. In our own engine, aidemo — disclosed as ours, and honestly browser-only, with storyboards written by a coding agent instead of clips arranged on a GUI timeline — the voice and caption stages are skipped when the script has not changed, so a nightly's marginal cost is a handful of runner-minutes and nothing else.

Put the cadences side by side.

| Cadence | Runs / month | Runner-minutes (~5 min each) | Against Free 2,000 | Extra cost on Linux |
|---|---|---|---|---|
| Nightly cron | 30 | 150 | 7.5% of the grant | $0 |
| On-merge, ~40 UI merges | 40 | 200 | 10% | $0 |
| On-merge, ~300 UI merges | 300 | 1,500 | 75% | $0 |
| On-merge, ~600 UI merges | 600 | 3,000 | over by 1,000 | ~$6 |

The nightly is fixed at 30 runs no matter how fast the team ships; only the busiest on-merge case even leaves the free grant, and it does so for the price of a sandwich. On a public repo the entire dollar column is zero. So cost is not the axis. The real tradeoff is latency versus review noise: on-merge catches drift within minutes but hands you a diff to inspect on every merge and stays blind to the non-code drift above, while the nightly batches a whole day's changes into one review the next morning and sees the drift a filter cannot, at the price of up to a day of latency. The mature answer is both, cheaply — a fast selector assertion on every merge that blocks in seconds without encoding a single frame, plus the full nightly render-and-diff for everything the assertion cannot see. If you also [pin a demo to each shipped version](/blog/versioned-demos-per-release), the nightly guards the current one while the tagged ones stay frozen. The demo tells the truth in the morning because something rebuilt it in the dark, and a build log is the first place a break shows up, before any prospect sees it.

## Sources

- [Joel Spolsky — Daily Builds Are Your Friend (Joel on Software, 2001)](https://www.joelonsoftware.com/2001/01/27/daily-builds-are-your-friend/)
- [Chrome for Developers — Chrome release channels (Canary released daily)](https://developer.chrome.com/docs/web-platform/chrome-release-channels)
- [Mozilla — Firefox Nightly channel (updates once or twice a day)](https://www.firefox.com/en-US/channel/desktop/)
- [GitHub Docs — Events that trigger workflows (schedule cron, high-load delay, 60-day auto-disable)](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [GitHub Docs — Billing for GitHub Actions (free minutes, per-minute rates)](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## FAQ

### Should a demo re-render on every merge or only nightly?

Both, because they catch different failures. An on-merge trigger scoped with a path filter to your UI source re-renders within minutes of a code change and is the fastest way to catch drift you shipped yourself. A nightly cron catches the drift a path filter cannot see — a restyled third-party embed, a dependency bump, changed seed data, a flipped feature flag — none of which touch a file you would filter on. Run a cheap selector assertion on every merge and the full render-and-diff nightly.

### What time should a nightly demo build run on GitHub Actions?

Off the top of the hour, in UTC. GitHub cron defaults to UTC and delays scheduled jobs under load, calling the start of each hour the busiest window, so `17 3 * * *` (03:17 UTC) waits in a shorter queue than `0 3 * * *`. Add a `workflow_dispatch` trigger for manual runs, and remember that a public repository disables a scheduled workflow after 60 days with no activity, so a success notification is how you learn it stopped.

### Does re-rendering a demo every night cost a lot in GitHub Actions minutes?

No. Thirty nightly runs at roughly five minutes each is about 150 runner-minutes a month, well inside every plan's free grant (2,000 minutes on Free, 3,000 on Pro and Team), and standard runners on public repositories are free outright. Linux extra minutes are $0.006 each, so even a run that overshot the grant by 1,000 minutes would cost about six dollars. A drift-check render is cheaper still, since deterministic text-to-speech lets an unchanged script skip the paid voice step entirely.

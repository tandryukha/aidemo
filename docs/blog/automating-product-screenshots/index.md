# Automating product screenshots for docs and marketing

July 18, 2026 · Demo Automation · 7 min read · https://aidemo.top/blog/automating-product-screenshots/

> The complete stills playbook: one YAML for every screenshot, a pull request that recaptures them on a schedule, and a visual regression test you get for free.

**Key takeaways**

- A screenshot set is the cheapest demo automation to ship: shot-scraper's `shot-scraper multi shots.yml` renders every named still from one diffable YAML file (Apache-2.0, built on Playwright).
- Four Playwright options make a docs shot deterministic: fullPage, clip, mask (blank live or private data), and animations:'disabled' to freeze mid-fade frames.
- The Heroshot pattern closes the loop: a scheduled GitHub Action recaptures headlessly, commits, and opens a PR so a human reviews the visual diff before merge.
- A deterministic screenshot set is already a visual regression test — Playwright's toHaveScreenshot diffs each run against a baseline via pixelmatch; --update-snapshots accepts intended changes.
- Stills beat video where the surface renders images: the App Store allows 1-10 screenshots per device and locale and treats the preview video as optional (Apple, 2026).

## A screenshot is a demo video with the frames thrown away

A product screenshot is the smallest unit of demo media, and by far the cheapest to keep honest. Everything the [pillar on regenerating demos instead of re-recording them](/blog/automated-product-demo-videos) argues about video is true of stills with far less machinery behind it: no narration to re-voice, no timeline to trim, no ffmpeg graph to babysit. If you have never automated any product media, a named-screenshot set is the place to start, because the whole pipeline is a config file and one command, and it earns its keep the first time a button moves.

The reason to bother is volume. A marketing page localized to eight languages with five hero shots each is 40 images. An App Store listing that ships for the 6.9-inch iPhone and the 13-inch iPad, across eight locales, at up to ten screenshots per device, is as many as 160 required stills ([Apple, 2026](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/)) — and Apple treats the preview video as optional while the screenshots are mandatory. Nobody captures 160 images by hand once, let alone every release, and every one of them lands stale the day a designer nudges a color token. What it costs to let those images [drift out of date](/blog/why-product-demos-go-stale) is a separate story; this one is about the pipeline that stops it before a customer ever sees the gap.

## One YAML file, every screenshot in your docs

The cleanest place to start is Simon Willison's shot-scraper, a Playwright-based CLI first released in March 2022 ([Willison, 2022](https://simonwillison.net/2022/Mar/10/shot-scraper/); [repo, Apache-2.0](https://github.com/simonw/shot-scraper)). Its multi-shot mode reads a YAML file where each entry is one named still, and `shot-scraper multi shots.yml` renders all of them in a single pass:

```yaml
#shots.yml — one entry per named still
- output: dashboard-hero.png
  url: https://app.example.com/dashboard
  width: 1280
  height: 720
  wait: 800

- output: billing-card.png
  url: https://app.example.com/settings/billing
  selector: "#billing-card"
  padding: 24
  javascript: |
    document.querySelector('.cookie-banner')?.remove()

- output: pricing.png
  url: https://example.com/pricing
  height: 900
  quality: 80
```

Every key earns its place. `selector` crops to one element instead of the whole viewport; `padding` gives that element breathing room; `javascript` runs before the shot so you can dismiss a cookie banner or open a menu; `wait` holds for the page to settle ([shot-scraper docs](https://shot-scraper.datasette.io/en/stable/multi.html)). The file is plain text, so it diffs, it reviews, and it lives next to the code it documents. shot-scraper also ships a template repo that runs the same YAML on a GitHub Actions schedule, so the machine that has the browser installed is not your laptop.

## The four screenshot options that separate a docs shot from a snapshot

shot-scraper leans on Playwright underneath, and if you drive Playwright directly, four of its `page.screenshot()` options decide whether a shot is publishable or merely captured ([Playwright docs](https://playwright.dev/docs/api/class-page#page-screenshot)):

| Option | What it does | Why a docs shot needs it |
|---|---|---|
| `fullPage: true` | Captures the whole scrollable page, not just the viewport | Long pricing tables and settings pages fit in one frame |
| `clip: {x,y,width,height}` | Restricts capture to a pixel rectangle | Frame a single card or region with no wrapper element |
| `mask: [locator]` | Replaces a locator with a solid box (pink by default, `maskColor` to change) | Blank a live clock, a real user name, or a session token so the shot is reproducible |
| `animations: 'disabled'` | Stops CSS animations and transitions | Kills the mid-fade frame that makes every run look different |

The last two matter more than they read. `mask` and `animations: 'disabled'` are what turn a screenshot from a thing that changes on every capture into a thing that changes only when the product does — which is the exact property the rest of this playbook depends on.

## Regenerate on a schedule, land the diff as a pull request

Declarative shots are only half the win. The other half is a loop that reruns them without a human remembering to. Heroshot (MIT, `npx heroshot`) is built around precisely that loop ([Heroshot README](https://github.com/omachala/heroshot/blob/main/README.md)): you define each shot once with a point-and-click picker, it saves them to a `.heroshot/config.json`, and a headless `npx heroshot` regenerates every image — fanning one definition out to six variants (desktop, tablet, mobile, each in light and dark). The step that closes the loop is a GitHub Actions workflow that recaptures, commits the changed PNGs, and opens a pull request.

That auto-PR is the review gate, and it is the whole reason the loop is trustworthy. A scheduled render on its own would silently overwrite your images; a pull request puts the visual diff in front of a person before anything merges. GitHub Actions allows a `schedule` trigger as often as every five minutes, though scheduled runs are delayed at the top of every hour under load and are auto-disabled after 60 days of no activity on a public repo ([GitHub Actions docs](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)) — so a daily or on-deploy cadence is the sane setting, never a five-minute one. The [CI runner mechanics](/blog/demo-videos-in-ci) are the same as for video, minus most of the weight, since a still needs no audio, no fonts, and no encode. Heroshot is young and small next to shot-scraper; reach for it when you want the picker and the ready-made PR workflow, and for shot-scraper when you want plain-YAML control.

## The same run that refreshes the docs can also fail the build

Here is the part almost nobody wires up: a deterministic screenshot set is already a visual regression suite, at no extra cost. Playwright's own test runner makes the equivalence explicit. `expect(page).toHaveScreenshot()` writes a baseline PNG on its first run — stored as `<test>-snapshots/<name>-<browser>-<platform>.png` — and every later run diffs the fresh capture against that baseline with the pixelmatch library, tuned by `maxDiffPixels`, `maxDiffPixelRatio`, and `threshold` ([Playwright docs](https://playwright.dev/docs/test-snapshots)). When a change is intended, `--update-snapshots` rewrites the baseline.

Point the same shots you publish at a stored baseline and the arithmetic changes shape: an unexpected pixel delta turns the build red, and an intended one is accepted in the same pull request that ships the new docs image. The masks and disabled animations from the section above are exactly what keep that signal clean instead of firing on every timestamp, which is why [deterministic replay](/blog/deterministic-browser-automation-for-video) — waiting on page state rather than sleeping on a timer — is the load-bearing discipline underneath all of this. One capture, two jobs: it refreshes the marketing image, and it guards against the change you did not mean to ship.

## When a set of named stills beats a video outright

Motion is not always the right medium, and knowing when to skip the video saves the entire production. The rule keys off the surface, not the content:

| Surface | Reach for | Because |
|---|---|---|
| App Store / Play listing | Stills | Screenshots are required per device and locale; the preview video is optional ([Apple, 2026](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/)) |
| Documentation page | Stills | Readers scan and copy; they do not press play to find one panel |
| Localized marketing | Stills | N locales times M shots is a render matrix; a video is N re-voiced takes |
| Email, PDF, print | Stills | An `<img>` renders everywhere a `<video>` is awkward or dead |
| A flow, a drag, a live update | Video | The meaning lives in the change between frames, and a [self-updating GIF or clip](/blog/readme-gifs-that-update-themselves) carries it |

The strongest setup never chooses once and for all — it emits both from one spec, so they can never disagree about what the product looks like. Our own engine, aidemo (browser-only, storyboards are agent-authored, no GUI timeline editor), does this with a marker: dropping `{ "op": "still", "name": "hero" }` into the action-spec makes `stills` mode extract `output/stills/hero.png` from the same clean take that produces the narrated video, with no API key and no re-record. The tool is beside the point. What matters is that the still and the video come from a single source of truth, so a UI change updates both in one commit and the two never tell a visitor different stories.

## Sources

- [shot-scraper writeup — Simon Willison, March 2022](https://simonwillison.net/2022/Mar/10/shot-scraper/)
- [shot-scraper repository (Apache-2.0)](https://github.com/simonw/shot-scraper)
- [shot-scraper multi command docs](https://shot-scraper.datasette.io/en/stable/multi.html)
- [Playwright screenshots guide](https://playwright.dev/docs/screenshots)
- [Playwright page.screenshot() API reference](https://playwright.dev/docs/api/class-page#page-screenshot)
- [Playwright visual comparisons (toHaveScreenshot)](https://playwright.dev/docs/test-snapshots)
- [Heroshot README — omachala/heroshot](https://github.com/omachala/heroshot/blob/main/README.md)
- [GitHub Actions schedule / cron trigger docs](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)
- [Apple App Store screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/)

## FAQ

### How do I keep the screenshots in my documentation from going out of date?

Store them as a declarative shot list — a shot-scraper `shots.yml` or a Heroshot config — then run that list from a scheduled GitHub Action that opens a pull request with the regenerated images. A person reviews the visual diff, and the docs image tracks the product instead of tracking the day someone last remembered to recapture.

### What is the best tool to automate website screenshots?

For plain, diffable control, shot-scraper's YAML multi-shot mode is hard to beat and it is Apache-2.0. For a point-and-click picker plus a ready-made auto-PR workflow and light/dark variants, Heroshot fits. If you already run Playwright tests, `toHaveScreenshot()` gives you capture and diffing inside the suite you have. All three drive a real browser, so the pixels are the real UI.

### Do automated screenshots replace visual regression testing?

They are the same mechanism pointed at two goals. A deterministic screenshot pipeline compares each new capture against a stored baseline, which is exactly what a visual regression test does. The difference is what you do with a diff: publish it as a fresh docs image, or fail the build. Wire both to one capture and you get the marketing asset and the guardrail from a single run.

# Putting a demo video on your landing page without wrecking load time

July 18, 2026 · Video Marketing for Software · 7 min read · https://aidemo.top/blog/demo-video-on-landing-page/

> A hero video is the heaviest thing on the page and the thing Google times it by. Here is how to ship one so the page still paints in under 2.5 seconds.

**Key takeaways**

- A <video> is an LCP-eligible element; for video, LCP uses the poster load time or first frame, whichever is earlier, so a small poster caps the number Google grades (web.dev).
- On Lighthouse's Slow 4G (1.6 Mbps, about 200 KB/s), a 30s 1080p loop at 2 Mbps is ~7.5 MB and takes ~37s to arrive; a ~100 KB poster lands in ~0.5s.
- Default hero recipe: preload="none", a poster preloaded with fetchpriority="high", click-to-play, so the poster wins the LCP race and the video's bytes wait for the click.
- Muted autoplay is always allowed; autoplay with sound is blocked without user interaction or a high Media Engagement Index, so an autoplay hero is silent (Chrome).
- A cold YouTube iframe runs hundreds of KB of JS before any click; a facade (lite-youtube-embed) reports rendering ~224x faster by loading the real iframe on click.

## The tax a hero video charges before it persuades anyone

A demo video is the heaviest thing most teams put on a landing page, and a landing page is graded on how fast its heaviest thing appears. Those two facts collide at Largest Contentful Paint, the moment the biggest element in the viewport finishes rendering. Google rates an LCP of 2.5 seconds or less as good and anything past 4.0 seconds as poor, measured at the 75th percentile of loads across mobile and desktop ([web.dev, 2026](https://web.dev/articles/lcp)). A `<video>` element is eligible to be that biggest element. So the same clip meant to sell the product can, shipped carelessly, become the exact pixels the page is timed against.

The reason this bites harder than it reads is the connection you are actually optimizing for. Lighthouse's default mobile profile, "Slow 4G," throttles to 1.6 Mbps down with 150 ms of latency, roughly the 85th-percentile mobile connection rather than a pathological one ([Lighthouse, 2026](https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md)). That works out to about 200 KB per second. At that rate a 30-second 1080p loop encoded at a lean 2 Mbps, 7.5 MB in total, takes some 37 seconds to arrive in full, and every one of those seconds competes with the CSS and fonts that decide when anything paints at all.

Whether a video *lifts* conversion is a separate and genuinely contested question, [traced to its origin elsewhere in this cluster](/blog/does-video-increase-conversion). This piece is narrower: the mechanics that decide whether the video costs you the page before it earns a single view. The tax turns out to be a function of three decisions, all made before you write a line of markup: where the video sits, how it plays, and which element the browser is allowed to time.

## Where the video goes: above the fold, below it, or behind a click

Placement is the first lever because it decides whether the video is on the critical path at all. An asset the browser must render to fill the first screen competes for those first 200 KB per second; an asset below the fold, or hidden behind a click, does not.

| Placement | LCP risk | When it is the right call |
| --- | --- | --- |
| Above the fold, autoplaying | Highest: the video shares the critical path with the headline, CSS, and fonts | A short, light, silent loop when motion itself is the pitch |
| Above the fold, poster + click-to-play | Low: the poster is an ordinary image | The default hero for most products |
| Below the fold, lazy-loaded | None until scrolled near | Long walkthroughs and secondary proof |
| Behind a click or modal | None until opened | Full-length or heavy demos |

The common mistake is treating "above the fold" and "autoplaying full-weight video" as one decision. They are two. You can put the demo in the hero and still keep it off the critical path, which is what the next two sections are about. And because a landing hero is only one of the places this recording will live, right-sizing it is a [per-placement length decision](/blog/how-long-should-a-demo-video-be), not a fixed export: the hero wants the tightest cut, the docs page a different one, and [the whole distribution map](/blog/video-marketing-for-software) treats each as a re-fit of one master.

## Three playback modes, priced by what they cost the page

Once placement is settled, playback mode decides the byte cost. There are three that ship reliably, and they are not interchangeable.

| Mode | Bytes on load | Sound | Best for |
| --- | --- | --- | --- |
| Autoplay muted loop | The clip starts streaming immediately | Muted, always | Silent UI motion under ~15 s, kept small |
| Click-to-play + poster | Poster only, roughly 100 KB | On, after a click | The considered demo a visitor chooses to watch |
| Facade to a hosted embed | A thumbnail and a tiny script | On, after a click | YouTube or Vimeo without the iframe's payload |

The sound column is not a preference, it is a rule the browser enforces. "Muted autoplay is always allowed," while autoplay with sound is blocked unless the visitor has interacted with the site, has a high Media Engagement Index, or has installed the page as an app ([Chrome, 2026](https://developer.chrome.com/blog/autoplay)). So an autoplay hero is necessarily silent, which means any message it carries has to be legible without audio, the same argument that makes [burned-in captions non-optional on muted playback](/blog/demo-video-captions). If you do autoplay, add `playsinline` (it is what stops iOS Safari from hijacking the clip into fullscreen) and, when the clip has real audio behind the mute, a visible unmute control rather than a forced-sound workaround ([Mux, 2025](https://www.mux.com/articles/best-practices-for-video-playback-a-complete-guide-2025)).

## The poster is the governor on LCP

The single most useful line in Google's LCP definition is the one about video. For a `<video>` element, LCP uses "the poster image load time or first frame presentation time for videos ... whichever is earlier" ([web.dev, 2026](https://web.dev/articles/lcp)). Read it as an instruction, not a footnote. Attach a small poster and its load time, not the video's, becomes the number the score is graded on, because a well-compressed poster almost always arrives before a single frame of the clip has decoded.

Here is that arithmetic on the Slow 4G pipe, at its ~200 KB per second.

| Asset | Typical weight | Time to arrive on Slow 4G | Safe as the LCP element? |
| --- | --- | --- | --- |
| Poster (WebP/JPEG, ~1600 px) | 60-120 KB | ~0.3-0.6 s | Yes |
| 10 s muted UI loop @ 2 Mbps | ~2.5 MB | ~12 s | No |
| 30 s hero loop @ 2 Mbps | ~7.5 MB | ~37 s | No |

The poster clears the 2.5-second budget with room left for the HTML and CSS on the same connection. The loops do not, and it is worse than the table shows: an autoplaying loop with no poster hands the browser nothing to time against but its own first frame, decoded from bytes that are still trickling in behind everything else. Set a poster and you cap LCP at the poster's load; skip it and you have volunteered the slowest asset on the page as the thing Google measures. The poster is a governor: it does not make the video lighter, it stops the video's weight from reaching the meter.

## The lazy-load recipe, attribute by attribute

With placement and mode chosen, the markup is short. Three recipes cover almost every landing page.

The default hero, click-to-play behind a poster:

```html
<!-- Poster wins the LCP race; the video's bytes wait for a click -->
<link rel="preload" as="image" href="/demo-poster.webp" fetchpriority="high">
<video controls preload="none" poster="/demo-poster.webp"
       playsinline width="1280" height="720">
  <source src="/demo.mp4" type="video/mp4">
</video>
```

`preload="none"` keeps the browser from fetching any video data until the visitor presses play; `metadata`, the spec's default, still pulls a range of the file you did not ask for ([web.dev, 2026](https://web.dev/articles/lazy-loading-video)). Preloading the poster with `fetchpriority="high"` makes it the resource that wins first paint.

An above-the-fold silent loop, when motion is the whole point, kept deliberately tiny:

```html
<video autoplay muted loop playsinline preload="none"
       poster="/loop-poster.webp" width="1280" height="720">
  <source src="/loop.mp4" type="video/mp4">
</video>
```

Mind one caveat here: `autoplay` takes precedence over `preload`, so the browser will fetch what it needs to play regardless of the hint ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)). The defense is a genuinely small file, seconds not minutes. For a loop that lives *below* the fold, add `loading="lazy"` (or toggle `autoplay` with an IntersectionObserver) so it does not download until it is near the viewport at all.

For a YouTube or Vimeo clip, do not paste the stock iframe. A cold embed executes hundreds of kilobytes of JavaScript before a visitor clicks anything. The facade pattern renders a thumbnail and swaps in the real iframe on click; paulirish's lite-youtube-embed reports rendering "approximately 224x faster" than the native iframe ([lite-youtube-embed, 2026](https://github.com/paulirish/lite-youtube-embed)). Whether to self-host or lean on a hosted player is [its own decision](/blog/embed-video-on-website); the facade is what makes the hosted choice affordable on a landing page.

One honest limit binds all three: `preload` is a hint, and "the specification does not force the browser to follow the value of this attribute" ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)). Test the finished page on a throttled connection instead of trusting the markup, and confirm the exact autoplay-muted-loop attribute set behaves [the same across browsers](/blog/autoplay-video-on-website).

One production note that makes the recipe cheaper to follow: the hero loop and the click-to-play cut are the same flow at two weights, a trimmed silent version for the fold and a full captioned version behind the click. Producing the demo from a spec you can re-encode, rather than a single exported file, gives you both without a second recording. aidemo, the open-source engine we build, works this way: an agent writes a storyboard, the engine replays it, and one flow re-exports as both a lean loop and a full narrated cut. Its constraints are worth stating plainly: capture is browser-only, the storyboard is authored by an agent rather than a person at a timeline, and there is no GUI editor for hand-tweaking the result.

## Sources

- [web.dev — Largest Contentful Paint (LCP)](https://web.dev/articles/lcp)
- [web.dev — Lazy-loading video](https://web.dev/articles/lazy-loading-video)
- [Lighthouse — Throttling (Slow 4G defaults)](https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md)
- [MDN — The Video Embed element (`<video>`)](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)
- [Chrome — Autoplay policy in Chrome](https://developer.chrome.com/blog/autoplay)
- [Mux — Best Practices for Video Playback: A Complete Guide (2025)](https://www.mux.com/articles/best-practices-for-video-playback-a-complete-guide-2025)
- [paulirish — lite-youtube-embed](https://github.com/paulirish/lite-youtube-embed)

## FAQ

### Should the demo video on my landing page autoplay?

Only if it is short, silent, and small. Chrome allows muted autoplay unconditionally but blocks autoplay with sound unless the visitor has interacted with the site ([Chrome, 2026](https://developer.chrome.com/blog/autoplay)), so an autoplay hero is a muted loop by definition. Keep it under roughly 15 seconds and a couple of megabytes, give it a poster, and add `playsinline`. For a considered demo the visitor should actually hear, prefer click-to-play behind a poster, which also keeps the video's bytes off the page's first paint entirely.

### Should the video go above or below the fold on a landing page?

Either works if you keep it off the critical path. Above the fold, use a poster and click-to-play so the ordinary poster image, not the video, is what the browser times for LCP. Below the fold, add `loading="lazy"` (or an IntersectionObserver) so the file does not download until the visitor scrolls near it ([web.dev, 2026](https://web.dev/articles/lazy-loading-video)). The placement that reliably hurts is a full-weight autoplaying hero, because it forces the heaviest asset on the page onto the first screen.

### How big can a landing-page hero video be before it slows the page?

If the video is the LCP element, the ceiling is brutal: on Lighthouse's Slow 4G profile (1.6 Mbps, about 200 KB per second) you have roughly 500 KB of total budget to paint the first screen inside 2.5 seconds, and the video is sharing it with your HTML, CSS, and fonts ([Lighthouse, 2026](https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md)). The fix is to stop making the video the LCP element. Give it a ~100 KB poster, which loads in about half a second and becomes the timed element, and the video file's weight stops counting against first paint.

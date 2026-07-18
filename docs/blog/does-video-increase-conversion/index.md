# Does video actually increase conversion? Tracing the 80% claim

July 18, 2026 · Video Marketing for Software · 7 min read · https://aidemo.top/blog/does-video-increase-conversion/

> The famous 80% conversion lift traces to one 2011 A/B test. Here is what a 35,000-page analysis and your LCP budget actually say about video.

**Key takeaways**

- The "video lifts conversion 80%" stat traces to a single 2011 EyeView A/B test (best single result 86%, one tutoring page); the original report is no longer published.
- Unbounce's analysis of ~35,000 landing pages (2021) found video correlated with neutral-to-negative conversion, not an 80% lift, once you control for the page.
- Speed is the reliable lever: a good LCP is 2.5s or less, and a 0.1s mobile speedup raised retail conversions 8.4% (Google/Deloitte, 30M sessions, 37 brands).
- A video and a large hero image are both eligible to be the LCP element, so a heavy autoplay hero can make the slowest thing on the page the thing Google grades.
- Rule: keep the LCP element a static poster or headline and load the video on interaction; relevance plus fast load decides the lift, not the medium.

## Where the 80% number actually comes from

Search "does video increase conversion" and the first answer is almost always a number: video on a landing page lifts conversions by 80%, sometimes 86%. It rides on vendor pages, in pitch decks, and in the opening paragraph of nearly every article on the subject. A figure that specific and that durable is worth tracing, because where it came from decides how much weight it can bear.

Follow it back and the trail narrows to a single source: a 2011 batch of A/B tests by a video-advertising company called EyeView Digital, run on a handful of ecommerce landing pages. The method was the ordinary split test, half the traffic to a page with an embedded video and half to the same page without. The 86% figure was the best single result in that batch, an online tutoring service's page; "80%" is the rounded, averaged descendant that broke free of its context. The original EyeView report is no longer published anywhere you can read it. A claim that has anchored a decade of "just add a video" advice now survives only as a number that pages quote from each other.

That does not make it false. It makes it one A/B test, on one page type, from one vendor, fifteen years ago, promoted into a law. A result like that is a hypothesis to test, not proof that a video will lift your conversion rate. To know whether it will, you have to separate what video correlates with from what it causes, and then look at the one mechanism that reliably moves the number in either direction.

## Correlation is not the lift: what a 35,000-page analysis found

The honest test of the claim is not one split test but a large corpus where you can compare pages with and without video at scale. Unbounce, a landing-page platform that spent years publishing the "add video" advice, ran that analysis across roughly 35,000 of its customers' pages and reported the result in 2021: videos "do not boost your landing page conversion rates, and in some cases might even harm them" ([Unbounce, 2021](https://unbounce.com/landing-pages/video-on-landing-pages-means-more-conversions-right-wrong-heres-why/)). On form-fill pages the difference between video and non-video pages was negligible; on click-through pages the gap ran negative; across ten industries video "generally correlate[d] with neutral or even negative page performance," and the pattern held on mobile and desktop and across every traffic channel.

A corpus disagrees with the famous split test for a plain reason: selection bias. Pages that add video are not a random sample. They tend to belong to teams with bigger budgets, longer copy, and more moving parts, which is exactly the kind of page with other reasons to convert differently. When EyeView held the page constant and changed only the video, they isolated video's effect on one page. When you look across thousands of pages, video is tangled up with everything else the team did, and the clean 80% lift dissolves into noise or worse. "Has video" correlating with "converts well" is not video causing the conversion, and at corpus scale the correlation is not even reliably positive.

## Your LCP budget is the real variable

If video's persuasive effect is inconsistent, its performance cost is not. A page is graded by Google on Largest Contentful Paint, the time until the biggest element in the viewport renders. A good LCP is 2.5 seconds or less at the 75th percentile of loads; anything over 4.0 seconds is rated poor ([web.dev, 2026](https://web.dev/articles/lcp)). And a `<video>` element and a large hero image are both eligible to be the LCP element. Drop a heavy autoplaying video into the hero and you have not set a persuasion asset beside your page, you have often made the slowest thing on the page the thing the score is measured against.

Speed is where the conversion evidence stops being ambiguous. Google, 55, and Deloitte's "Milliseconds Make Millions" study instrumented over 30 million sessions across 37 retail, travel, luxury, and lead-gen brands and found that a 0.1-second improvement in mobile load time raised retail conversions by 8.4%, travel conversions by 10.1%, and luxury product-to-cart progression by 40.1% ([Google/Deloitte, 2020](https://web.dev/case-studies/milliseconds-make-millions)). Read the sign, not the magnitude: those elasticities were measured on already-fast sites near their operating point, so you cannot multiply 8.4% across a two-second regression and claim a video costs you 168% of your conversions. What you can say is that the direction is settled. Faster converts better, a video is one of the heaviest things you can put on a page, and if it becomes the LCP element it pushes you the wrong way on the one axis where the causal link to conversion is well established.

That reframes the question. "Does video increase conversion" is the wrong unit. The real question is whether a given video's persuasion lift outweighs the conversion it costs by slowing the page, and the answer turns entirely on how you ship it.

## A decision table: when video lifts conversion and when it sinks it

Video is not one thing you either add or skip. It is a set of choices, each of which pushes the net effect toward lift or toward loss. Here is the same asset scored on the factors that actually decide it.

| Factor | Video lifts conversion when… | Video costs conversion when… |
| --- | --- | --- |
| Product complexity | The value is spatial, motion-based, or hard to explain in scannable text | The value is a simple list a visitor reads in five seconds |
| Load impact | It loads lazily behind a poster and the LCP element stays a static image or headline | It autoplays as a heavy hero and becomes the LCP element |
| Relevance | It shows the exact workflow the visitor came to evaluate | It is a generic brand reel with a logo intro |
| User control | Click-to-play, muted by default, captioned, skippable | Autoplay with sound and no visible controls |
| Placement | Beside or below the primary CTA, not displacing it | It shoves the value prop and CTA below the fold |
| Visitor intent | High-intent visitors researching a considered purchase | Cold feed traffic that bounces in the first three seconds |

Read down the "costs conversion" column and you have a fair description of the default landing-page hero video: an autoplaying, heavy brand reel that becomes the LCP element and pushes the CTA down. Read the "lifts conversion" column and you have a click-to-play, captioned, relevant product walkthrough that loads after the page is interactive. Same medium, opposite outcomes. It is also why the honest comparison is sometimes not video at all: a [clickable interactive demo](/blog/interactive-demo-vs-video-demo) can carry a complex product without the byte weight of a video hero, and [the numbers you instrument](/blog/demo-video-metrics) are what tell you which one actually won.

## Adding video without paying the speed tax

The engineering fix is to decouple the video from the page's first paint, so it can persuade the visitors who want it without taxing the ones who do not. Keep the LCP element a static poster image or a text headline, and load the video on interaction rather than on load. Nielsen Norman Group's usability research arrives at the same place from the user's side: people dislike video that plays without their consent, video forces slow sequential access where the web rewards scanning, and critical information should exist as text regardless ([Nielsen Norman Group, 2014](https://www.nngroup.com/articles/video-usability/)). A click-to-play, captioned, transcript-backed video respects the visitor and the performance budget at once.

A few rules follow directly. Give every embed a poster frame so the hero paints instantly. Do not autoplay a full-weight file; use a lightweight preview or a facade that swaps in the real player on click. Right-size the file to the placement, because a landing hero does not need a four-minute cut, and [the right length is a per-placement decision](/blog/how-long-should-a-demo-video-be). Then measure it: Wistia's 2026 data shows fewer than half of marketers even connect their video platform to a CRM or email tool, so most "video increased conversion" claims are never checked against pipeline at all ([Wistia, 2026](https://wistia.com/learn/marketing/video-marketing-statistics)).

Because delivery is where the win lives, treating the demo as something you can re-cut and re-encode per placement matters more than the recording itself. Our own engine, aidemo, renders a demo from an agent-authored storyboard so the same flow exports at different lengths and sizes for a hero, a poster, or a lazy-loaded embed; its honest limits are that it captures the browser only and offers no drag-on-a-timeline editor, so it earns its keep on a demo that must ship to several placements rather than on a single quick screencast. The tool is beside the point. The finding is not "video does not work." It is that video's effect on conversion is dominated by relevance and load time, which is why a relevant clip that respects your LCP budget can help, a heavy autoplay hero reliably will not, and how one recording reaches [every channel](/blog/video-marketing-for-software) is the decision that actually pays.

## Sources

- [Unbounce — Video on Landing Pages: Does It Really Mean More Conversions?](https://unbounce.com/landing-pages/video-on-landing-pages-means-more-conversions-right-wrong-heres-why/)
- [web.dev — Largest Contentful Paint (LCP)](https://web.dev/articles/lcp)
- [web.dev — Milliseconds Make Millions (Google, 55, and Deloitte)](https://web.dev/case-studies/milliseconds-make-millions)
- [Nielsen Norman Group — Video Usability](https://www.nngroup.com/articles/video-usability/)
- [Wistia — State of Video Report: Video Marketing Statistics for 2026](https://wistia.com/learn/marketing/video-marketing-statistics)

## FAQ

### Does video on a landing page increase conversion rate?

Sometimes, and not by the 80% the marketing pages promise. That figure traces to a single 2011 EyeView A/B test, while Unbounce's later analysis of roughly 35,000 pages found video correlating with neutral-to-negative conversion ([Unbounce, 2021](https://unbounce.com/landing-pages/video-on-landing-pages-means-more-conversions-right-wrong-heres-why/)). Video helps when it explains a genuinely complex product, matches what the visitor came to evaluate, and loads without slowing the page. It hurts when it is a generic reel that becomes the slowest element on the page.

### Why did adding a video lower my conversion rate?

The most common cause is speed. If the video autoplays in the hero it can become your Largest Contentful Paint element, and a good LCP is 2.5 seconds or less ([web.dev, 2026](https://web.dev/articles/lcp)). A 0.1-second slowdown alone was enough to move retail conversions 8.4% in Google and Deloitte's data ([Google/Deloitte, 2020](https://web.dev/case-studies/milliseconds-make-millions)). A heavy hero video also pushes your value prop and CTA below the fold. Move the video to click-to-play behind a poster and keep a static image or headline as the LCP element.

### Does an autoplay hero video hurt Core Web Vitals?

It can, in two ways. A `<video>` element is eligible to be the LCP element, so a heavy autoplaying hero can set the number the score is graded on, and a good LCP is 2.5 seconds or less at the 75th percentile ([web.dev, 2026](https://web.dev/articles/lcp)). The fix is to give the hero a lightweight poster image or a text headline as the LCP element and defer the actual video file until the visitor interacts, which keeps first paint fast while still offering the video to anyone who wants it.

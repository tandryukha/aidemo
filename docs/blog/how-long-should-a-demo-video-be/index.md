# How long should a demo video be? The retention math

July 18, 2026 · Product Demo Videos · 7 min read · https://aidemo.top/blog/how-long-should-a-demo-video-be/

> Most demos run longer than they should, and that is an editing problem. Here is the target length for every placement, plus what to cut first.

**Key takeaways**

- Completion falls with length: 65% of viewers finish a sub-60-second business video, only 20% finish one over 20 minutes (Vidyard, 943,305 videos, 2024 data).
- Length is set by placement: 30-60s landing hero, 15-30s social feed, 10-30s README loop, 45-90s warm sales follow-up, 1-3 min docs and onboarding.
- Engagement peaks in the first quarter of the runtime and the median viewer leaves near halfway, so the back half of a long take is watched by almost no one.
- The first cut is almost always too long: making it shorter is an editing problem (trim idle, cut the intro, drop repeat examples), not a re-record.
- Longer can win at the bottom of the funnel: Wistia's 2026 data shows longer videos drew the highest click-through rates among self-selected viewers.

## What one more minute costs you in viewers

The honest answer to "how long should a demo video be" is a number you can compute, not a matter of taste, because the completion curve is public and it bends the same way for almost everyone. Vidyard's 2025 benchmark report, built from 943,305 business videos recorded across 2024, found that 65% of viewers stay to the end of a video under one minute, and only 20% reach the end of one over twenty minutes ([Vidyard, 2025](https://www.vidyard.com/business-video-benchmarks/)). Engagement, the same report notes, is highest in the first quarter of the runtime and slides at every milestone after it. Wistia's 2026 State of Video, looking at videos on homepages and product pages, puts the typical viewer at about halfway through ([Wistia, 2026](https://wistia.com/learn/marketing/video-marketing-statistics)).

Read those numbers together and the design constraint is plain. Whatever you put after the first quarter of the runtime, most people never reach, and whatever you put after the one-minute mark, a third of the audience has already gone. A demo does not become more thorough by running longer; it becomes more thorough for a shrinking share of viewers. Length is a budget you spend, and the exchange rate is measured in people who stay.

That reframes the whole question. The useful version is not "how long is a demo video," it is "how long for this placement, for this audience, with this much attention to spend." Those answers differ by a factor of ten, and picking the wrong one is why a perfectly good recording underperforms.

## A target length for where the demo lives

The biggest single determinant of the right length is not the product, it is the surface the video sits on. A muted loop under a README and a warm sales follow-up are different jobs with different attention budgets, and the same ninety-second cut is wrong for both. Here is the matrix, with the evidence behind each target and the first thing to cut when your take runs over it.

| Placement | Target | Why | Cut first when over |
| --- | --- | --- | --- |
| Landing-page hero | 30-60 s | Vidyard puts landing and homepage video at 30-60 s, and a third of visitors bounce inside the first 30 seconds ([Vidyard, 2023](https://www.vidyard.com/blog/video-length/)) | The intro. Open on the product mid-action, not on a logo |
| README / inline docs | 10-30 s loop | Plays muted, on loop, with no controls; GitHub caps an inline video at 10 MB on a free repo ([GitHub Docs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)) | The second feature. One flow, one loop |
| Social feed | 15-30 s | LinkedIn's own guidance is 15-30 s for feed video, with 92% of mobile views playing without sound and the first six seconds deciding it ([LinkedIn, 2025](https://www.linkedin.com/business/marketing/blog/content-marketing/13-top-tips-for-compelling-b2b-video-content-on-linkedin)) | Everything before the payoff. Lead with the result |
| Sales follow-up | 45-90 s | Cold outreach and video email want 45 seconds or under; a warm, named-account follow-up earns a little more, and 65% still finish under a minute ([Vidyard, prospecting](https://www.vidyard.com/blog/video-prospecting/)) | Generic value props. Keep only what is specific to this prospect |
| Product docs / onboarding | 1-3 min | Tutorials hold engagement at length where marketing clips do not, because the viewer came to finish a task ([Wistia, 2026](https://wistia.com/learn/marketing/video-marketing-statistics)) | Nothing structural. Split into chapters instead |

Two things about this table earn their place. First, the top three placements all sit below a minute, which is where the completion data is kindest, and they are also the placements you least control: a hero autoplays straight into a reflex to skip, a feed scrolls past, a README loops in peripheral vision. Second, the bottom row is the exception that proves the rule. Documentation and onboarding video is watched by someone who chose to be there to finish a task, so completion behaves differently and the length is allowed to follow the work. If your demo is really a tutorial, the matrix says so, and you can stop trying to compress a ten-step task into a hero loop.

The word count then follows the length automatically. At the usual narration pace, a 45-second social cut is about a 110-word script and a 90-second follow-up about 225 words; [the script template does that conversion section by section](/blog/demo-video-script-template), so you write to the budget instead of trimming after. Pick the row, read off the seconds, and the script has a ceiling before you record a frame.

## Usually shorter than you recorded

Here is the part nobody wants to hear: the first cut is almost always too long, and not by a little. A live take pads itself. Page loads add dead seconds, the cursor hunts for the next control, the narrator says "and you can also" three times, and the demo quietly shows two jobs when it promised one. The recording you are proud of at 2:10 is a 50-second video wearing a 90-second tax.

The drop-off data says exactly where that tax hides. If engagement peaks in the first quarter and the median viewer leaves near the halfway mark, then the back half of a long take is content almost nobody sees, while the front does all the work buried under setup. The remedy is not a better performance, it is editing, and length is the most reversible decision in the entire pipeline. It costs nothing but a re-encode to trim idle time, cut the intro, and drop the scene you love that the buyer never asked about.

This is where the recording approach quietly decides your options. A hand-recorded take is one indivisible performance: pull ten seconds out of the middle and the pointer, the voice track, and the on-screen timing all slide apart, so "make it shorter" turns into "record it again." A demo defined as a spec has no such problem. Trimming dead time between actions is a [compose-time transform, not a reshoot](/blog/professional-screen-recordings), and cutting a scene means deleting a few lines and re-rendering. In our own engine, aidemo, idle time is trimmed to the narration automatically and a shorter cut is a re-render of the same storyboard rather than a fresh take; it is browser-only and the storyboard is authored by an agent instead of dragged on a timeline, which is a poor trade for a one-off and a good one when you will retarget the same demo for five placements. Either way the point holds independent of tooling: if your only lever for length is re-recording, you will ship the long version, because the short one is too expensive to reach.

## The cut order: what goes first when you are over

When a take runs long, cut in this order. Each item is safe to remove before the one below it, because it costs the viewer the least and the recording the most.

| Order | Cut | Why it is safe to lose first |
| --- | --- | --- |
| 1 | Idle time and page loads | Pure dead air; trimming to motion removes nothing a viewer wanted |
| 2 | The logo or title intro | Nearly half a video's value lands in the first three seconds ([Vidyard, 2023](https://www.vidyard.com/blog/video-length/)); spend them on the product |
| 3 | The second and third example | One instance is proof; three is a feature tour nobody asked for |
| 4 | Cursor narration | "I click the blue button" is already on screen, so the words are free to cut |
| 5 | Slow typing and mouse travel | Speed-ramp or hard-cut; no one needs to watch a form fill in real time |
| 6 | The feature you love | If the buyer's job does not need it, it is your favorite, not theirs |

Run the list until the runtime fits the target for the placement. The first two items are pure waste and the last two are discipline; most demos are salvageable on items 1 through 3 alone. If you are still over after cutting your favorite feature, the video is trying to do two jobs, and the answer is two videos, not a faster read. For sales prospecting the payoff of that discipline is measurable: staying under a minute lifts completion from 53% across all lengths to 65% ([Vidyard, prospecting](https://www.vidyard.com/blog/video-prospecting/)).

## When a longer demo earns its length

Shorter is the default, not a law. Wistia's data carries a genuinely counterintuitive finding: across its 2026 sample, the longer the video, the more likely a viewer was to act on it, with the highest click-through rates landing on videos in the 30-to-60-minute range ([Wistia, 2026](https://wistia.com/learn/marketing/video-marketing-statistics)). The people who stay through a long video are self-selected and far warmer, so a deep technical walkthrough for a bottom-of-funnel buyer can beat a tight hero clip on the metric that actually pays. The mistake is putting a long video where a short one belongs: a webinar-length walkthrough in a landing hero, or a ten-minute tour where a 30-second loop was the job.

Match the length to the intent of the person watching. Put the short cut where attention is scarce and the long one where it is earned, and let [the full production playbook](/blog/how-to-make-a-product-demo-video) and a [regenerate-don't-re-record workflow](/blog/automated-product-demo-videos) make it cheap to ship both from one recording. The right length was never a fixed number. It is a cut you make for a placement, and the reason so many demos are too long is that cutting felt more expensive than it needed to be.

## Sources

- [Vidyard — Video in Business Benchmark Report (2025 edition)](https://www.vidyard.com/business-video-benchmarks/)
- [Vidyard — How Long Should a Video Be? Ideal Lengths for Every Channel](https://www.vidyard.com/blog/video-length/)
- [Vidyard — Video Prospecting for Sales](https://www.vidyard.com/blog/video-prospecting/)
- [Wistia — State of Video Report: Video Marketing Statistics for 2026](https://wistia.com/learn/marketing/video-marketing-statistics)
- [LinkedIn Marketing Blog — B2B Video on LinkedIn: 13 Best Practices](https://www.linkedin.com/business/marketing/blog/content-marketing/13-top-tips-for-compelling-b2b-video-content-on-linkedin)
- [GitHub Docs — Attaching files (image and video size limits)](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)

## FAQ

### What is the ideal length for a product demo video?

There is no single ideal, only a target per placement. For the surfaces most demos live on, a landing hero, a social feed, a README loop, aim for 15 to 60 seconds, because completion stays high there: 65% of viewers finish a business video under a minute ([Vidyard, 2025](https://www.vidyard.com/business-video-benchmarks/)). Reserve two to five minutes for documentation, onboarding, or a warm bottom-of-funnel walkthrough, where the viewer came to finish a task and length is allowed to follow it.

### How long is too long for a demo video?

Too long is the point where your placement's audience has already left. On a landing page a third of visitors bounce within 30 seconds, and across business video only 20% finish anything over 20 minutes ([Vidyard, 2025](https://www.vidyard.com/business-video-benchmarks/)). A practical ceiling: if the runtime exceeds the target for its placement, and cutting idle time, the intro, and repeated examples does not get you there, the video is doing two jobs and should be two videos.

### Should you split a long demo into shorter videos?

Usually yes, when the length comes from covering several jobs rather than one deep task. A single flow that runs long should be trimmed; a video that runs long because it shows three separate features should be three short videos, each placed where its buyer looks. The exception is a genuine tutorial or onboarding sequence, where chaptering one longer video beats fragmenting a task the viewer wants to complete in one sitting.

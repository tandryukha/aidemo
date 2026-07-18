# Measuring whether documentation videos actually work

July 18, 2026 · Video Documentation & Tutorials · 8 min read · https://aidemo.top/blog/measuring-documentation-video-effectiveness/

> A play count cannot tell you whether a documentation video did its job. Measure the four gates it must clear, and retire the clips that fail them.

**Key takeaways**

- Views measure supply, not outcome: a doc video is graded on task success and ticket deflection, not plays. Zendesk warns to read pageviews only alongside other metrics.
- Grade a doc video on four gates in order, findability, engagement, task success, deflection. A clip can pass three and fail the fourth, so an upstream failure fakes a downstream one.
- Findability runs before playback: a video-only article is invisible to a text search box. The fix is a transcript and in-article placement, never a re-shoot.
- Deflection has a formula: Zendesk self-service score = help-center sessions / users who filed a ticket, read at the topic level. It is the lagging signal that grades the real outcome.
- Retire on a scorecard: after a fair window (a quarter), kill a clip that is findable and watched but moves no helpful votes, follow-through, or self-service score.

## Views measure supply, not whether anyone got helped

A documentation video's dashboard leads with a view count, and it is the single number that cannot tell you whether the video did its job. A marketing video wants attention, so a play is at least adjacent to the goal. A documentation video wants something a play never proves: that a reader who arrived stuck left unstuck, and did not open a ticket on the way out. Ten thousand plays on a help-center clip reports supply, how many times the file started, and says nothing about the outcome the clip exists to produce. Zendesk's own knowledge-base guidance refuses to read raw pageviews as a verdict, advising teams to "monitor page views in conjunction with other monitoring methods" instead ([Zendesk knowledge base, accessed July 2026](https://support.zendesk.com/hc/en-us/articles/4408838548250-Using-the-metrics-that-matter-to-improve-your-knowledge-base)).

The reframe this piece runs on: a doc video is an instrument for task success and ticket deflection, not a thing people watch. That makes its measurement a different exercise from the marketing one, where [play rate, retention shape, and assisted conversions grade a video meant to move a deal](/blog/demo-video-metrics). Here the clip is graded on whether the reader's problem went away. The [pillar argues when video belongs in docs at all](/blog/video-documentation); this spoke assumes you shipped one and asks how to tell if it works, and, more usefully, which of four different ways it is failing.

## The four gates a documentation video has to clear

A doc video can die at four independent points, and collapsing them into one "is it working" number hides which one killed it. Read them as gates in order: a reader has to find the video, then choose to watch the part that matters, then actually succeed at the task, and finally not file the ticket anyway. Each gate has its own metric and its own fix, and a clip can sail through three and fail the fourth.

| Gate | The question | The metric that grades it | Where a failure sends you |
|---|---|---|---|
| Findability | Could a stuck reader reach it at all? | Search-to-video ratio, searches with no clicks | Placement, transcript, indexing |
| Engagement | Did they watch the load-bearing part? | Play rate, drop-off at the key step | Poster, opening, pacing |
| Task success | Did watching let them do the thing? | Helpful votes, a follow-through event | The content itself |
| Deflection | Did the ticket go unfiled? | Self-service score on the topic | The approach, or a ticket no video fits |

The order matters because an upstream failure impersonates a downstream one. A video nobody can find posts a task-success rate near zero, and if you read only that number you re-record a perfectly good clip that simply never got watched. Walk the gates in sequence and you spend effort on the one that is actually red.

## Findability: the metric that decides before anyone presses play

Every marketing metric starts at the play. In docs the first gate sits upstream of playback: can a stuck reader reach the clip? A help-center search box matches words, so a video-only article is invisible to someone typing the exact error into it, and a clip parked in a "videos" tab nobody opens has no path to it. The signal that grades this is the search-to-video ratio, how often a search on the topic surfaces the article carrying the clip, read next to two counts Zendesk exposes directly: "searches that returned 0 results" and "searches where no result was selected," each pointing at a topic readers want and cannot reach ([Zendesk self-service, accessed July 2026](https://support.zendesk.com/hc/en-us/articles/4408894139930-Getting-started-with-self-service-Part-6-Tracking-essential-self-service-metrics)).

The fix for a findability failure is never in the video. It is a transcript beside the clip so search has words to match, which doubles as [the accessible text layer a video otherwise withholds](/blog/accessible-tutorial-videos); it is placing the clip inside the article a reader already lands on rather than in a gallery; and it is titling that article the way a stuck user phrases the problem. None of that is filmmaking, and re-shooting a clip that fails this gate changes nothing.

## Completion of the part that matters, not the whole clip

Past findability, the engagement gate asks whether the reader reached the moment the video exists for. Marketing measurement fixates on overall completion; for a doc clip that number is nearly meaningless, because a reader who came for one step is right to leave the instant they have it. What you want is completion of the load-bearing segment, the ten seconds that show the actual click, not the share who sat through the outro.

Wistia's engagement graph gives you that at a glance: "the point where the blue line falls is where attention dropped," while a spike in the orange overlay marks a stretch "people found compelling enough to replay" ([Wistia, accessed July 2026](https://support.wistia.com/en/articles/8228871-average-user-engagement-analytics)). On a doc clip a replay spike is a gift; it flags the exact second readers rewind because the step went by too fast, which is a re-cut, not a failure. The drop-off to fear is the early one, and NN/g's instructional-video research names its usual cause: viewers complain that "videos include lengthy introductions and don't get to the point quickly enough," and because "videos move at the creator's pace and not necessarily at the viewer's pace," an intro that reads as polite in a webinar is friction in a how-to ([Harley, NN/g, 2020](https://www.nngroup.com/articles/instructional-video-guidelines/)). Reading the shape of that curve, cliff, valley, or plateau, is a skill [the demo-metrics piece works through drop-off by drop-off](/blog/demo-video-metrics); the doc-specific twist is only which segment you hold to the standard.

## The outcome gates: did they succeed, and did the ticket go unfiled

Findability and completion grade the clip as something watched. Neither proves the reader could then do the thing. The outcome gates do, and they are what separate documentation measurement from marketing measurement.

The cheapest outcome signal is the vote already built into most help centers: the "Was this article helpful?" thumbs. Zendesk surfaces it as "a number representing the difference between positive and negative votes," a single running tally rather than a percentage ([Zendesk knowledge base, accessed July 2026](https://support.zendesk.com/hc/en-us/articles/4408838548250-Using-the-metrics-that-matter-to-improve-your-knowledge-base)). It is noisy and self-selected, a leading indicator, because readers reach for "not helpful" more freely than "helpful", so read the trend rather than the raw split; still, a clip whose tally turns down after you add it is telling you something a play count never would.

The stronger signal is behavioral: fire a product event when a reader performs the exact action the clip documents, shortly after the article view. A walkthrough of the export flow should be followed by exports; a video on connecting an integration should be followed by connections. That follow-through rate is the closest a doc video gets to measuring task success directly, and it lives in your product analytics, not your video tool.

The last gate is deflection, and here the definition is a formula, not a mood. Zendesk names it the self-service score: help-center sessions divided by users who filed a ticket, where success "is demonstrated by an increasingly large ratio (for example, for every 40 users only one of them submits a ticket)" ([Zendesk self-service, accessed July 2026](https://support.zendesk.com/hc/en-us/articles/4408894139930-Getting-started-with-self-service-Part-6-Tracking-essential-self-service-metrics)). Read it at the topic level, not the video level, and watch the "searches that led to a ticket being created" on that topic fall after the clip ships. The [break-even math on what a deflected ticket is worth against what the clip costs](/blog/support-videos-knowledge-base) is a subject of its own; the measurement point is that deflection is a lagging indicator, weeks of data for a strong signal, and it is the only gate that grades the outcome the video was funded to produce.

## Reading the numbers together: which gate a failing video failed

The four metrics are only diagnostic together, because the same verdict, "this video isn't working", has four different cures depending on which gate is red. This is the table nobody assembles, because it needs the doc-specific outcome gates a marketing dashboard does not carry.

| What you see | The gate that failed | What it is not, and the real fix |
|---|---|---|
| Few plays, but high completion and helpful votes among those who watch | Findability | Not the video. Add a transcript, move the clip into the searched article, retitle it |
| Good traffic, low play rate | Engagement, entry | Not the content. Fix the poster frame, thumbnail, and on-page placement |
| High play rate, sharp early drop-off | Engagement, opening | Not the whole clip. Cut the intro and open on the action |
| High completion, but flat helpful votes and no follow-through | Task success | The content is wrong: it shows the wrong step or is unclear. Re-author, do not just re-place |
| Every watch metric strong, deflection still flat | Deflection | The ticket was never video-shaped; account-specific or trivial, so no clip deflects it |

The two rows people misread are the last two. A clip with high completion and no follow-through looks like a win on the dashboard and is a loss in the world: people watched the whole thing and still could not act, which indicts the content, not the packaging. And a video that clears every watch gate while tickets keep coming is usually sitting on a problem no video can deflect, the disputed-charge, account-specific kind that [belongs with a human rather than in the docs](/blog/support-videos-knowledge-base). Re-recording either one is wasted motion.

## A retire rule, so the videos nobody needs stop billing you

Measurement earns its keep only when it ends in a decision, and for a doc video the decision most teams never make is to kill one. Every kept clip runs a standing maintenance bill, on the order of [two hours per video per year to keep it from lying about a moved button](/blog/keeping-tutorial-libraries-current), so a clip that clears playback but fails the outcome gates is pure liability: cost with no offsetting deflection.

The rule is a scorecard, not a feeling. Give a video a fair measurement window, a quarter is defensible, then retire it when it fails the gates it was built to clear: findable and watched, but no movement in helpful votes, in follow-through, or in the topic's self-service score. Retiring rarely means deleting the answer; it means demoting the clip and letting text carry the load, which is the right call whenever [the job turned out to want words more than motion](/blog/video-vs-written-documentation).

One variable quietly sets the retire threshold: what the clip costs to keep. A hand-recorded video is expensive to maintain, so the bar to justify keeping a marginal one is high. A video that regenerates from a committed spec costs only CI minutes to rebuild, which lowers the bar, since keeping a borderline clip current is nearly free. One engine built for that, our own aidemo, is worth naming only with its limits attached: it works inside a web browser and nowhere else, a coding agent writes each storyboard rather than a person assembling clips by hand, and it has no drag-on-a-timeline editor at all. Which tool does the rebuilding is secondary. What matters is that "should this video still exist" is a question measurement answers, and for a real share of any library the answer is no.

## Sources

- [Zendesk — Getting started with self-service, Part 6: Tracking essential self-service metrics](https://support.zendesk.com/hc/en-us/articles/4408894139930-Getting-started-with-self-service-Part-6-Tracking-essential-self-service-metrics)
- [Zendesk — Using the metrics that matter to improve your knowledge base](https://support.zendesk.com/hc/en-us/articles/4408838548250-Using-the-metrics-that-matter-to-improve-your-knowledge-base)
- [Wistia — Average User Engagement Analytics](https://support.wistia.com/en/articles/8228871-average-user-engagement-analytics)
- [Harley, Nielsen Norman Group (2020) — Videos as Instructional Content: User Behaviors and UX Guidelines](https://www.nngroup.com/articles/instructional-video-guidelines/)

## FAQ

### What metrics show whether a documentation video is working?

Not the view count. Grade a doc video on four gates in order: findability (can a stuck reader reach it, from whether search surfaces the article), engagement (did they watch the load-bearing segment, from the drop-off graph), task success (did watching let them do the thing, from helpful votes and a follow-through event in product analytics), and deflection (did the ticket go unfiled, from the topic's self-service score). A clip can pass three gates and fail the fourth, so measure them separately rather than as one score.

### How do you measure ticket deflection from a help-center video?

Read it at the topic level with the self-service score: help-center sessions on that topic divided by users who filed a ticket on it, which Zendesk frames as a ratio you want to grow, for every 40 self-service users, one ticket. Track that ratio and the count of searches that led to a ticket, before and after the clip ships. Deflection is a lagging indicator, so give it weeks; a cleaner read is a holdout, showing the video to half the traffic and comparing the ticket rate on the topic.

### Is video watch time a good measure of documentation quality?

No. Watch time and completion are engagement metrics: they tell you people stayed, not that they succeeded. A doc video can post high completion and still leave every viewer unable to finish the task, which shows up only in a flat helpful-vote tally and no follow-through in product analytics. Treat watch time as a leading indicator you iterate on fast, and the outcome metrics, task follow-through and deflection, as the lagging signals that decide whether the clip works.

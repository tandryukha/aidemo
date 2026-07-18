# How to make a product demo video (that people finish)

July 18, 2026 · Product Demo Videos · 11 min read · https://aidemo.top/blog/how-to-make-a-product-demo-video/

> The playbook for a demo people actually finish: script first, record second, with the word, scene, and length budgets that decide every second.

**Key takeaways**

- Write the script first: at ~2.5 words/second a 60-second demo is a 150-word budget across 5 to 6 scenes, all decided before you ever hit record.
- Match length to placement: 30-60s for a landing hero or social clip (Wistia: sub-minute videos average 52% engagement), 1-3 min for sales and onboarding.
- Captions are not optional: WCAG 2.2 SC 1.2.2 makes them a Level A requirement, and most landing-page and social views autoplay muted.
- Six of the seven production steps can be generated from a spec; only writing the script is inescapably human.
- The step you repeat most is maintenance: a hand-recorded take gets re-performed when the UI changes; a spec-defined demo gets re-rendered.

## Write the script before you open the recorder

Most bad demo videos share one origin: someone hit record, clicked around the product, and narrated whatever came to mind. Ninety seconds of intent becomes four minutes of "and you can also," and the rest of the project is spent trying to rescue it in an editor. Reverse the order. The script is the cheap artifact. It is text, you can rewrite it ten times before lunch, and it fixes every expensive decision downstream: how long the video runs, how many scenes you record, where the cursor goes, and what the captions read. A product demo is a script with a screen recording attached, not a recording with words sprinkled over it.

Writing first also forces the only genuinely hard decision to the front, which is what to leave out. A feature tour wants to show everything; a demo that gets finished shows one job, done well, from start to result. Draft the narration as prose, read it aloud against a stopwatch, and cut until it fits the budget below. The [problem, walkthrough, proof script template](/blog/demo-video-script-template) turns that skeleton into fill-in-the-blanks sections with per-part word counts.

## The budget: how long, how many words, how many scenes

Length is not a stylistic choice, it is set by where the video will be watched. Wistia, analyzing more than 13 million videos for its 2026 State of Video report, found that clips under a minute average a 52% engagement rate, meaning viewers watch about half, and that engagement falls off past the five-minute mark ([Wistia, 2025](https://wistia.com/learn/marketing/optimal-video-length)). HubSpot's 2024 Video Marketing Report, surveying more than 500 video marketers, put the short-form window even tighter: 42% named 21 to 30 seconds as optimal and another 32% chose 31 to 60 seconds ([HubSpot, 2024](https://blog.hubspot.com/marketing/video-marketing-report)). The practical read is to pick a length for the channel and make the script fit it, never the reverse. [How long a demo video should be](/blog/how-long-should-a-demo-video-be) works the retention curves placement by placement.

| Placement | Target length | Why |
|---|---|---|
| Landing-page hero | 30 to 60 s | Autoplays muted, competes with a skip reflex |
| README or docs | 20 to 45 s | Read alongside the page, one flow only |
| Social feed | 15 to 45 s | Sound off, the first three seconds decide it |
| Sales follow-up | 60 to 120 s | Warm audience, one named use case |
| Onboarding or support | 60 to 180 s | Task completion beats brevity here |

Once length is fixed, the word count writes itself. Narration for a demo runs about 2.5 words per second, roughly 150 words per minute, deliberately slower than the 183-wpm average for oral reading found in Brysbaert's 190-study meta-analysis, because the viewer is also reading the screen ([Brysbaert, 2019](https://biblio.ugent.be/publication/8647789)). Multiply length by rate and you get a hard script budget.

| Video length | Words of narration (~2.5/s) | Scenes at ~10 s each |
|---|---|---|
| 30 s | ~75 | 3 to 4 |
| 60 s | ~150 | 5 to 6 |
| 90 s | ~225 | 7 to 9 |
| 120 s | ~300 | 10 to 12 |

A scene is one continuous idea on screen: open the dashboard, run the search, read the result. Budget 8 to 12 seconds and 20 to 30 words each. If a scene needs more words than that, it is really two scenes.

## Anatomy of a 60-second demo

Here is a 60-second budget spent on a fictional analytics product, scene by scene. Every line of narration names something visible on screen at that moment, which is the cardinal rule of demo scripting: never say a word the picture cannot back up.

| Time | On screen | Narration |
|---|---|---|
| 0:00 to 0:08 | Cluttered spreadsheet, cursor hunting | "Your weekly report lives in a spreadsheet nobody trusts. Here is the same data in Northstar." |
| 0:08 to 0:20 | Dashboard loads, one metric zooms | "One workspace, every metric live. This is revenue, updating as orders land." |
| 0:20 to 0:34 | Typing a plain-English query | "Ask in plain English, like 'churn by plan, last quarter', and get a chart, not a data-team ticket." |
| 0:34 to 0:48 | Chart renders, a note is added | "Pin it to a board, add a note for context, and it is shareable in one click." |
| 0:48 to 0:60 | Board with teammates' avatars | "Now the whole team reads from the same numbers. Start free at northstar.example." |

That is about 80 words of spoken narration across 60 seconds, comfortably under the 150-word ceiling, because pauses count. The empty seconds between lines are where zoom and motion carry the story. Under-filling the word budget is almost always right; a wall of narration reads as nervous, and it leaves no air for the screen to do its job.

## The seven-step pipeline, and where a machine can stand in

Every demo, however it is made, runs through the same seven steps. What separates a one-hour job from a one-week one is how many of them you perform by hand versus generate from a spec.

| Step | Perform it by hand | Generate it from a spec |
|---|---|---|
| 1. Script | Write and time it | Draft with an LLM, then edit down |
| 2. Record the flow | Click through live, hope for a clean take | Replay a declared action list into a real browser |
| 3. Narrate | Record your voice, redo the flubs | Text-to-speech from the script |
| 4. Caption | Type and time-sync by hand | Word-level speech-to-text on the narration |
| 5. Polish | Keyframe zoom and trims in an editor | Deterministic transforms on the footage |
| 6. Mux and export | Editor render | ffmpeg from a manifest |
| 7. Maintain | Re-record when the UI changes | Re-render the spec in CI |

Only step 1 is inescapably human. Every other row has a generated column, and the further right you sit, the cheaper the seventh row becomes, which is the row that quietly dominates total cost of ownership. [Automated product demo videos](/blog/automated-product-demo-videos) is the long version of that argument.

The arithmetic is worth doing once. A hand-made 60-to-90-second demo is rarely under two or three hours by the time you have scripted it, recorded enough takes to get a clean one, recorded and re-recorded the voice, and keyframed the zooms. That is fine as a one-time cost. The problem is that a live take is atomic: change a single screen and you cannot splice in a replacement without the cursor, timing, and narration drifting out of sync, so a small UI change buys you most of that production cost a second time. A spec-defined demo inverts the ratio. The first render costs about the same authoring effort, but the second one costs a diff and a few minutes of compute, which is the whole difference between a demo you keep current and a demo you quietly let rot.

## Recording the raw take

The raw recording is the easy part, and where most of the tool money goes. Three families, honestly labeled.

| Approach | Platform | Auto-polish | Deterministic re-render | Cost |
|---|---|---|---|---|
| Screen Studio | macOS only | Auto-zoom, cursor smoothing | No, it is a live take | $20/mo, ~$9/mo billed annually |
| OBS Studio | Windows, macOS, Linux | None, raw capture | No | Free, open source |
| Loom and browser recorders | Cross-platform | Light | No | Freemium |
| Code-driven browser replay | Anywhere with Chrome | Applied at compose time | Yes | Varies |

Screen Studio set the polish bar. It auto-zooms on cursor actions and smooths shaky movement with no manual keyframing, but it is a macOS-only app with no shipping Windows build and, since October 2025, subscription-only pricing at $20 a month or about $9 a month billed annually ([Screen Studio, 2026](https://screen.studio/)); if the platform lock rules it out, [the alternatives, mapped by platform and workflow](/blog/screen-studio-alternatives), include several that do run headless. OBS is the free, cross-platform floor: it captures cleanly on Windows, macOS, and Linux and does nothing to the footage afterward ([OBS Project, 2026](https://obsproject.com/)). Both share one limit that matters more than any feature. The take is a live performance, so when the UI changes you perform it again.

The fourth family removes that. Instead of recording a person, you declare the flow, navigate here, click this selector, type that, and a deterministic player replays it into a real Chrome window, identically every time. That is the design behind aidemo, our open-source engine: it is browser-only, and the storyboard is authored by a coding agent rather than dragged around a GUI timeline. The honest tradeoff is that you swap a visual editor for a text file, which is a bad deal for a one-off and a good one for anything you will have to record twice.

## Narration and captions for a feed that plays muted

Two facts govern the audio track. First, landing pages and social feeds autoplay muted by default, so a large share of views never hear a word; the narration you sweated over is optional, and the captions are not. Second, WCAG 2.2 makes captions a Level A requirement: Success Criterion 1.2.2 asks for captions on all prerecorded audio in synchronized media, identifying who is speaking and any meaningful non-speech sound ([W3C, 2023](https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html)). Level A is the floor, not the aspiration.

Captions can be read faster than narration is spoken. Silent reading of English non-fiction averages 238 words per minute against your roughly 150-wpm voice track ([Brysbaert, 2019](https://biblio.ugent.be/publication/8647789)), which is why word-level caption timing, highlighting each word as it is said, reads better than dropping a whole sentence on screen at once. [Captions on demo videos](/blog/demo-video-captions) covers open versus closed captions and the timing mechanics.

For the voice itself, recording yourself is fine for a one-off and miserable for iteration: change one line and you re-record the whole take to match room tone. Text-to-speech removes that tax. OpenAI's speech API, for one, exposes steerable models such as gpt-4o-mini-tts that render a script to audio in seconds and re-render just as fast when the script changes ([OpenAI, 2026](https://developers.openai.com/api/docs/guides/text-to-speech)). It still loses to a good human read on warmth and brand voice; [AI voiceover for demo videos](/blog/ai-voiceover-for-demo-videos) weighs that tradeoff with the per-minute arithmetic.

## Polish, publish, and keep it honest

Polish is editing, not talent. The moves that make a screen recording look produced, zooming in when the cursor acts, smoothing the pointer, cutting dead air, sizing and letterboxing for the target frame, are each a deterministic transform on footage rather than a matter of taste, which is exactly why software can apply them and why [professional-looking screen recordings](/blog/professional-screen-recordings) are a solved mechanical problem. Do not confuse a polished raw take with a finished demo, though. Color and zoom are compose-time decisions you should be able to redo without re-recording.

Then publish where the video will actually be watched. A landing hero wants a muted autoplay loop; a README wants a stable raw URL that renders inline; a sales email wants a thumbnail linking out. Encode once per placement, not once total, and let each channel dictate the aspect ratio and the length you already budgeted.

The last step is the one nobody plans for and everybody pays. The product ships, the UI moves, and the demo now lies about the software it is selling. A hand-recorded take has no cheap fix: you re-perform the whole thing to keep cursor, zoom, and narration timing in sync. A demo defined as a spec has a cheap fix: change the line that moved and re-render, ideally [in CI on the same event that changed the UI](/blog/demo-videos-in-ci). Budget for step seven when you choose your approach at step two, because it is the step you will repeat the most.

## Sources

- [Wistia — How to Choose the Right Marketing Video Length for Any Goal](https://wistia.com/learn/marketing/optimal-video-length)
- [HubSpot — 2024 Video Marketing Report](https://blog.hubspot.com/marketing/video-marketing-report)
- [W3C — Understanding SC 1.2.2: Captions (Prerecorded), WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html)
- [Brysbaert (2019) — How many words do we read per minute? A meta-analysis of reading rate](https://biblio.ugent.be/publication/8647789)
- [Screen Studio — features and pricing](https://screen.studio/)
- [OBS Studio — free and open-source screen recording](https://obsproject.com/)
- [OpenAI — Text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)

## FAQ

### How long should a demo video be for a landing page versus a sales email?

Match the length to the placement. A landing-page hero or social clip should run 30 to 60 seconds, since clips under a minute average a 52% engagement rate in Wistia's data and most marketers in HubSpot's survey put the short-form sweet spot at 21 to 60 seconds. A sales follow-up or onboarding video can stretch to one to three minutes, because the audience is warmer and completing a real task beats raw brevity.

### Do I need a script, or can I record the product walkthrough live?

Write the script first. It is the cheapest artifact to change, and it fixes the length, scene count, and caption text before you spend any time recording. Talking through the product live reliably produces a take that is twice as long as it should be and painful to trim. Draft the narration to a budget of about 2.5 words per second and read it against a stopwatch before you record anything.

### Can I make a demo video without recording my own voice or screen?

Yes. Text-to-speech renders the narration straight from your script, so no microphone is required, and a scripted browser replay can record the screen flow deterministically instead of you clicking through it live. That combination also makes updates cheap: when the product changes, you edit the script or the action list and re-render, rather than re-performing the whole take from scratch.

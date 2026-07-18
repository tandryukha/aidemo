# Accessible tutorial videos: captions, transcripts, audio description

July 18, 2026 · Video Documentation & Tutorials · 8 min read · https://aidemo.top/blog/accessible-tutorial-videos/

> Captions clear one of seven WCAG media checks. The descriptive transcript that serves a Deaf-blind reader is the same text your search box needs.

**Key takeaways**

- “Add captions” clears one of at least seven WCAG 2.2 media checks; six are Level A (captions, transcript, keyboard, audio control, pause/stop/hide) and audio description is AA (1.2.5).
- A transcript is not a caption: captions are timed cues inside the video, a descriptive transcript is page text a Deaf-blind reader, a screen reader, and a search crawler all use.
- Audio description (SC 1.2.5, Level AA) covers silent cursor moments; write self-describing narration (“open the Filters menu top-right,” not “click here”) and you satisfy it with no separate track.
- Autoplay is not exempt: sound-on over 3s needs a pause or mute (SC 1.4.2) and a muted loop over 5s needs a pause control (SC 2.2.2), both Level A.
- Transcript and captions both come from transcribing the narration, so authoring the script for accessibility makes most artifacts fall out of the render instead of being typed by hand.

## “Add captions” answers one line of an accessibility spec that has at least seven

Most teams treat an accessible tutorial video as done the moment a caption track exists. Captions are the visible, well-documented requirement, and they matter, but they answer for exactly one audience on one channel: a viewer who can see the screen and needs the spoken words in text. A tutorial video fails a different set of people in ways a caption never touches. The cursor that glides silently to a gear icon while the narrator says “click here” tells a blind listener nothing. The play button a keyboard-only user cannot reach with Tab leaves the whole video unplayed. And the search box on your own docs site, indexing text and not pixels, cannot find the answer buried in ninety seconds of MP4, which is the same wall a screen reader hits.

That last overlap is the useful one. The artifact that lets a Deaf-blind reader reach your tutorial, a text version of everything the video says and shows, is the same artifact that gives a search engine something to index and a hurried sighted reader something to skim. Accessibility and findability are not two projects competing for one budget line. Done right they are a single piece of work: turn the video’s content into structured text, wire up a player anyone can operate, and account for what the screen does when the narration goes quiet. WCAG 2.2 names each of those, and W3C’s own media guide organizes the same list into description, captions, transcripts, and an accessible player ([W3C WAI, Making Audio and Video Media Accessible](https://www.w3.org/WAI/media/av/)). For a prerecorded tutorial the relevant criteria run to at least seven, only one of which is “add captions.”

## Every media criterion, mapped to a tutorial requirement

WCAG groups time-based media under Guideline 1.2 and adds the player and autoplay rules elsewhere. Stated as standards they read abstractly; the value is pinning each to a concrete thing a product tutorial has to ship.

| WCAG success criterion | Level | What the standard asks | For a product tutorial, that means |
|---|---|---|---|
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | Text alternative for audio-only; text alternative or audio track for video-only | A silent how-to microvideo needs a text description beside it; a voice-only clip needs a transcript |
| 1.2.2 Captions (Prerecorded) | A | Synchronized captions of speech and non-speech audio | A caption track on every narrated clip, carrying the click chime and error tone, not only the words |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | A | Either audio description or a full text alternative | The Level-A escape hatch: a descriptive transcript satisfies this with no separate description track |
| 1.2.5 Audio Description (Prerecorded) | AA | Audio description specifically | Target AA and the transcript stops covering it: visual-only moments must be described in the audio |
| 1.4.2 Audio Control | A | Pause/stop or independent volume for audio auto-playing over 3s | A sound-on autoplay demo needs a visible mute or pause |
| 2.2.2 Pause, Stop, Hide | A | Pause/stop/hide for moving content that auto-starts, runs over 5s, sits beside other content | A muted hero loop past five seconds needs a pause control |
| 2.1.1 Keyboard | A | All functionality operable by keyboard | Play, pause, scrub, volume, and the captions toggle all reachable by Tab and Enter |

Read the levels first. Everything at Level A is the floor, WCAG’s base tier and the one most legal accessibility commitments reference. Six of the seven rows sit there, which is worth stating plainly, because the common belief that captions alone clear the bar is wrong even at the lowest conformance level. The 1.2.1 requirement for video-only content is the one people forget most: a silent GIF or wordless microvideo carries no audio to caption, so it needs a text description or an audio track instead ([W3C, WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/audio-only-and-video-only-prerecorded.html)). The single Level-AA row, audio description under 1.2.5, is the one most tutorials quietly skip. Captions themselves are a deep enough subject to have [their own timing, format, and WCAG treatment](/blog/demo-video-captions); the next three sections are the rest of the map, starting with the two rows teams miss most.

## The transcript is a separate document, and it doubles as your search text

A caption and a transcript are not the same deliverable, and conflating them is why so many “accessible” videos still fail. A caption is a timed cue that lives inside the video, appearing and vanishing in step with the audio; re-host the MP4 in a player that ignores the sidecar and the caption goes with it. A transcript is a standalone block of text on the page: HTML the browser renders, the screen reader speaks at the reader’s own pace, and the crawler indexes like any other paragraph.

WAI draws a sharper line inside the transcript itself. A basic transcript is the speech and non-speech audio written out, the same content captions carry, in document form. A descriptive transcript adds text descriptions of the visual information, and WAI names the audience that needs it: people who are Deaf-blind, who read a braille display and neither see the screen nor hear the audio ([W3C WAI, Transcripts](https://www.w3.org/WAI/media/av/transcripts/)). For a UI tutorial the descriptive version is the one that carries weight, because the whole point of the video is visual, which control and which panel in what order, and a basic transcript of “click here, then here” describes none of it.

Here the two jobs collapse into one. The descriptive transcript is also the richest text your video will ever hand a search engine. A ninety-second MP4 is opaque to a crawler; the transcript beneath it is a keyword-dense account of the exact task users search for, and WAI notes that giving it headings and links “also helps with SEO” ([W3C WAI, Transcripts](https://www.w3.org/WAI/media/av/transcripts/)). The [text a video page needs to rank](/blog/video-seo-for-product-pages) and the text a Deaf-blind reader needs to follow along are the same text. Produce it once, satisfy both. It also clears the Level-A choice in SC 1.2.3, which accepts a full text alternative in place of an audio description ([W3C, WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded.html)), so a good descriptive transcript is doing at least three jobs before you have recorded a second of description.

## Audio description, or a script that describes itself

The moment captions cannot rescue is the silent one: the narrator pauses, the cursor slides across the screen, a menu opens, and a viewer who cannot see it has no idea what happened. WCAG’s answer is audio description, spoken narration added in the gaps that says what the picture shows. SC 1.2.5 makes it a Level-AA requirement for all prerecorded video, and it is stricter than the Level-A rule before it: 1.2.3 let you swap in a text alternative, while 1.2.5 removes that option and asks for the description in audio ([W3C, WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/audio-description-prerecorded.html)). The standard’s own out is the useful part: if everything important in the picture is already spoken in the main soundtrack, no separate description is needed.

That out is a design instruction for anyone scripting a demo. A tutorial’s narration is written before it is recorded, which means you can write it to describe the screen in the first place, a technique WAI calls integrated description, where the account of what is happening is “naturally woven into the script for the main speaker” and which it recommends as “usually best for most training videos” ([W3C WAI, Description](https://www.w3.org/WAI/media/av/description/)). Compare two versions of one line:

- Leans on the picture: “Now click here, and you’ll see it update over there.”
- Describes itself: “Open the Filters menu in the top-right toolbar, choose Last 30 days, and the table below reloads with the narrower range.”

The second needs no separate description track, because the words already carry what the cursor is doing. It reads a little more deliberately, and it is better narration for everyone: the caption inherits the same specific words, the transcript becomes genuinely descriptive at no extra cost, and a sighted viewer with a busy screen is told exactly where to look. Where a demo truly cannot avoid a wordless stretch, a long animated transition or a build console scrolling, the fallback is a real description track, which HTML exposes through a `<track kind="descriptions">` pointing at a WebVTT file for the browser to synthesize as speech ([MDN, The track element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)). Browser and screen-reader support for that kind is thin, though, so self-describing narration plus a descriptive transcript is the more dependable path, and it is one you author rather than bolt on.

## The player has to work without a mouse

Everything so far assumes the viewer can start the video. A keyboard-only user, someone with a motor disability or anyone driving the page by keyboard, has to reach the play button, the scrubber, the volume, and the captions toggle with Tab and Enter, and see where the focus sits while doing it. SC 2.1.1 makes keyboard operability of all functionality a Level-A requirement ([W3C, WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html)), and WAI’s media-player guidance is concrete about the cost: “provide keyboard support,” “make the keyboard focus indicator visible,” and build a player that “works without a mouse” and with screen readers ([W3C WAI, Media Players](https://www.w3.org/WAI/media/av/player/)). The native HTML `<video controls>` element gets most of this for free; a custom player skinned for brand reasons is where keyboard access quietly breaks, so test it with the mouse unplugged.

Autoplay adds two rules teams forget because the clip seems harmless. A demo that plays sound automatically for more than three seconds must offer a way to pause or stop it, or independent volume control, under SC 1.4.2 at Level A ([W3C, WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/audio-control.html)). And a muted hero loop is not exempt: any content that moves automatically, runs longer than five seconds, and sits alongside other content needs a pause, stop, or hide control under SC 2.2.2, also Level A ([W3C, WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)). The looping muted demo that so many pages [autoplay above the fold](/blog/autoplay-video-on-website) is exactly that moving content, and a surprising number ship with no way to stop it. A visible pause button is the entire fix.

## Making accessibility and findability one build step

Accessible tutorials get skipped because they look like four extra deliverables, captions, a transcript, a description pass, an audited player, bolted onto a finished video by hand. They are cheaper than that, because three of the four come from one source: the script. Narration written to describe itself is already the audio description. Transcribing that exact narration with word-level timing produces the caption track, and the [same speech-to-text step behind captions](/blog/demo-video-captions) emits the transcript as a byproduct; folding the visual descriptions from the script into it makes it descriptive. The player is a one-time template choice. Author the script for accessibility and most of the artifacts fall out of the render.

That is also what keeps them honest. A transcript typed by hand after the fact drifts the moment the UI changes and the video is re-recorded; a transcript generated from the same source as the video rebuilds with it. This is the discipline the [broader case for video documentation](/blog/video-documentation) rests on: treat the demo as something regenerated from a spec, not re-recorded by hand, and its accessible text regenerates too. Our own engine, aidemo, works this way, with captions and transcript both coming from transcribing the narration audio, so they rebuild whenever the demo does, and with the limits worth stating plainly: it captures a browser only, an agent authors the storyboard instead of a person editing a timeline, and there is no visual editor for nudging a caption or a description into place. The tool is incidental. The principle is that the words a blind reader, a Deaf-blind reader, and a search crawler all need are the same words, produced once from the script the video was built on.

## Sources

- [W3C WAI — Making Audio and Video Media Accessible](https://www.w3.org/WAI/media/av/)
- [W3C — Understanding SC 1.2.1: Audio-only and Video-only (Prerecorded), WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/audio-only-and-video-only-prerecorded.html)
- [W3C — Understanding SC 1.2.3: Audio Description or Media Alternative (Prerecorded), WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded.html)
- [W3C — Understanding SC 1.2.5: Audio Description (Prerecorded), WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/audio-description-prerecorded.html)
- [W3C — Understanding SC 1.4.2: Audio Control, WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/audio-control.html)
- [W3C — Understanding SC 2.1.1: Keyboard, WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html)
- [W3C — Understanding SC 2.2.2: Pause, Stop, Hide, WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)
- [W3C WAI — Transcripts (basic and descriptive)](https://www.w3.org/WAI/media/av/transcripts/)
- [W3C WAI — Description of Visual Information (integrated and separate)](https://www.w3.org/WAI/media/av/description/)
- [W3C WAI — Accessible Media Players](https://www.w3.org/WAI/media/av/player/)
- [MDN — The Embed Text Track element (track), kind values and WebVTT](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)

## FAQ

### What is a descriptive transcript, and how is it different from captions?

Captions are timed text cues that appear inside the video in sync with the audio; a transcript is a standalone text document on the page. A basic transcript writes out the speech and non-speech audio, the same content captions carry. A descriptive transcript goes further, adding text descriptions of the visual information, which is what a Deaf-blind reader on a braille display needs and what turns the transcript into a full account of a UI tutorial rather than a list of unplaced clicks. That descriptive version is also the text a search engine indexes, so it serves accessibility and findability at once.

### Do tutorial videos need audio description?

Under WCAG 2.2, prerecorded video needs audio description at Level AA (SC 1.2.5) whenever the picture carries information the soundtrack does not, and a tutorial full of silent cursor movements and menu changes usually does. The efficient fix is to avoid the gap in the first place: script the narration to name what it is doing, “open the Filters menu in the top-right” rather than “click here,” which WAI calls integrated description and recommends for most training videos. If everything important on screen is already spoken, no separate description track is required.

### How do I make a video player keyboard accessible?

Every control, play, pause, scrub, volume, and captions, has to be reachable and operable with the keyboard alone, and the focus indicator has to stay visible as you Tab through them, per WCAG SC 2.1.1 at Level A. The native HTML `<video controls>` element provides this out of the box; custom-skinned players are where it usually breaks. Test by unplugging the mouse and driving the whole player with Tab, Enter, and the arrow keys, and if any control is unreachable, it is not accessible yet.

# Screen recording without the mouse cursor (or with a better one)

July 18, 2026 · Screen Recording · 7 min read · https://aidemo.top/blog/screen-recording-without-cursor/

> A captured cursor can't be cleanly removed later, so hiding it is a record-time switch. The per-tool cheat sheet, and the pro move that beats hiding it.

**Key takeaways**

- A captured cursor is baked into the pixels — there is no clean way to remove it in post, so hiding it is a record-time switch, not an edit.
- The per-tool switch: OBS uncheck Capture Cursor; ffmpeg -draw_mouse 0 (x11grab and gdigrab, default 1); macOS uncheck Show Mouse Pointer; getDisplayMedia cursor: never.
- The getDisplayMedia cursor constraint has three values — never, always, motion; motion shows the pointer while it moves and fades it a moment after it stops.
- A scripted or headless render has no OS cursor at all, so the pro move is not hiding the pointer but drawing a smooth synthetic one to each target.
- Decide by whether the pointer teaches anything: hide it for previews and keyboard flows; keep and enlarge it for live sales and click-here how-tos.

## You can't subtract a cursor in post

A screen recording is mostly a story about where to look, and the mouse pointer is the loudest thing in the frame telling that story. Captured raw, it also tells a second story you did not mean to: a small, jittery arrow that overshoots its target and drifts while you read is the clearest single sign a human recorded this live. That raises the question people type into a search box, how do you record without it, and a quieter one underneath it, once you have the take can you take the cursor back out.

You cannot, not cleanly. Whether the operating-system pointer lands in the video is decided the instant you press record, and it is decided in the pixels. If the cursor was drawn onto frame 900, it is now part of frame 900, fused to whatever button it was hovering over; removing it means reconstructing the covered region on every frame it appears, which is a visual-effects job and not a checkbox. This is the same one-way rule that governs resolution and a clean profile in [the capture-quality checklist](/blog/how-to-record-your-screen-in-high-quality): some things are re-derivable at compose time and some are baked at record time, and the cursor sits firmly in the second column. So "screen recording without the cursor" is not an editing setting you reach for afterward. It is a switch you flip before the take.

The good news is that almost every capture tool ships that switch. Here it is, per tool, with the exact name to look for.

## The switch that kills the cursor, per tool

Each of these removes the pointer at capture time, so the recorded frames never contain it to begin with.

| Tool / method | The exact switch | Platform | Default |
|---|---|---|---|
| OBS Studio | uncheck **Capture Cursor** on the Display / Window / Game Capture source | Win, macOS, Linux | cursor drawn |
| ffmpeg `x11grab` | add `-draw_mouse 0` | Linux (X11) | `1`, pointer drawn |
| ffmpeg `gdigrab` | add `-draw_mouse 0` | Windows | `1`, pointer drawn |
| macOS Screenshot toolbar (Shift-Cmd-5) | Options, uncheck **Show Mouse Pointer** | macOS | on when checked |
| Browser `getDisplayMedia` recorder | request `cursor: "never"` | any getDisplayMedia capture | user-agent default |
| Headless / scripted render | no OS pointer exists; `cursor: none` hides any element cursor | any | no cursor |

OBS labels the control exactly **Capture Cursor** in its shipped source strings, and the toggle rides along on the display, window, and game capture sources alike ([OBS Studio, source labels, 2026](https://raw.githubusercontent.com/obsproject/obs-studio/master/plugins/win-capture/data/locale/en-US.ini)). Uncheck it and OBS composites the frame without the system pointer.

On the command line the option carries the same name on both platforms where it matters. FFmpeg's `x11grab` input takes `draw_mouse` to "specify whether to draw the mouse pointer. A value of 0 specifies not to draw the pointer," with a default of 1; `gdigrab`, the Windows GDI grabber, documents the identical option, "use the value 0 to not draw the pointer" ([FFmpeg, devices, 2026](https://ffmpeg.org/ffmpeg-devices.html)). So `ffmpeg -f x11grab -draw_mouse 0 -i :0.0 out.mp4` on Linux and the matching `-f gdigrab -draw_mouse 0` on Windows both write the screen with the pointer omitted.

macOS keeps its built-in path simple. The Screenshot toolbar you raise with Shift-Command-5 has an Options menu with a **Show Mouse Pointer** entry, and leaving it unchecked records without the pointer ([Apple Support, 2026](https://support.apple.com/guide/mac-help/take-screenshots-or-screen-recordings-mh26782/mac)). There is no separate hide control to hunt for; the visibility is that one checkbox.

The browser is the interesting row, because there the pointer is a first-class capture constraint rather than a paint step. A recorder built on `getDisplayMedia()` can ask for a `cursor` value of `never`, `always`, or `motion`. MDN spells them out: `never` means "the mouse cursor is never included in the shared video," `always` keeps it visible, and `motion` says the cursor "should always be included in the video if it's moving, and for a short time after it stops moving" ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/cursor)); the Screen Capture specification carries the same three-value enum, with `motion` including the cursor "when the cursor/pointer is moved" and removing it after a pause ([W3C, Screen Capture, 2026](https://w3c.github.io/mediacapture-screen-share/)). That `motion` value is the quiet gem: it shows the pointer while it travels and fades it when it parks, which is close to what a demo actually wants and impossible to coax out of a physical mouse.

The last row is not a switch at all, and it is the cleanest of the set. A scripted or headless browser render, the kind that captures [one tab under program control](/blog/record-a-browser-tab), has no operating-system pointer to capture, because there is no mouse and often no desktop session running. Nothing draws a cursor unless you ask it to, and any stray CSS cursor sitting over an element is removed with `cursor: none`, which MDN defines as simply "no cursor is rendered" ([MDN, CSS cursor, 2026](https://developer.mozilla.org/en-US/docs/Web/CSS/cursor)). You do not turn the cursor off. It was never on.

## Why you would want no cursor at all

Hiding the pointer sounds like discarding information, so it is worth being precise about when it is the right call.

- **A poster frame or store preview.** An [app-store preview or thumbnail](/blog/app-preview-video) is about the UI, and a frozen arrow parked on a button is pure noise in a still that has to sell the screen at a glance.
- **A keyboard- or command-line-driven flow.** If the demo is someone typing commands or tabbing through a form, there is nothing for a pointer to point at, and a cursor idling in a corner only pulls the eye away from the keys.
- **A rendered, unattended demo.** When the video regenerates on every UI change, there is no hand on a mouse to smooth. The take is a [deterministic replay](/blog/deterministic-browser-automation-for-video), so a captured pointer would be a liability, not a feature.

The thread through all three is the same: hide the cursor when the pointer carries no information the viewer needs. When it does carry information, this is the control I clicked, watch it respond, hiding it is the wrong move, and so is leaving the raw one in. There is a third option, and it is the one most people are actually looking for.

## The better cursor: replace it, don't just remove it

The reason people search for "record without the cursor" is usually not that they want no pointer. It is that they want no bad pointer. The real mouse path between two clicks is high-frequency noise, and rendered faithfully that noise is the amateur tell. Switching the cursor off removes the noise by removing the signal. What a produced demo does instead is remove the real pointer and draw a synthetic one that travels a smooth, eased arc between the targets that matter.

The mechanics of that smoothing, fitting a curve through the sampled points and resampling it at the frame rate, plus the click ripple that lands the eye, belong to [the anatomy of a professional recording](/blog/professional-screen-recordings), and there is no reason to re-derive them here. The point for this page is the decision, not the math. Once you accept that the cursor is a capture-time choice, you have three treatments rather than two: capture the real one, hide it entirely, or hide the real one and render a synthetic one on top. The last is exactly what the browser's `motion` constraint gestures at and what a scripted pipeline gets for nothing, because a headless render begins with no pointer and adds only the one you specify.

That is the bet our own engine, aidemo, makes, and honesty requires disclosing both that it is ours and where it stops. Because it drives a browser tab through an agent-authored storyboard instead of a hand on a mouse, there is no OS cursor to capture, so it draws a synthetic pointer along an eased path to each target and never renders a jittery one. The limits are the shape of that design: it records a browser tab and nothing native, the storyboard is authored as code instead of nudged on a drag-and-drop timeline, and no visual editor exists. For a one-off clip you will perform exactly once, unchecking Capture Cursor in OBS is far less setup than any of that.

## Pick the treatment by what the demo is for

Hide, tame, or replace is a decision you can read off the job rather than argue about as taste.

| The recording | Cursor treatment | Why |
|---|---|---|
| Landing-page or launch walkthrough | synthetic, smoothed pointer | the eye has to follow the action; raw jitter reads amateur |
| App-store preview or poster frame | hidden | the frame sells the UI; a parked arrow is noise |
| Keyboard, CLI, or form-fill flow | hidden | there is nothing to point at |
| Live sales or talking-head demo | real pointer, enlarged, click highlights | authenticity matters; a tamed live cursor is honest |
| CI-rendered or auto-updating demo | synthetic by construction | no mouse on a headless runner to begin with |
| Click-here support how-to | real or enlarged, with a click ripple | the pointer location is the instruction |

The column that trips people up is the middle one. A live sales recording or a support how-to is exactly where the cursor carries information, where I clicked is the lesson, so hiding it defeats the video. There the fix is not removal but size and feedback: enlarge the pointer through your operating system's accessibility settings and turn on click highlights so the viewer's eye lands where yours did. Everywhere the pointer is decoration rather than instruction, hide it or replace it. That one question, does the pointer teach anything here, sorts the treatment more reliably than any style guide, and it is a question you can answer before you record, which is the only time the answer is cheap to act on.

## Sources

- [FFmpeg — devices documentation (x11grab and gdigrab draw_mouse option)](https://ffmpeg.org/ffmpeg-devices.html)
- [MDN — MediaTrackSettings: cursor (never, always, motion)](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/cursor)
- [W3C — Screen Capture specification (cursor constrainable property)](https://w3c.github.io/mediacapture-screen-share/)
- [MDN — CSS cursor property (the none value)](https://developer.mozilla.org/en-US/docs/Web/CSS/cursor)
- [Apple Support — Take screenshots or screen recordings on Mac (Show Mouse Pointer)](https://support.apple.com/guide/mac-help/take-screenshots-or-screen-recordings-mh26782/mac)
- [OBS Studio — capture source UI strings (Capture Cursor label)](https://raw.githubusercontent.com/obsproject/obs-studio/master/plugins/win-capture/data/locale/en-US.ini)

## FAQ

### How do I record my screen without showing the mouse cursor?

Flip the capture-time switch in your tool. In OBS, uncheck Capture Cursor on the display or window source. With ffmpeg, add `-draw_mouse 0` to an `x11grab` (Linux) or `gdigrab` (Windows) capture, since both default to drawing the pointer. On a Mac, open the Shift-Command-5 toolbar and uncheck Show Mouse Pointer under Options. A browser recorder built on getDisplayMedia can request a `cursor` value of `never`. Each removes the pointer before it is written to the file, and there is no reliable way to strip it out afterward, so decide before you record.

### Can I remove the mouse cursor from a video after recording?

Not cleanly. Once a frame is captured with the pointer drawn on it, the cursor is part of the image, sitting on top of whatever it was hovering, so removing it means reconstructing the covered pixels on every frame it appears, which is a manual visual-effects job rather than a setting. The practical answer is to prevent it at capture time with your tool's cursor toggle, or to record a scripted or headless take that never had an operating-system pointer in the first place.

### Should a demo video show the mouse cursor or not?

It depends on whether the pointer teaches the viewer anything at that moment. In a landing-page walkthrough or an app-store preview the pointer is decoration, so hide it or replace the jittery real one with a smooth synthetic pointer. In a live sales demo or a click-here support video the pointer location is the instruction, so keep it, but enlarge it and add click highlights so it reads clearly. When in doubt, ask what the cursor is telling the viewer; if the answer is nothing, take it out.

# Headless screen recording: capturing a screen with no display

July 18, 2026 · Screen Recording · 7 min read · https://aidemo.top/blog/headless-screen-recording/

> Recording a screen with no monitor forks two ways: grab a virtual X display with ffmpeg, or pull frames from a browser that never paints. When each wins.

**Key takeaways**

- Headless recording forks two ways: Xvfb + ffmpeg x11grab grabs a virtual X11 display in RAM (any GUI app), or a headless browser emits its own frames (web pages only, no display server).
- Xvfb is 'an X server that can run on machines with no display hardware'; set -screen 0 1280x720x24, then grab it: ffmpeg -f x11grab -framerate 30 -i :99.
- Chrome's new headless (Chrome 112+) runs the full browser, not the old stripped-down shell, so what you record with no display matches what a user actually sees.
- Frame timing differs: x11grab samples on a wall clock (dups or drops frames); CDP Page.startScreencast emits one frame per paint and acks each, so you re-time to a constant rate.
- getDisplayMedia can't run headless (needs a gesture and a screen); a missing display also means no cursor and no audio, so inject a synthetic pointer and mux narration in post.

## Two ways to record a screen that isn't there

"Headless" hides a fork. Wanting to record a screen with no display attached — a container, a build server, a CI runner with no monitor, no GPU, and no window manager — turns out to mean one of two mechanically different things, and conflating them is why so many x11grab recipes on the internet quietly produce a black rectangle.

The first way keeps a screen and moves it into memory. Xvfb, the X virtual framebuffer, is "an X server that can run on machines with no display hardware and no physical input devices" and "emulates a dumb framebuffer using virtual memory" ([X.Org, 2026](https://xorg.freedesktop.org/archive/current/doc/man/man1/Xvfb.1.xhtml)). You start it, point a GUI application at it through the `DISPLAY` variable, and the app paints into RAM exactly as it would paint onto a monitor. There is a screen; nobody can see it. ffmpeg then grabs that virtual screen the same way it grabs a physical one.

The second way has no screen at all. A modern headless browser never opens a window: since Chrome 112 the redesigned headless mode "creates, but doesn't display, any platform windows" ([Chrome for Developers, 2026](https://developer.chrome.com/docs/chromium/new-headless)), and it runs the full browser code rather than the stripped-down alternate implementation the old mode used. Because nothing is ever composited to a display surface, there is no framebuffer to grab. You ask the browser for its frames directly and assemble the video from those.

So the fork is: record a virtual display, or record an application that draws to no display. The first is application-agnostic and needs a display server; the second is browser-only and needs none. What follows maps each path, the frame-timing gap between them where footage tends to go wrong, what a missing display quietly takes with it, and a table for choosing. This is the capture layer underneath [any demo video a CI job renders](/blog/demo-videos-in-ci): the pipeline is the runner and the triggers; this is how the pixels get made.

## Path one: a virtual display in RAM, grabbed by ffmpeg

Xvfb gives the app a screen to draw on; ffmpeg's x11grab turns that screen into video. x11grab is FFmpeg's "X11 video input device" and "allows one to capture a region of an X11 display" ([FFmpeg, 2026](https://ffmpeg.org/ffmpeg-devices.html)) — the same device you would use to grab a physical desktop, pointed at a virtual one instead.

```sh
Xvfb :99 -screen 0 1280x720x24 &   # a virtual screen in RAM: 1280x720, 24-bit
export DISPLAY=:99

google-chrome --window-size=1280,720 https://app.example.com &   # any X11 app paints into it

ffmpeg -f x11grab -video_size 1280x720 -framerate 30 -i :99 \
       -c:v libx264 -crf 18 -pix_fmt yuv420p demo.mp4   # grab the virtual framebuffer
```

The `-screen 0 WxHxD` argument sets the virtual screen's width, height, and color depth; the built-in default is a modest 1280x1024x8, so always name your own. ffmpeg's `-i :99` reads the display the `DISPLAY` variable points at, and x11grab defaults to a 30000/1001 frame rate you should override to a clean 30. If wiring the display up and tearing it down by hand is more than you want, `xvfb-run` wraps a command in a throwaway display: Playwright's own CI guide notes that on Linux agents "headed execution requires Xvfb to be installed" and that you "add xvfb-run before the actual command," as in `xvfb-run npx playwright test` ([Playwright, 2026](https://playwright.dev/docs/ci)).

The reason to reach for this path is breadth: it records anything that can draw to X11, not just a web page — a native Linux GUI app, an Electron build, a desktop tool, a browser in headed mode. If the subject of the demo is not a website, this is the only one of the two paths that can film it. The one caveat is the display server itself: Xvfb is an X11 tool, so a pure-Wayland box needs a headless Wayland compositor instead, which is [its own branch of the Linux capture story](/blog/record-screen-on-linux).

## Path two: frames pulled from a browser that never paints

When the subject is a web page, you can skip the display entirely and take frames from the browser itself. The DevTools Protocol exposes the raw mechanism: `Page.startScreencast` streams the page through the `screencastFrame` event, each frame a "Base64-encoded compressed image" in `jpeg` or `png` at a chosen `quality` and throttled by `everyNthFrame`, and every frame must be acknowledged with `Page.screencastFrameAck` before the next is sent ([Chrome DevTools Protocol, 2026](https://chromedevtools.github.io/devtools-protocol/tot/Page/)). That is a stream of stills with metadata, not a video; you re-time and encode them yourself.

Higher-level tools wrap that loop. Puppeteer's `page.screencast()` records straight to a file — "you must have ffmpeg installed on your system," and it writes WebM with the VP9 codec at 30 fps by default (Puppeteer 25.3.0) — collapsing the whole thing to a few lines:

```js
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
await page.goto('https://app.example.com');
const recorder = await page.screencast({ path: 'demo.webm' });
// drive the flow…
await recorder.stop();
await browser.close();
```

Playwright records the whole context instead: pass `recordVideo` to `newContext`, and "videos are saved upon browser context closure," sized from the viewport ([Playwright, 2026](https://playwright.dev/docs/videos)). Both run with no display, because they never needed one — the frames come out of the browser's compositor, which does not care whether a monitor exists.

One route this path cannot borrow from the [three browser-tab capture surfaces](/blog/record-a-browser-tab): the `getDisplayMedia()` share-picker is off the table headless. It requires a user gesture and a screen to raise the "Choose what to share" dialog, and a runner has neither. Headless browser capture is always frame-pull or screencast, never the WebRTC screen-share API.

## Why the two paths disagree about what a frame is

x11grab is a screen-grabber on a metronome. It samples the virtual framebuffer at the frame rate you asked for — thirty times a second, whatever the app is doing. If a paint takes longer than one frame interval, the grab captures the same pixels twice and you ship a duplicated frame; if the UI animates faster than the sample rate, the motion between two samples is simply gone. The timeline belongs to the clock, not the application.

The screencast path inverts that. `Page.startScreencast` emits a frame when the page changes, and because each frame waits for its acknowledgment, the browser paces the stream to what the renderer actually produced. That is frame-accurate to the render, but it is not constant-rate: idle stretches emit nothing and busy stretches emit bursts, so before it becomes a video you have to re-time those frames onto a constant frame rate. A constant frame rate is what nearly every downstream tool assumes anyway.

The upshot is that neither path hands you a repeatable video for free. A wall-clock grab of a flow that paints a little differently each run lands its samples on different instants; an event-driven stream whose timing rides on the network emits a different burst each run. Getting the same pixels twice is [a separate discipline of pinned waits, a frozen clock, and a fixed viewport](/blog/deterministic-browser-automation-for-video) layered over whichever path you pick. The capture mechanism decides what a frame is; it does not decide whether two runs agree.

## What a missing display quietly takes with it

A headless environment removes more than the monitor, and two absences bite in the frame.

The cursor goes first. On path one the pointer is a real X cursor, which x11grab draws by default and omits with `draw_mouse 0` ([FFmpeg, 2026](https://ffmpeg.org/ffmpeg-devices.html)) — but with no human moving it, it sits frozen in a corner until your automation warps it somewhere, and even then it jumps rather than glides. On path two there is no OS cursor in the frame at all, because there is no OS window. Either way a credible pointer is something you [draw as a synthetic overlay](/blog/professional-screen-recordings) at compose time, not something the capture supplies. These are the same record-time-versus-edit-time lines the [high-quality capture checklist](/blog/how-to-record-your-screen-in-high-quality) draws, seen from the headless side.

Audio goes next. A runner has no sound card, so both paths record silence: the screencast carries no audio channel whatsoever, and the Xvfb path can be handed a dummy sink (a null PulseAudio or ALSA device) only so an app that expects one does not crash — it still plays to nothing. For a narrated demo the honest model is to render the video silent and mux the voiceover in afterward. Fonts are the third quiet gap, since a runner missing a font family paints tofu boxes where the glyphs should be, but that is a matter of provisioning the image rather than the capture step.

## Picking a path: virtual display or frame pull

| | Xvfb + ffmpeg x11grab | Headless browser (CDP, Puppeteer, Playwright) |
|---|---|---|
| What it records | a virtual X11 display in memory | the browser's own render output |
| Can capture | any X11 app: native, Electron, a headed browser | a web page only |
| Display server | a virtual one (Xvfb), X11 | none needed |
| Frame timing | wall-clock sampled at N fps, may dup or drop | event-driven per paint, re-timed to a constant rate |
| Encoder | ffmpeg, any codec and CRF | WebM/VP9 in Puppeteer, or your own from CDP frames |
| Cursor | real X pointer (draw_mouse 0 or 1) | none in frame; inject a synthetic one |
| Audio | dummy sink possible, still silent | none; mux narration in post |
| Setup | wire up a display, the app, and ffmpeg | one library call, no display |

Read the top two rows first, because they usually settle it. If the subject is not a browser, path one is the only option, and you take the wall-clock grab and the wiring with it. If the subject is a web app, path two is less to stand up, cleaner in the frame — no window chrome, no stray X cursor — and it is the path a demo engine takes on a CI box with no monitor.

That is where aidemo, our own engine, sits: it takes the second path, driving a real Chrome and pulling frames with no display, so one storyboard renders the same on a laptop and on a display-less runner. The honest limits are the path's limits made specific. Because it is frame-pull from a browser, it records a browser only — a native desktop app is precisely the path-one case it cannot cover; its storyboards are authored by a coding agent in code, not dragged on a GUI timeline; and it has no click-to-trim editor. For a native app on a headless machine, Xvfb and x11grab are still the answer.

## Sources

- [Chrome DevTools Protocol — Page domain (startScreencast, screencastFrame, screencastFrameAck)](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
- [FFmpeg — Device documentation (x11grab input device)](https://ffmpeg.org/ffmpeg-devices.html)
- [X.Org — Xvfb manual page (virtual framebuffer X server, -screen WxHxD)](https://xorg.freedesktop.org/archive/current/doc/man/man1/Xvfb.1.xhtml)
- [Chrome for Developers — Chrome Headless mode (new vs old, Chrome 112)](https://developer.chrome.com/docs/chromium/new-headless)
- [Puppeteer — Page.screencast() API (WebM/VP9, requires ffmpeg)](https://pptr.dev/api/puppeteer.page.screencast)
- [Playwright — Videos (recordVideo, saved on context close)](https://playwright.dev/docs/videos)
- [Playwright — Continuous Integration (xvfb-run for headed Linux)](https://playwright.dev/docs/ci)

## FAQ

### Can you record a screen with no monitor attached?

Yes, two ways. Run a virtual display server — Xvfb, "an X server that can run on machines with no display hardware" — draw your app into it, and grab that virtual screen with ffmpeg's x11grab; this films any GUI app. Or, for a web page, run a headless browser that emits its own frames through the DevTools Protocol and never needs a display at all. The first is application-agnostic; the second is browser-only and simpler to stand up.

### How do I record a headless browser to a video file?

Drive it from code. Puppeteer's `page.screencast({ path: 'out.webm' })` records to WebM and needs ffmpeg installed; Playwright's `recordVideo` on the browser context saves a video when the context closes; or pull frames yourself over the DevTools Protocol's `Page.startScreencast` and encode them into a constant-rate video. All three run with no display. The one thing that will not work headless is `getDisplayMedia()`, which needs a user gesture and a screen to raise its share dialog.

### Does Xvfb record the screen on its own?

No. Xvfb is only a display server — a framebuffer living in virtual memory — so it draws the application but writes no video file. To capture it you point a separate grabber at its display, usually `ffmpeg -f x11grab -i :99`, which reads the virtual screen and encodes it. Treat Xvfb as the monitor you cannot see and ffmpeg as the recorder plugged into it.

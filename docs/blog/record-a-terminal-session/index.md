# How to record a terminal session (and when to skip the video)

July 18, 2026 · Screen Recording · 7 min read · https://aidemo.top/blog/record-a-terminal-session/

> A terminal is characters, not pixels, so you can record it as copyable text, a GIF, or a re-renderable tape. Pick by where the demo has to live.

**Key takeaways**

- A terminal is characters, not pixels: an asciicast stores the text (kilobytes, copy-pasteable), a screen recording stores pixels (megabytes, uncopyable), a vhs tape regenerates on demand.
- Skip recording when the value is the commands: a fenced code block is copyable, diffable, greppable, weightless, and screen-reader friendly. Record only when timing or output is the point.
- asciinema's Rust 3.x CLI writes zstd casts at ~8% of the original size, so a multi-minute session is a few KB versus a multi-MB GIF of the same run.
- A GitHub README has no asciicast player, so convert the cast to a GIF with agg or vhs and keep it under GitHub's 10 MB image cap.
- On Linux, util-linux `script` plus `--log-timing` records a replayable session with zero installs; scriptreplay plays it back at the original speed.

## Record the characters, or photograph them

Almost everything on your screen can only be captured as pixels. A terminal is the exception. What scrolls past in a shell is a stream of characters and a handful of control codes, and you get to decide whether to preserve that stream as text or flatten it into a picture the way a screen recorder flattens a window. That single choice, made before you press record, decides whether the demo weighs kilobytes or megabytes, whether a reader can select and paste the commands, and whether the recording still works the next time the tool changes.

Three capture modes fall out of it. You can record the text stream itself and replay it in a player. You can point a screen recorder at the terminal and get an MP4 or GIF like any other window. Or you can skip live capture entirely and drive a scripted terminal from a committed file that re-renders on demand. Each is right for a different destination, and a fourth option beats all three more often than people admit: not recording at all.

## The demo you can skip recording entirely

Before reaching for any recorder, ask what the reader actually needs from the terminal. If the value is the commands themselves, the correct artifact is usually a fenced code block, not a video of you typing it. A code block is copy-pasteable, diffable in review, greppable by search engines and by the reader's own browser, weightless, and legible to a screen reader. No recorder produces an artifact with all five of those properties. A recording of a command someone then has to retype by squinting at pixels is strictly worse than the two lines of text it depicts.

Motion earns its place only when the value is in the timing or the output, not the input: a long-running build whose progress bar you want to show crossing the finish line, a TUI whose layout redraws as you move, an interactive prompt, the felt speed of a command that returns instantly. When the terminal does something over time that a static block cannot convey, you have a real reason to record. Everything below assumes you have one.

## Text-stream capture: asciinema and the built-in script command

The lightest recording keeps the terminal as text. asciinema writes each session to an asciicast file: a header line of metadata, then one JSON line per event, each holding a timestamp and the bytes your terminal printed ([asciinema, 2026](https://docs.asciinema.org/manual/asciicast/v2/)). Because it stores the characters rather than a grid of pixels, the file is small and the text stays real, so a viewer can pause the web player and select the commands straight out of it. The current CLI is a 3.x rewrite in Rust that can also write zstd-compressed casts at, by its own measurement, "8% of the original size on average" ([asciinema, 2026](https://github.com/asciinema/asciinema)), which puts a multi-minute session at a handful of kilobytes on disk. The newer asciicast v3 format keeps the same one-line-per-event shape but switches to relative intervals between events and is deliberately not backward compatible with v1 and v2 ([asciinema, 2026](https://docs.asciinema.org/manual/asciicast/v3/)).

You do not have to install anything to get the same idea on a Linux box. The util-linux `script` command "makes a typescript of everything on your terminal session," and with `--log-timing` it writes the timing data that is "necessary to replay the session later by scriptreplay(1)" ([man7, 2026](https://man7.org/linux/man-pages/man1/script.1.html)). macOS and the BSDs ship their own `script` with different flags, so the replay story is cleanest on Linux, but the typescript file is plain text everywhere.

```sh
  # zero-install text capture on Linux, replayable at the original speed
script --log-timing timing.log session.log
  #   ...run your commands, then: exit
scriptreplay --log-timing timing.log session.log
```

The honest limit of every text cast: it is not something a reader can watch without a player. A `.cast` inlines nowhere on its own, so you either link out to a hosted player or convert it to pixels for embedding, which is what the next two sections are about.

## Pixel capture: a real screen recording of the terminal

Sometimes you want the terminal to look exactly like your terminal: your font, your color theme, a TUI's box-drawing, or the window sitting beside a browser. That means a normal screen recording, captured with the same tools and [capture settings that decide whether any recording reads sharp](/blog/how-to-record-your-screen-in-high-quality). On a desktop you grab the terminal window like any other, which on Linux means [the display server decides which recorder even works](/blog/record-screen-on-linux); the output is an MP4 or, for a short loop, a GIF, and [the container-versus-codec choice there is its own decision](/blog/best-video-format-for-screen-recording).

Pixels buy fidelity and cost three things. The text is now a picture, so nobody can copy a command out of it; small monospace fonts smear under a codec's color subsampling unless you record at a large font size, the same legibility trap that governs any [screencast putting a terminal on one timeline with code and a browser](/blog/developer-education-screencasts); and the file is heavy, because a GIF stores indexed frames with no compression between them, so even a mostly-static terminal loop runs far larger than the equivalent MP4, with [the full GIF-versus-MP4 size math worked out for READMEs elsewhere](/blog/readme-gifs-that-update-themselves). Pixel capture is the right call when the look is the point and copyability is not.

## Scripted replay: a tape you commit and re-render

The third mode does not capture a live session at all. You write the session as a script and a tool replays it into a fresh recording every time. vhs is the standard here, and its own tagline is blunt: "terminal GIFs as code." It reads a `.tape` file of commands like `Set FontSize`, `Type`, `Sleep`, and `Enter` and renders to GIF, MP4, WebM, or even a plain-text frame, given `ttyd` and `ffmpeg` on the PATH ([Charmbracelet, 2026](https://raw.githubusercontent.com/charmbracelet/vhs/main/README.md)). Because the tape is the source of truth, the demo is diffable, reviewable, and regenerable: change the CLI, replay the same tape, and the recording updates with nobody re-typing it. That runs unattended, which is why the tape pattern fits [rendering a demo on a machine with no display attached](/blog/headless-screen-recording).

```
  # demo.tape, committed next to the CLI
Output demo.gif
Set FontSize 22
Type "mytool build ./app" Enter
Sleep 3s
```

You can also turn a text cast into pixels after the fact: agg renders an asciinema `.cast` into an animated GIF ([asciinema, 2026](https://github.com/asciinema/agg)), and the now-archived termtosvg renders a session, including an asciicast, as a "standalone SVG animation" whose vector text stays crisp at any zoom ([nbedos, 2026](https://github.com/nbedos/termtosvg)). This regenerate-from-source discipline is the terminal cousin of committing a browser demo as a spec. Our own engine, aidemo, does that for web UIs, but it is browser-only by design, so a terminal is exactly the case where you reach for vhs instead of us.

## The three capture modes, side by side

Scored on the things that actually differ: how big the artifact is, whether a reader can copy the commands, how you edit it later, and whether it survives the next release.

| | Text cast (asciinema, script) | Pixel recording (MP4/GIF) | Scripted replay (vhs tape) |
|---|---|---|---|
| Artifact | `.cast` / typescript text | MP4 or GIF | `.tape` to GIF/MP4/text |
| Size, short session | kilobytes | MP4 sub-MB, GIF megabytes | as its chosen output |
| Copy the commands? | yes, it is text | no, pixels | no, unless text output |
| Edit after recording | re-record or hand-edit JSON | a video editor | edit the tape, re-render |
| Stays current by | re-recording | re-recording | replaying the tape |
| Inlines in a README | needs a player, or convert | GIF autoplays | renders to a GIF |
| Best when | the commands matter | the look matters | a maintained demo |

The row that catches people out is the second-to-last. A text cast is the smallest and most copyable artifact, yet it is the one thing that does not simply drop into a GitHub README, because a README has no asciicast player. That is why so many terminal demos are text-captured and then run through agg or vhs into a GIF for the front page: you keep the tiny, copyable source and still get inline motion, from two artifacts instead of one.

## Which artifact each destination wants

There is no single best capture; there is a best one per place the demo has to live.

| Destination | Reach for | Why |
|---|---|---|
| Docs where copying matters | fenced code block, or asciicast | the reader pastes the commands |
| A blog or docs page you host | asciicast player, or vhs GIF/MP4 | you control the embed and headers |
| GitHub README | GIF, from vhs or agg | the only motion GitHub autoplays inline |
| Bug report or support thread | asciicast link, or a short GIF | reproducible and copyable |
| Conference slide | MP4 or GIF at a big font | plays offline, needs no player |
| A CLI demo you must keep current | vhs tape in CI | regenerates on every release |

Read down the table and the pattern is the one the whole page turns on: choose text when the value is the commands, pixels when the value is the look, and a committed tape when the value is a demo that cannot be allowed to go stale.

## Sources

- [asciinema — asciicast v2 file format (newline-delimited JSON header plus event lines of terminal text)](https://docs.asciinema.org/manual/asciicast/v2/)
- [asciinema — asciicast v3 file format (relative-interval event stream, not backward compatible with v2)](https://docs.asciinema.org/manual/asciicast/v3/)
- [asciinema — CLI repository (Rust 3.x rewrite, zstd casts ~8% of the original size)](https://github.com/asciinema/asciinema)
- [charmbracelet/vhs — write terminal GIFs as code (.tape commands, ttyd + ffmpeg dependencies)](https://raw.githubusercontent.com/charmbracelet/vhs/main/README.md)
- [asciinema/agg — asciicast to animated GIF generator](https://github.com/asciinema/agg)
- [nbedos/termtosvg — record terminal sessions as standalone SVG animations (archived)](https://github.com/nbedos/termtosvg)
- [man7 — script(1), util-linux (typescript of a terminal session; --log-timing for scriptreplay)](https://man7.org/linux/man-pages/man1/script.1.html)
- [GitHub Docs — attaching files (10 MB image/GIF cap; MP4, MOV, WebM video types)](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)

## FAQ

### How do I record a terminal session without installing anything?

On Linux, the util-linux `script` command records a typescript of everything printed to your terminal, and adding `--log-timing timing.log` captures the delays so `scriptreplay` can play it back at the original speed. Both are already on the machine. macOS and BSD ship a `script` too, but with different flags, so the built-in replay is most reliable on Linux. For a portable, shareable recording, install asciinema and record a `.cast` instead.

### Can readers copy the commands out of an asciinema recording?

Yes. An asciicast is a text file of the characters your terminal printed, so the asciinema web player lets a viewer pause and select the commands straight out of the playback. That is the one thing a text cast gives you that a screen recording cannot: an MP4 or GIF turns the same terminal into pixels, and every command becomes unselectable. If copy-paste matters, record text, not video.

### Should I use an asciinema cast or a GIF in my README?

A GIF, but generate it from the cast. GitHub only autoplays a committed GIF inline and has no asciicast player, so a raw `.cast` will not move on the page. Record the session as a lightweight cast for the copyable source of truth, then convert it to a GIF with agg, or render a `.tape` with vhs, for the README itself, keeping the GIF under GitHub's 10 MB image cap.

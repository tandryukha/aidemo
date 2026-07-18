# How to record your screen with audio (system, mic, or both)

July 18, 2026 · Screen Recording · 7 min read · https://aidemo.top/blog/record-screen-with-audio/

> Your OS won't let an app read its own output, which is why system audio is the hard part. The routing map per OS for system, mic, or both, plus the levels rule.

**Key takeaways**

- System audio is hard because the OS won't let an app read its own output: macOS records mic only (Screenshot, QuickTime), so you need a loopback driver like BlackHole plus a Multi-Output Device to still hear it.
- Windows exposes system audio natively via WASAPI loopback (OBS 'Desktop Audio'), no install; legacy 'Stereo Mix' / 'What You Hear' devices do the same job.
- Linux records the output through a PulseAudio/PipeWire sink monitor: enumerate with pactl list sources, capture with ffmpeg -f pulse or pw-record.
- Capture mic and system on two separate tracks, never one mix: a mix is a sum you cannot un-add, and a too-loud chime lands on a word forever.
- Levels rule: keep peaks under 0 dBFS (mic near -6 to -12), anchor loudness toward EBU R128's -23 LUFS reference, and duck system or music ~15-20 dB below the voice.

## Your OS won't let an app tap its own output

Recording system audio feels harder than it should, and the reason is not your recorder. It is a wall built into the operating system: by default, an application cannot capture the mix of sound your computer is playing. A microphone is an input the OS hands to any app that asks, but the audio leaving your speakers is an output, and letting arbitrary software read that stream is a privacy and content-rights problem the platform vendors chose to block. So "how do I record my screen with audio" is really three questions wearing one coat. Do you want the *system* audio (app sounds, a video playing in the tab), the *microphone* (your live narration), or *both*, and each takes a different route to the file.

Get the routing right and everything after it is easy. Get it wrong and you find out only after the take: a silent clip where you expected the app's sound, or a voice buried under interface noise you can no longer pull apart. This page is the routing map, per operating system, plus the one levels rule that keeps the voice and the interface from clipping into each other. The rest of the capture settings around the audio, resolution and frame rate and a clean profile, are [their own checklist](/blog/how-to-record-your-screen-in-high-quality); this is the audio lane of it.

## Three sources, and which one your video actually needs

Before any tool, decide what the video is made of. There are exactly three audio sources, and the right one falls straight out of what you are demoing.

| Source | What it is | When a demo needs it |
|---|---|---|
| System audio | the mix your computer plays: app sounds, a chime, a video inside the UI | a product whose sound is the point: a media app, a game, a call tool |
| Microphone | your live voice, captured as you record | a walkthrough you narrate live at the keyboard |
| Both, mixed | system and mic together on the timeline | a reaction or teaching clip where you talk over app sound |

Most product demos need neither in the way people assume. A silent screen recording with narration added afterward, as a separate rendered track, sidesteps the routing problem entirely, and it is what most polished demos actually do. If the voice is [synthetic narration generated from the script](/blog/ai-voiceover-for-demo-videos), there is no microphone in the pipeline at all, and system audio becomes something you add on purpose rather than fight to capture. The routing map below is for the case where the sound genuinely happens live on screen and has to be caught in real time.

## The per-OS routing table: where system audio comes from

The microphone path is boring and identical everywhere: pick the input device, set a level, record. The interesting column is system audio, because each OS answers the "apps can't read the output" wall differently. Here is the whole landscape.

| OS | Built-in tool records | Get system audio via | Extra install? |
|---|---|---|---|
| macOS | microphone only (Screenshot, QuickTime) | a virtual loopback driver (e.g. BlackHole) plus a Multi-Output Device so you still hear it | yes |
| Windows | mic; Game Bar also grabs the foreground app's sound | WASAPI loopback (OBS "Desktop Audio"); legacy "Stereo Mix" / "What You Hear" | no |
| Linux | depends on the recorder | a PulseAudio/PipeWire sink monitor, via ffmpeg `-f pulse` or `pw-record` | no |
| Browser tab | n/a | `getDisplayMedia` with `systemAudio: "include"` (Chrome) | no |

**macOS is the one that fights you.** The built-in Screenshot toolbar (Shift-Command-5) and QuickTime record the microphone and offer no system-audio option at all; the only audio setting is which mic to use, or None ([Apple, 2026](https://support.apple.com/guide/mac-help/take-screenshots-or-record-your-screen-mh26782/mac)). To capture what the Mac is playing you install a virtual loopback driver. BlackHole is the common one, "a modern macOS virtual audio loopback driver that allows applications to pass audio to other applications with zero additional latency"; because "macOS applications cannot directly capture system output," the trick is a Multi-Output Device that plays to your speakers and BlackHole at once, so you hear the sound while your recorder reads it off BlackHole's channels ([Existential Audio, 2026](https://github.com/ExistentialAudio/BlackHole)). OBS on macOS leans on the same driver for its desktop-audio source.

**Windows exposes it natively.** In loopback mode "a client of WASAPI can capture the audio stream that is being played by a rendering endpoint device" ([Microsoft, 2025](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)), which is exactly what OBS's "Desktop Audio" source and most Windows recorders use under the hood, no extra install. Some sound hardware also ships a capture device under names like "Stereo Mix," "What You Hear," or "Waveout Mix" that you enable in the Sound control panel ([Microsoft, 2025](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)), and the Xbox Game Bar (Win+G) records the foreground app's audio out of the box.

**Linux models it as a source.** PulseAudio and PipeWire expose every output sink together with a companion capture source, the sink's monitor, so "record what is playing" is just recording from that monitor. Enumerate them with `pactl list sources`, then capture. FFmpeg's pulse device takes a source or the string `default`, so `ffmpeg -f pulse -i default out.wav` records the default input and pointing `-i` at a sink monitor records the playback ([FFmpeg, 2026](https://ffmpeg.org/ffmpeg-devices.html)). On PipeWire the same job is `pw-record`, which captures to a file and takes a `--target` node ([PipeWire, 2026](https://docs.pipewire.org/page_man_pw-cat_1.html)). OBS on Linux adds system sound through a PulseAudio audio-capture source rather than the Windows/macOS output-capture source ([OBS Project, 2026](https://obsproject.com/kb/audio-sources)).

```sh
pactl list sources | grep -e Name -e monitor
ffmpeg -f pulse -i alsa_output.pci-0000_00_1f.3.analog-stereo.monitor system.wav
pw-record --target <node> system.wav
```

**If the sound lives in a web page, skip the OS entirely.** `getDisplayMedia()` can return an audio track "if audio is supported and available for the display surface chosen by the user," and Chrome's `systemAudio: "include"` asks the browser to offer the tab's sound in the picker ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)). That path, and why a tab surface can never film a notification, is [the browser-tab capture story](/blog/record-a-browser-tab) in full.

The pattern is worth naming. Windows and Linux publish the output mix as something a program can read, so you add nothing; macOS treats the output as sealed and makes you install a bridge. That single fact is behind almost every "why can't I record system sound on my Mac" thread on the internet.

## Two tracks beat one mix, and the reason is subtraction

Once you are capturing both the microphone and the system, record them onto two separate tracks, not one already-combined one. The reason is arithmetic that does not run backward: a mix is a sum, and no later operation recovers the parts from the total. Capture the voice and the app sound already welded together and a too-loud notification sits on top of a word forever; capture them apart and you slide one under the other after the fact. Every serious recorder supports this, OBS routes each source to its own track, and the pillar states the capture rule in a line: [two tracks, a mic with headroom, never a single already-clipped mix](/blog/how-to-record-your-screen-in-high-quality). The routing table above is what feeds those two tracks. Keeping them separate is what makes the levels work below possible at all.

## Setting levels so the voice never fights the interface

Two failures dominate any recording that carries sound, and both are levels, not routing. The first is clipping. Digital audio has a hard ceiling at 0 dBFS, and any peak that touches it is squared off into permanent distortion no later gain repairs. Set the microphone so its loudest peaks land well under that ceiling, roughly -6 to -12 dBFS, and you keep the headroom to raise the whole track cleanly afterward. The second failure is burial: interface sound sitting at the same level as the voice until the words stop landing.

The fix is a target and a gap. Broadcasters settled the "how loud overall" question with EBU R128, which normalizes an average programme loudness to -23 LUFS ([EBU, 2023](https://tech.ebu.ch/publications/r128)). You do not need the broadcast figure exactly; you need its idea, a single integrated loudness you mix the whole piece toward, with the voice as the anchor and everything else placed relative to it. Put the narration at the reference and duck any system-audio or music bed to roughly 15 to 20 dB under it, quiet enough that a listener never strains for a word. That ducking math, and the licensing a music bed drags in, is [its own topic](/blog/demo-video-background-music); the capture-time version is short. Leave headroom on the mic, keep the interface under the voice, and normalize once at the very end rather than fighting levels live.

## The routing problem vanishes when you stop capturing live

Every wall in this piece, the sealed macOS output, the two-track discipline, the levels balancing act, exists because the audio is captured live, in real time, as one performance. Change that model and the walls fall away. If the narration is a rendered track and the only "system audio" you want is a music bed or a specific sound effect, you are not capturing a mix at all. You are compositing known tracks at known levels, with no loopback driver, no monitor source, and no clipping risk from a notification you forgot to silence.

That is how our engine, aidemo (disclosed as ours), handles sound: it records the browser silently, generates narration from the script as its own track, and mixes music in at a fixed level below the voice, so the balance is set in the spec instead of ridden on a fader. The honest limits are real. aidemo captures a browser tab only, so it will not record a native app's audio or your live microphone; the storyboard is authored in code by an agent, not dragged on a GUI timeline; and if the whole point of your clip is the live sound of an app, you are back to the routing table above. For a narrated walkthrough, though, the best answer to "how do I record system audio and my voice together" is often to not record them together, and to add each as a track you fully control. The same silent-capture-plus-tracks split is the sane default on Linux too, whether you [record under X11 or Wayland](/blog/record-screen-on-linux).

## Sources

- [Apple — Take screenshots or record your screen on Mac (Microphone option, no system audio)](https://support.apple.com/guide/mac-help/take-screenshots-or-record-your-screen-mh26782/mac)
- [Existential Audio — BlackHole virtual audio loopback driver (README)](https://github.com/ExistentialAudio/BlackHole)
- [Microsoft — Loopback Recording (WASAPI, Stereo Mix / What You Hear)](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- [FFmpeg — Device documentation (pulse input, pactl list sources)](https://ffmpeg.org/ffmpeg-devices.html)
- [PipeWire — pw-cat / pw-record manual (--record, --target)](https://docs.pipewire.org/page_man_pw-cat_1.html)
- [OBS Project — Audio sources (Audio Input/Output Capture, Linux PulseAudio)](https://obsproject.com/kb/audio-sources)
- [MDN — MediaDevices.getDisplayMedia() (audio, systemAudio)](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [EBU — R 128 loudness recommendation (-23 LUFS)](https://tech.ebu.ch/publications/r128)

## FAQ

### How do I record my screen with system audio on a Mac?

macOS blocks apps from reading the audio it plays, and the built-in Screenshot toolbar and QuickTime only let you pick a microphone, with no system-audio option. To capture what the Mac is playing, install a virtual loopback driver such as BlackHole, then create a Multi-Output Device in Audio MIDI Setup that sends sound to both your speakers and BlackHole at once, so you still hear it while your recorder reads it from BlackHole. Point OBS's or QuickTime's audio input at BlackHole and record.

### Why can't my computer record its own system audio directly?

Because the operating system treats the audio leaving your speakers as an output, not a capture device, and lets an app read it only through a deliberate path. Windows exposes that path natively as WASAPI loopback, so recorders like OBS grab desktop audio with no extra software. Linux publishes each output as a monitor source you can record. macOS seals the output for privacy and content-rights reasons, which is why it alone needs a third-party loopback driver.

### Should I capture my microphone and system audio as one track or two?

Two, always, if your recorder allows it. A single mixed track is a sum you cannot un-add, so if a notification chime lands on top of a word you are stuck with it. Two tracks let you balance the voice and the interface sound after the take, duck one under the other, and re-export until the mix is right. Keep the mic peaking around -6 to -12 dBFS for headroom and set the system audio well below the narration.

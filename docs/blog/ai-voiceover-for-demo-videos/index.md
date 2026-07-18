# AI voiceover for demo videos: quality, cost, and workflow

July 18, 2026 · Product Demo Videos · 7 min read · https://aidemo.top/blog/ai-voiceover-for-demo-videos/

> AI voiceover per minute is settled and cheap. The real questions: which TTS gives you consistency and one-line re-renders, and where a human voice still wins.

**Key takeaways**

- A finished minute of English narration is ~900 characters: about $0.014 on OpenAI tts-1, ~$0.09 on ElevenLabs Multilingual, and ~$0 self-hosting Apache-2.0 Kokoro-82M (July 2026).
- At one to two minutes per demo, TTS narration costs cents on any vendor. Optimize for iteration speed and voice consistency, not price per million characters.
- Hash-cached per-scene narration means editing one line re-voices only that scene: a 20-pass script edit re-synthesizes ~4,500 characters, not 27,000.
- TTS wins on iteration, consistency, and availability; it still loses on genuine emotion, brand voice, and product-name pronunciation without phonetic hints.
- gpt-4o-mini-tts adds an instructions parameter to steer tone, accent, and pace (July 2026) — the best lever for closing the emotion gap without re-recording.

## The three things TTS does better than you at a microphone

The objection to synthetic narration used to be that it sounds synthetic. For a 60-to-90-second product walkthrough narrated in a neutral register, that objection is mostly retired: current models clear the bar. So the interesting question stops being "does it sound human" and becomes "what does the machine do that a human recording can't." There are three answers, and none of them is about the voice.

**Iteration.** Change a word, re-render in seconds. No re-booking a quiet room, no matching yesterday's mic distance, no "can you do that line once more with a little more energy." A demo script is never right on the first pass, and TTS makes the twelfth pass as cheap as the first. **Consistency.** The same voice, pace, and loudness across all six scenes, and across the re-record you will do in three months when the UI moves. Human narration drifts between takes and between days; a model reads scene six exactly the way it read scene one. **Availability.** No microphone, no room treatment, no stage fright, no accent you dislike hearing yourself use. The narration ships from a text file, which means it ships from CI.

Those three are the steps a machine can stand in for in the [end-to-end demo pipeline](/blog/how-to-make-a-product-demo-video). What they cost, and where they run out, is the rest of this piece.

## The arithmetic: what a finished minute of narration costs

TTS vendors bill by input, almost always by the character. To compare them you have to convert to a common unit: a *finished minute* of narration. A demo is spoken at roughly 150 words per minute (the [per-section word budgets](/blog/demo-video-script-template) derive that pace in detail), and English averages about six characters per word including the trailing space, so a finished minute is roughly 900 characters. Divide each vendor's list rate by that and the picture is stark.

| Option | Model or plan | List rate (Jul 2026) | Per finished minute (~900 chars) |
|---|---|---|---|
| OpenAI | `tts-1` | $15 / 1M characters | ~$0.014 |
| OpenAI | `tts-1-hd` | $30 / 1M characters | ~$0.027 |
| OpenAI | `gpt-4o-mini-tts` | $0.60/1M input + $12/1M audio tokens | ~$0.015 (est.) |
| ElevenLabs | Multilingual v2 (API) | $0.10 / 1,000 characters | ~$0.09 |
| ElevenLabs | Flash / Turbo (API) | $0.05 / 1,000 characters | ~$0.045 |
| Kokoro-82M | self-hosted | Apache-2.0, compute only | ~$0 |

The character-priced models are the ones you can reason about with long division. OpenAI's `tts-1` and `tts-1-hd` run $15 and $30 per million characters ([OpenAI, July 2026](https://developers.openai.com/api/docs/models/tts-1)), which lands a finished minute at about 1.4 and 2.7 cents. ElevenLabs' pay-as-you-go API is $0.10 per 1,000 characters on its Multilingual v2 model and $0.05 on the faster Flash and Turbo models ([ElevenLabs, July 2026](https://elevenlabs.io/pricing/api)), so a minute is about nine cents or four and a half. Kokoro-82M is an open-weight model released under Apache 2.0 ([hexgrad, Jan 2025](https://huggingface.co/hexgrad/Kokoro-82M)); a `pip install kokoro` runs it on your own CPU ([hexgrad, 2026](https://github.com/hexgrad/kokoro)), so the marginal cost of a minute is whatever your electricity costs, which rounds to zero.

The one entry that resists clean division is `gpt-4o-mini-tts`. It is priced by tokens, not characters — $0.60 per million text-input tokens plus $12 per million audio-output tokens ([OpenAI, July 2026](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts)) — and because the charge falls on the *audio* it generates, cost tracks how long the speech runs rather than how many characters you sent. The same 100 words read slowly cost more than read quickly. In practice a minute lands in the same low-single-digit-cents range as `tts-1`, near a penny and a half, but that figure is an estimate, not a rate card.

Make it concrete. A typical 90-second demo is about 1,350 characters of narration. On `tts-1` the whole thing costs about two cents; on ElevenLabs' Multilingual API, about fourteen cents; on Kokoro, nothing.

## At demo scale, price is a rounding error

Read the table again and the headline is not the ratios, it is the magnitudes. Yes, ElevenLabs' Multilingual voice costs roughly six times what OpenAI's `tts-1` does per minute. But six times a rounding error is still a rounding error. No demo budget turns on the difference between two cents and fourteen. The per-million-character figure that vendor comparison pages lead with is the wrong number to optimize, because at one-to-two-minute demos you never generate enough characters for it to matter.

Two costs actually bite, and neither is on the rate card. The first is ElevenLabs' shape: it is a subscription, not metered usage. The plans run from $6/mo Starter to $99/mo Pro, each with a monthly credit allotment where one character equals one credit on the Multilingual model, and commercial rights begin at the paid Starter tier ([ElevenLabs, July 2026](https://elevenlabs.io/pricing)). You pay the monthly floor whether or not you narrate anything, and heavy re-rendering burns the credit cap. The second cost applies to everyone and is not denominated in dollars at all: the wall-clock and attention cost of iterating. That is where the choice is actually made. Want $0 marginal cost and fully offline rendering? Kokoro's permissive weights are the only option here that delivers it. Want the least setup? OpenAI's per-character billing behind a single API key is the lowest friction. Want voice cloning and the widest voice library? That is what the ElevenLabs subscription buys.

## Edit one line, re-voice one line

Here is the workflow property that the pricing tables never mention, and it is worth more than any per-minute rate. Because narration is generated one scene at a time, you can key each audio clip on a hash of its own text and voice settings. Edit the script for scene four and only scene four's hash changes; the other five clips are reused, untouched, without an API call. In our engine, aidemo (disclosed as ours), each scene's audio is keyed on a SHA-256 of its narration plus its voice plan and provider, and a re-run whose hashes all still match needs no network round trip and no API key at all — a fully cached render is free and offline.

Watch what that does to iteration cost. Take a six-scene, 90-second demo, about 1,350 characters. You refine the script through twenty single-line edits while tuning it. A naive pipeline re-voices the entire demo on every save: twenty times 1,350 is 27,000 characters, about 40 cents on `tts-1`. Per-scene caching re-voices only the scene you touched each time: twenty edits of one ~225-character scene is 4,500 characters total, about 7 cents. The dollars were never the point — both are trivial. The point is the wall-clock: twenty full re-renders versus twenty one-line ones is the difference between iterating freely and rationing your edits. The unit of change becomes the line, not the take. It is the same mechanism that lets [captions get regenerated](/blog/demo-video-captions) rather than re-typed, and that turns [rendering the same take in several languages](/blog/multi-language-product-demo-videos) into swapping the narration text instead of booking N voice actors.

## Where a human voice still wins

Being honest about the tool means naming where it loses, because it does.

**Emotion and emphasis.** A neutral read is exactly right for a feature walkthrough and exactly wrong for a founder's launch film. Genuine enthusiasm, comedic timing, a pause placed for effect — current TTS approximates these, and a listener still clocks the difference on anything past a couple of minutes. OpenAI's `gpt-4o-mini-tts` narrows the gap with an `instructions` parameter that steers accent, emotional range, intonation, speed, and tone ([OpenAI, July 2026](https://developers.openai.com/api/docs/guides/text-to-speech)), so you can ask for "warm, unhurried, slightly amused" instead of accepting the default. It is the best lever available, but it is direction, not a performance.

**Brand voice.** If a specific human voice *is* the brand — a recognizable founder, a narrator you use across every video — a stock model voice dilutes it. Voice cloning (ElevenLabs, from the Creator tier at $22/mo up) recovers some of that by training on a sample of the real voice, with the obvious consent and rights caveats attached.

**Pronunciation.** Product names, acronyms, and domain jargon are where TTS embarrasses itself; it will confidently mispronounce your own company name. The fix is phonetic hints or spelling overrides in the script, a slot every serious pipeline needs, tuned once and then forgotten.

So the decision is not human-or-synthetic in the abstract. It is a match between the register of the narration and the strengths of each tool.

| The narration is... | Use |
|---|---|
| A neutral feature walkthrough you will iterate and maybe localize | TTS |
| Carrying the personality that sells (founder launch, brand film) | Record a person |
| Your brand's recognizable voice, but you want iteration speed | A cloned voice |

Most product demos are the first row. That is why, for the demo itself — the one you will re-cut when the length is wrong and re-render when the UI changes — [the finished length matters more than the voice actor](/blog/how-long-should-a-demo-video-be), and the voice should be the part of the pipeline you never have to schedule.

## Sources

- [OpenAI — tts-1 model and pricing](https://developers.openai.com/api/docs/models/tts-1)
- [OpenAI — gpt-4o-mini-tts model and pricing](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts)
- [OpenAI — text-to-speech guide (instructions parameter)](https://developers.openai.com/api/docs/guides/text-to-speech)
- [ElevenLabs — pricing and plans](https://elevenlabs.io/pricing)
- [ElevenLabs — API pay-as-you-go pricing](https://elevenlabs.io/pricing/api)
- [Kokoro-82M — model card and license (Hugging Face)](https://huggingface.co/hexgrad/Kokoro-82M)
- [Kokoro — source repository and install](https://github.com/hexgrad/kokoro)

## FAQ

### How much does AI voiceover cost per minute of video?

A finished minute of English narration is about 900 characters. As of July 2026 that costs roughly $0.014 on OpenAI's `tts-1`, about $0.09 on ElevenLabs' Multilingual API (or ~$0.045 on their faster Flash model), and effectively $0 if you self-host the Apache-2.0 Kokoro-82M model on your own hardware. For a single demo the absolute cost is negligible, so the ElevenLabs subscription floor and your own iteration time matter far more than the per-character rate.

### Is AI voiceover good enough for a professional product demo?

For a neutral feature walkthrough narrated at a steady pace, yes — current models clear that bar and stay perfectly consistent across scenes, which a human recording struggles to do across takes and days. Where it still falls short is genuine emotion and brand-specific delivery, so a launch film that hinges on one person's charisma is still better recorded. Match the tool to the register rather than deciding in the abstract.

### Can I use my own cloned voice for demo narration?

Yes — ElevenLabs offers voice cloning from its Creator tier ($22/mo as of July 2026) and up, trained on a sample of your voice, which recovers the brand-voice consistency a stock model voice loses. Get explicit consent and rights for any voice you clone. Expect to add pronunciation hints for product names and acronyms regardless of which voice you pick, since every TTS model mishandles those by default.

# Demo video software pricing landscape, per finished minute

July 18, 2026 · Demo Tools & Alternatives · 7 min read · https://aidemo.top/blog/demo-video-software-pricing/

> Sticker prices lie because the units differ: per seat, per minute, per demo, per view. Normalized to cost per finished demo-minute, the ranking flips.

**Key takeaways**

- Cost per finished demo-minute is not a tool property: Screen Studio's $9/mo yearly plan runs $4.50/min at 2 finished min/mo and $0.23/min at 40, a 20x swing from one price (July 2026).
- Per-seat pricing decouples the bill from output: 5 Loom Business seats ($90/mo) at a steady 10 finished min/mo is $9/min, the same as one seat at light 2 min/mo volume.
- Metered plans punish under-use: Synthesia Starter's 120 min/year expires, so 2 min/mo costs $9/min versus $1.80/min at full use ($18/mo billed yearly, July 2026).
- Interactive tours can't be normalized to video-minutes: Storylane's HTML tier is $500/mo yearly and Navattic quotes only by sales call, so you buy an embed, not minutes.
- No hosted subscription beats the spec-driven floor: a CI render is ~$0.02/finished min (tts-1 $15/1M chars plus $0.006 CI/min, free on public repos), flat at any volume.

## Five pricing units, one deliverable

Put six demo tools' pricing pages side by side and you cannot add them up, because no two charge for the same thing. Screen Studio bills a flat monthly fee for one app. Loom bills per seat. Synthesia bills per minute of rendered video. Storylane and Navattic gate the feature you want behind a tier priced per seat, per demo, or per visitor. OBS bills nothing at all. The stickers sit in one comparison grid and mean five different things, so the "cheapest" tool on the page is an artifact of which unit its marketing chose, not of what a demo will actually cost you.

The only way to compare them is to convert every price into one shared unit, and the natural one is cost per finished demo-minute: dollars spent divided by minutes of video delivered. This piece normalizes the market to that number at a realistic monthly output, and the ranking that falls out is not the one the pricing pages imply. Every figure below comes straight from each vendor's pricing page, checked in July 2026; the tools themselves are sorted by mechanism rather than price in [what the AI-demo-video-generator label actually covers](/blog/ai-demo-video-generators).

## The unit each tool actually bills you by

Before the arithmetic, here is what you are being charged for, because the unit is the whole story: it decides whether your bill tracks your output, your headcount, your traffic, or nothing.

| Tool | Priced by | Sticker (July 2026) | What the unit hides |
|---|---|---|---|
| Screen Studio | flat app subscription | $20/mo, or $9/mo billed yearly, macOS only ([Screen Studio, July 2026](https://screen.studio/)) | the per-minute cost falls the more you produce |
| Loom | per seat | Business $18/user/mo, Business + AI $24 ([Loom, July 2026](https://www.loom.com/pricing)) | the bill scales with headcount, not demos |
| Synthesia | per rendered minute | Starter $29/mo ($18 yearly) for 120 min/year; Creator $89 for 360 ([Synthesia, July 2026](https://www.synthesia.io/pricing)) | unused minutes expire, and they are avatar video, not your UI |
| Storylane | per seat, feature gated by tier | Free (1 demo); Starter $50/mo; Growth $500/mo yearly unlocks the HTML editor ([Storylane, July 2026](https://www.storylane.io/pricing)) | the fidelity you came for is a four-figure line item |
| Navattic | quote-only above free | Free (1 seat, 1 demo); Base, Growth, Enterprise by sales call ([Navattic, July 2026](https://www.navattic.com/pricing)) | you cannot compare a price you are never shown |
| OBS Studio | free (GPLv2) | $0 | you pay in labor, one hand-made minute at a time |
| Spec-driven CI render | compute plus TTS | about $0.014/min TTS plus CI minutes ([OpenAI, July 2026](https://developers.openai.com/api/docs/models/tts-1)) | the real cost is one-time authoring, not each render |

Two of these rows are not selling video at all. Storylane and Navattic sell an interactive HTML tour a prospect clicks through, and their upper tiers increasingly price by monthly visitors: Storylane's conversational tier starts at $2,000 a month for up to 10,000 visitors, about twenty cents a head. That is a per-view unit, and the full tour-pricing breakdown is in [Arcade vs Navattic vs Storylane](/blog/arcade-vs-navattic-vs-storylane). Hold that thought; it is why they drop out of the per-minute table below.

## Normalizing to cost per finished demo-minute

Cost per finished minute is not a property of a tool. It is the tool's price divided by how many minutes of video you actually ship, so it moves with your volume. To make that visible, here is each video-producing tool at three monthly outputs: light (2 finished minutes, an occasional clip), steady (10 minutes, a small maintained library), and heavy (40 minutes, a docs-and-changelog habit).

| Tool (one seat unless noted) | 2 min/mo | 10 min/mo | 40 min/mo |
|---|---|---|---|
| Screen Studio, yearly ($9/mo) | $4.50 | $0.90 | $0.23 |
| Screen Studio, monthly ($20/mo) | $10.00 | $2.00 | $0.50 |
| Loom Business, 1 seat ($18/mo) | $9.00 | $1.80 | $0.45 |
| Loom Business, 5 seats ($90/mo) | $45.00 | $9.00 | $2.25 |
| Synthesia Starter, yearly ($18/mo, 120 min/yr) | $9.00 | $1.80 | exceeds allotment |
| Spec-driven CI render | ~$0.02 | ~$0.02 | ~$0.02 |

Read across the top row: one subscription, unchanged, costs $4.50 a minute or 23 cents a minute depending only on how much you make with it, a twentyfold swing from a single price tag. The point is not that Screen Studio is cheap or dear. It is that "how much per finished minute" has no answer until you say how many minutes you produce, and any vendor who quotes you a per-minute figure has quietly assumed a volume you may never reach.

## The per-seat trap and the enterprise floor

Two rows behave differently from the rest, and both catch buyers out.

The per-seat trap is the Loom pair. A per-seat price decouples your bill from your deliverable: you pay for chairs, whether or not the person in each one makes a demo. Five Loom seats at a steady 10 minutes of finished demo a month works out to $9 a minute, exactly what a single seat costs at the light 2-minute volume, because four of those seats are paying to exist rather than to produce. Messaging tools get bought team-wide for good reasons, but the moment you reframe one as demo-production spend, every non-producing seat is dead weight in the per-minute math. That mismatch is the whole argument of [Loom alternatives sorted by the job you are replacing](/blog/loom-alternatives-for-product-demos).

The enterprise floor is the tour tools, which fell out of the per-minute table because their artifact is not a video. Force them in by exporting the tour to a flat MP4 and the number turns absurd: Storylane's HTML-fidelity tier is $500 a month billed yearly, so a lone exported two-minute clip reads as $250 a minute, and Navattic will not quote the comparable tier without a call. The figure is meaningless because you are not buying minutes; you are buying an interactive embed and its analytics. That is a real product for a self-serve page, and whether you need a clickable embed or a video file that plays anywhere is a separate decision.

Metered pricing has a floor of its own, in the Synthesia row. Its unit genuinely is the finished minute, which makes it the easy case to normalize, but the minutes come in an annual block that expires. At the light 2-minute volume you burn 24 of your 120 yearly minutes and pay for all 120, so your real rate is $9 a minute, five times the $1.80 you would pay at full use. And those minutes render a synthetic presenter, not your interface, which is why avatar tools answer a different job than a product demo.

## Where marginal cost collapses toward zero

Every hosted subscription in the table has a floor it cannot cross, and the floor is the subscription itself. The cheapest flat recorder at the heavy volume still costs 23 cents a finished minute, and nothing you do with output drives it lower, because you are dividing a fixed fee.

The spec-driven row is the only one whose per-minute cost is set by compute rather than by a seat or a plan. When the demo is a committed spec that a machine replays and narrates, the marginal cost of one more finished minute is text-to-speech at about a cent and a half on OpenAI's tts-1 ([OpenAI, July 2026](https://developers.openai.com/api/docs/models/tts-1)) plus a few CI minutes, which are free on public repositories and cost $0.006 each beyond the 2,000-to-3,000 monthly minutes GitHub includes on paid plans ([GitHub, July 2026](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)). That lands near two cents a finished minute, and it neither falls nor rises with volume, because there is no subscription to amortize. It is roughly ten times cheaper than the best subscription number in the table, and over a hundred times cheaper than the light-volume ones.

The catch is honest, and it is not in the compute. The fixed cost moves to authoring the spec the first time, which is real work, and the full labor accounting sits in [how much a demo video actually costs](/blog/demo-video-cost). Our own engine, aidemo (disclosed as ours), is one MIT-licensed instance of this pattern: it captures a browser tab only, so native desktop and mobile apps are out of scope; its storyboard is written by a coding agent rather than nudged along a timeline; and there is no click-to-trim editor. What that constraint buys is the row above, a per-minute cost that rounds to compute, regenerated on the same commit that moved the UI because [CI renders it for you](/blog/demo-videos-in-ci).

## Reading the table for your own volume

The normalized numbers hand you a decision rather than a winner, because the cheapest column changes with the row you live in.

If you make a demo or two a month, stop optimizing the per-minute rate: at that volume every flat subscription is dominated by its fixed fee, so choose on features and platform and pay the $9-to-$20 a month without guilt. If you are keeping a real library current, the steady column is where per-seat and metered plans start to sting and a single-seat flat recorder or a spec-driven render pull ahead. If you are producing at the heavy end, the only two options that stay cheap are a flat subscription amortized hard across one busy seat and a CI render whose cost is compute. And if your bill is per seat or quote-only, price it against your finished-minute output before you sign rather than against the sticker, because the [free tiers are a separate trap of their own](/blog/free-demo-video-software) and the headline number is rarely the one you end up paying.

## Sources

- [Screen Studio — pricing](https://screen.studio/)
- [Loom — pricing](https://www.loom.com/pricing)
- [Synthesia — pricing](https://www.synthesia.io/pricing)
- [Storylane — pricing](https://www.storylane.io/pricing)
- [Navattic — pricing](https://www.navattic.com/pricing)
- [GitHub — about billing for GitHub Actions](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)
- [OpenAI — tts-1 model and pricing](https://developers.openai.com/api/docs/models/tts-1)
- [aidemo — repository (our engine, disclosed as ours)](https://github.com/tandryukha/aidemo)

## FAQ

### How much does demo video software cost per month?

Screen recorders run $9 to $24 a month: Screen Studio is $20, or $9 billed yearly, and Loom Business is $18 per user ([Loom, July 2026](https://www.loom.com/pricing)). Synthesia's avatar plans start at $29 a month, and interactive-tour tools like Storylane jump from $50 a month to $500 for their high-fidelity tier ([Storylane, July 2026](https://www.storylane.io/pricing)). The monthly sticker only names the fixed fee, though; what a demo actually costs depends on how many you make, which is why the useful number is cost per finished minute.

### What is the cheapest demo video software for a small team?

For a team making a demo or two a month, a flat single-seat recorder like Screen Studio at $9 a month billed yearly is cheapest, because per-seat tools charge for every chair whether or not it makes a video. For a team keeping a library current, the cheapest option is a spec-driven render in CI, whose marginal cost is about two cents a finished minute of compute rather than a subscription. Free open-source recorders like OBS cost nothing in cash but bill you in hand-editing labor per clip.

### Do interactive demo tools cost more than screen recorders?

Usually yes, and they are priced for a different job. A screen recorder is a flat $9 to $24 a month; an interactive-tour platform's comparable-fidelity tier is a four-figure line item, such as Storylane's $500-a-month Growth plan billed yearly, and Navattic quotes its paid tiers only by a sales call ([Navattic, July 2026](https://www.navattic.com/pricing)). You pay more because you are buying a clickable HTML embed and its visitor analytics, not a video file, so the two do not compare on cost per minute at all.

# Demo video script template: problem, walkthrough, proof

July 18, 2026 · Product Demo Videos · 7 min read · https://aidemo.top/blog/demo-video-script-template/

> Narration runs about 2.5 words a second, so a demo's runtime is a word budget. Grab a copy-paste script skeleton and two worked scripts, counted line by line.

**Key takeaways**

- English narration averages ~150 words per minute (2.5 words/second), so a 60-second demo script is about 150 words and a 90-second one about 225 - budget every section against the clock.
- The three-act skeleton for an 80-second cut: problem ~30 words, promise ~20, a 3-step walkthrough ~110, proof ~25, one CTA ~15 - about 200 words total.
- Narrate intent, not the cursor: one idea per on-screen action, and cut any adjective that doesn't change what the viewer does next.
- Two counted example scripts included - a 75-second SaaS dashboard (185 words) and a 65-second dev tool (155 words) - with per-line word counts.

## Every demo script is a timing budget in disguise

A demo script is not an essay you happen to read aloud. It is a fixed number of seconds, and narration spends those seconds at a known rate. Miss the rate and you either sprint past the interface or pad the video with words nobody asked for. Hit it and the script falls out of the runtime backward: length first, words second.

The rate is well measured. Tools for Clear Speech at Baruch College puts the average English speaker at about 150 words per minute, with an intelligible band of roughly 120 to 165 and a slightly slower pace recommended when the speech is prepared rather than conversational ([Tools for Clear Speech, Baruch College](https://tfcs.baruch.cuny.edu/speaking-rate/)). One hundred fifty words a minute is 2.5 words a second, which, not by accident, is the English text-to-speech default our own open-source engine, aidemo, plans around. That one conversion is the most useful number in demo scripting: it turns any target length into a hard word budget.

| Runtime | Word budget (150 wpm / 2.5 wps) | What it fits |
| --- | --- | --- |
| 15 sec | ~38 | a single hook or one feature |
| 30 sec | ~75 | a social loop or README clip |
| 45 sec | ~113 | one tight end-to-end flow |
| 60 sec | ~150 | a landing-page hero |
| 75 sec | ~188 | a full problem-to-proof arc |
| 90 sec | ~225 | two flows with a breath between |
| 120 sec | ~300 | a detailed sales walkthrough |

Product narration belongs at the calm end of the band. You are asking someone to read an interface and listen at the same time, so 140 to 150 words per minute leaves air around each idea. Faster than about 170 and the words outrun the screen; slower than 120 and it drags. Pick the runtime your channel wants first — [how long the finished video should run](/blog/how-long-should-a-demo-video-be) depends on where it plays — then spend the budget the table hands you.

## The three-act skeleton: problem, walkthrough, proof

Every demo that holds attention answers three questions in order: why should I care, what does this do, and did it actually work. Problem, walkthrough, proof. The structure is old because it works; the discipline is spending each act's word budget and not a word more. Here is the skeleton sized for a 75-to-80-second cut, a comfortable length for a hero or a sales follow-up.

```
[0:00-0:12]  HOOK / PROBLEM        ~30 words
  One concrete scene of the pain. Name no product yet.

[0:12-0:20]  PROMISE               ~20 words
  One sentence: what this is and the outcome it produces.

[0:20-1:05]  WALKTHROUGH           ~110 words  (3 steps, ~35 each)
  One idea per step, each pinned to a single on-screen action.
  Narrate the intent, not the cursor.

[1:05-1:15]  PROOF                 ~25 words
  The result as a number or a before/after. Earned, not asserted.

[1:15-1:22]  CTA                   ~15 words
  Exactly one action, one destination.
```

Two hundred words, eighty seconds. The walkthrough gets more than half the budget because it is the only part that has to be true: the hook can be rewritten, but the three steps have to match what the screen does. If your flow needs four steps, take words from the hook, not from the runtime. A 60-second version is the same shape with a two-step walkthrough and about 150 words total; a 45-second version folds the promise into the hook.

Cross-check the plan against [the end-to-end demo playbook](/blog/how-to-make-a-product-demo-video) before you record: the script decides the pacing, but recording, captions, and trimming decide whether the pacing survives.

## Worked example 1: a SaaS dashboard in 75 seconds

A revenue-analytics dashboard. The pain is a Monday spreadsheet; the payoff is a live link. Every narration line below is counted, and the totals track the timecodes at 2.5 words per second.

| Time | On screen | Narration | Words |
| --- | --- | --- | --- |
| 0:00-0:11 | A cluttered spreadsheet, three export tabs open | "Every Monday, your revenue team rebuilds the same report by hand: export from billing, paste into a sheet, reconcile, repeat. By Wednesday the numbers are already stale." | 27 |
| 0:11-0:20 | The product loads to a clean dashboard home | "This dashboard reads the same billing data and keeps one live view the whole team works from. Here's the Monday report in three clicks." | 25 |
| 0:20-0:36 | Connections tab; Stripe linked; tables picked | "Start on Connections. Stripe is already linked, so I pick it and choose the revenue and churn tables. No SQL, no export. It pulls the last twelve months and caches it, so the view opens instantly next time." | 38 |
| 0:36-0:51 | Fields dragged in; the chart redraws | "Next, the view itself. I drop in monthly recurring revenue, then split it by plan. The chart redraws as I go. One more field, net revenue retention, and the board that used to take an afternoon is done." | 38 |
| 0:51-1:05 | Publish dialog; a shareable link appears | "Last step: sharing. I publish it to a link, and anyone on the team sees the same live numbers, refreshed hourly. No more Wednesday spreadsheet, no more version to argue about." | 31 |
| 1:05-1:17 | Zoom on the live board; CTA card | "That went from a two-hour weekly rebuild to a link that's always current. Connect your billing data and build your first view on the free tier." | 26 |

That is 185 words across 77 seconds, inside the budget, with the walkthrough (three steps, 107 words) carrying the middle exactly as the skeleton allots. Notice what the narration never says: no "click," no "button," no color, no cursor. The screen shows those. The words carry intent.

## Worked example 2: a dev tool in 65 seconds

A flaky-test detector for CI. Denser subject, so the pace stays slow and the hook does the emotional work. Terminal and dashboard alternate on screen.

| Time | On screen | Narration | Words |
| --- | --- | --- | --- |
| 0:00-0:08 | Terminal: a red CI run, then a green re-run | "A test just failed in CI. You re-run it, it passes, and you've learned nothing except that you lost twenty minutes." | 21 |
| 0:08-0:17 | Product page; a one-line install command | "This tool watches your test runs and flags the flaky ones automatically. One command to install, and it starts on your next push." | 23 |
| 0:17-0:31 | Install line, one line added to CI config, git push | "Here's the install: one line in the terminal, one line in the CI config. That's the whole setup. I push, and the run shows up in the dashboard already being analyzed." | 31 |
| 0:31-0:45 | Dashboard: the test marked flaky, assertion and timing shown | "Now the payoff. This test failed twice this week on unrelated changes, so it's marked flaky, with the failing assertion and the timing right here. No re-running to guess." | 29 |
| 0:45-0:56 | One click quarantines the test; the suite turns green | "One click quarantines it, so the flake stops blocking merges while you fix it. The suite goes green, and the fix is a ticket now, not a mystery." | 28 |
| 0:56-1:06 | Green pipeline; repository link on a card | "That's a red build turned into a tracked task in under a minute. Add it to your pipeline free, link in the description." | 23 |

One hundred fifty-five words, sixty-two seconds. Same three acts, tighter, because a developer audience forgives less filler than a marketing one. The proof line is a duration, not an adjective, and the CTA is a single verb.

## Rules that keep the words honest

Word budgets tell you how much to write. These tell you what to cut.

- **One idea per action.** If a sentence describes two clicks, split it or drop a click. A viewer tracks one change at a time.
- **Narrate intent, not the cursor.** "Publish it to a link" beats "I click the blue button in the top right." The screen already shows the button.
- **Cut every adjective that doesn't change the next click.** "Powerful," "intuitive," and "robust" cost words and buy nothing. The demo is the adjective.
- **Front-load the pain.** Wistia's read on 13 million videos puts clips under a minute at about a 52% engagement rate, and the drop-off is steepest at the start ([Wistia, 2025](https://wistia.com/learn/marketing/optimal-video-length)). Spend the first ten seconds on the problem, not on a logo animation.
- **Write proof as a number.** "Two hours to a live link" lands; "saves you time" evaporates.
- **Read it against a stopwatch.** Not with your eye, with your mouth. If a section runs long out loud, the fix is fewer words, not a faster read.

## From script to a recorded take

A finished script is timecodes plus verbatim lines plus, ideally, the on-screen action beside each one — exactly the two worked tables above. Vidyard, which coaches sellers through thousands of these, lands on the same shape: a hook in the first few seconds, a problem the product visibly solves, and one clear call to action, with two minutes as the target and five as the ceiling ([Vidyard](https://www.vidyard.com/blog/demo-videos/)).

Because that artifact is plain text with timecodes, a machine can read it. That is the premise behind tools like aidemo (ours, MIT-licensed, browser-only, and it expects an agent to author the storyboard rather than a person dragging clips on a timeline): the words you budgeted become the voiceover and the captions, timed to the clicks. When the product changes, you edit the script and [regenerate the video instead of re-recording it](/blog/automated-product-demo-videos). If you would rather not read the lines yourself, the same script drives [an AI voiceover](/blog/ai-voiceover-for-demo-videos), and that timed transcript is what your captions are built from. The script is the source of truth; everything downstream is a transform on it.

## Sources

- [Tools for Clear Speech, Baruch College — Speaking Rate](https://tfcs.baruch.cuny.edu/speaking-rate/)
- [Wistia — How to Choose the Right Marketing Video Length (2025)](https://wistia.com/learn/marketing/optimal-video-length)
- [Vidyard — How to Make Demo Videos That Win New Business](https://www.vidyard.com/blog/demo-videos/)

## FAQ

### How many words should a 60-second demo video script be?

About 150 words. English narration averages roughly 150 words per minute, or 2.5 words per second ([Tools for Clear Speech, Baruch College](https://tfcs.baruch.cuny.edu/speaking-rate/)), so a 60-second script is around 150 words and a 90-second script around 225. Product narration reads best at the slower end, near 140 to 150 words per minute, so the interface has room to be seen while it is described.

### Should you write a demo script word for word or use bullet points?

Write it word for word. Bullet points let the pace drift, and drift is what blows both the runtime budget and the sync with the screen. A verbatim script also lets you count words per section against the clock, and it is the only form a text-to-speech engine or a caption tool can use directly. Improvise the delivery if you like, but write the words first.

### Where does the call to action go in a demo script?

At the end, as exactly one action — start a trial, book a demo, open the repo — pointed at one destination. Vidyard's guidance is a single clear CTA rather than a menu of options ([Vidyard](https://www.vidyard.com/blog/demo-videos/)). Keep it to about 15 words: a viewer who reached the end is already convinced, so they need a next step, not another pitch.

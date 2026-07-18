# Product walkthrough video: follow one real task end to end

July 18, 2026 · Product Demo Videos · 7 min read · https://aidemo.top/blog/product-walkthrough-video/

> A walkthrough follows one real task from empty state to done. The table that separates it from a demo, a click-by-click shot-list, and the pacing rules.

**Key takeaways**

- A walkthrough follows one real task start to finish so the viewer can repeat it; a demo sells one idea and may skip steps; a tutorial teaches a concept. Different jobs, different cuts.
- Budget length by task depth, not placement: 1-2 steps ~15-30s, 3-5 steps ~30-60s, a full 6-9-step task 60-120s, 10+ steps 2-4 min chaptered (Vidyard: 2 min ideal, 5 max).
- Two-speed pacing: cut page loads and typing to a beat (Nielsen: any delay over ~1s breaks flow of thought), and hold 3-4s on every decision point and on the finished state.
- Pick the one task that is the reason people adopt the product and has a clear finished state, and film the path a real user takes, decisions included, not the choice-free happy path.
- A walkthrough rots fastest because it follows a live flow; capture it from a spec so a renamed button is a one-line edit, not a reshoot.

## A walkthrough answers "can I do this?", not "should I buy this?"

"Walkthrough" gets stuck on any video with a screen in it, which is why people who search for one get sold three unrelated things. The word has a precise job. A walkthrough follows a single real task from its starting state to its finished state, at the speed of someone actually doing it, so the viewer comes away believing they could repeat it. That is a different contract from a demo, which sells one idea to a stranger and is free to skip whatever is dull, and from a tutorial, which teaches a concept and may never touch the live product at all.

The distinction is not pedantry; it decides length, narration, and what you are allowed to cut. Nielsen Norman Group's definition of task analysis is the useful anchor: it is "the systematic study of how users complete tasks to achieve their goals," and a goal decomposes into a hierarchy of subtasks whose depth "depends on the complexity of the process" ([Rosala, NN/g, 2020](https://www.nngroup.com/articles/task-analysis/)). A walkthrough is that hierarchy, filmed. Fix the task and the rest of the choices fall out of it.

| Format | What it follows | Who is watching | Success looks like | Skip steps? |
| --- | --- | --- | --- | --- |
| Walkthrough | One real task, start to finish | Someone about to do it: a trial user, a new hire, an evaluator | "I could repeat that myself" | No, the gaps between steps are the point |
| Demo | One idea or outcome | A stranger deciding whether to care | "I want that" | Yes, cut straight to the aha |
| Tutorial | A concept or a skill | A learner | "Now I understand how it works" | Yes, abstractions and asides welcome |
| Onboarding clip | The first-value moment | A user who already signed up | Activation | Ruthlessly, one action only |

The last row is the near neighbor that gets conflated most. A first-run onboarding clip is a walkthrough shrunk to a single action and aimed at activation; the format is the same shape, but [the onboarding job trims to the one move that reaches first value](/blog/product-onboarding-video), while a general walkthrough is allowed to follow the whole task. Confuse the two and you either bloat an onboarding clip into a tour nobody finishes or starve a walkthrough of the steps that were its reason to exist.

## Pick the one task worth filming

The hardest decision in a walkthrough is made before you record: which task. A product does dozens of things; a walkthrough films exactly one, and the wrong one wastes the whole runtime. The task worth filming is the one that is at once the reason people adopt the product, legible on screen, and blessed with a clear finished state the viewer can recognize as done.

That finished state is what separates a walkthrough from a feature tour. A tour ends when you run out of features; a walkthrough ends when the task is complete, and that completion is the proof. NN/g's task-analysis guidance adds the second rule: observe the task as it is really performed and remember that "not all users accomplish goals in the same way" ([Rosala, NN/g, 2020](https://www.nngroup.com/articles/task-analysis/)). The temptation is to film the choice-free happy path, the one where every field is pre-filled and no decision is ever made. Film the real path instead, decisions included, because the decisions are where a viewer learns whether they could do this without you.

## A length budget set by task depth, not placement

The sibling question, how long a demo should run, is answered [by where the video will be watched](/blog/how-long-should-a-demo-video-be). A walkthrough answers to a different master. Its length is set by the task, because a walkthrough that drops steps to hit a placement's runtime stops being a walkthrough. So budget by depth, meaning the number of real steps in the task, and let the placement pick which depth of task you film rather than how much of it you show.

| Task depth | Steps in the task | Runtime | Narration (~2.5 words/s) |
| --- | --- | --- | --- |
| Trivial | 1-2 | 15-30 s | ~40-75 words |
| Shallow | 3-5 | 30-60 s | ~75-150 words |
| Standard | 6-9 | 60-120 s | ~150-300 words |
| Deep | 10+ | 2-4 min, chaptered | 300-600 words |

The word column comes straight from narration pace, which [the script template counts section by section](/blog/demo-video-script-template) at roughly 2.5 words a second. The runtime ceiling comes from the data: Vidyard's demo-video guidance lands on "two minutes is ideal, with a maximum of five" ([Vidyard, 2020](https://www.vidyard.com/blog/demo-videos/)), and Wistia's 2025 analysis of over 13 million videos finds viewers still watch more than half of a tutorial in the one-to-five-minute band, while clips under a minute average a 52% engagement rate ([Wistia, 2025](https://wistia.com/learn/marketing/optimal-video-length)). The practical reading: keep a standard walkthrough at or under two minutes, and when the task is genuinely deep, chapter it rather than sprint through it, because a rushed deep walkthrough teaches nothing and a padded shallow one bores.

## The shot-list: one task from empty state to paid invoice

Here is a concrete walkthrough for a freelance-invoicing tool. The task is send an invoice and see it get paid, a standard-depth flow of seven steps, budgeted at about 63 seconds. Each row names what is on screen and the pacing rule that row is there to demonstrate.

| # | On screen | Kind of moment | Pacing | Sec |
| --- | --- | --- | --- | --- |
| 1 | The empty Invoices list, one New Invoice button | Start state | Hold ~3 s so the viewer reads where we are | 0-3 |
| 2 | The new-invoice form; pick a client from the dropdown | Decision | Slow down, let the choice register | 3-15 |
| 3 | Type a line item; the total computes itself | Mechanical | Speed-ramp the typing to a couple of seconds | 15-25 |
| 4 | Set payment terms and a due date | Decision | Hold on the open date picker | 25-38 |
| 5 | Hit Send; the confirmation toast appears | Action | Cut the network wait to nothing | 38-45 |
| 6 | The same invoice, now marked Paid | Finished state | Hold ~4 s: this is the proof | 45-58 |
| 7 | Back on the list, the paid invoice at the top | Return | Brief, closes the loop | 58-63 |

Read the list top to bottom and the shape of a walkthrough is visible: it opens on where the user starts, not on a logo, and it ends on the completed task, not on a features menu. Steps 2 and 4 are the decisions, and they get the most seconds. Steps 3 and 5 are mechanical, and they get the fewest. Step 6 is the payoff the whole task was pointed at, so it gets a deliberate hold. That distribution of seconds is the entire craft, and it is a pacing decision, not a scripting one.

## Pacing: compress the mechanical, dwell on the decision

A live take pays every delay in full: the page load, the spinner, the cursor hunting for the next field, the four seconds a form takes to save. Those seconds are exactly what makes a raw recording feel amateur, and they are also exactly what a walkthrough must remove, because a viewer does not learn anything while a page loads. Jakob Nielsen's response-time limits put numbers on the felt experience: under 0.1 second feels instantaneous, up to about 1 second keeps "the user's flow of thought uninterrupted," and past 10 seconds "the user's attention" wanders off the task entirely ([Nielsen, NN/g, 1993](https://www.nngroup.com/articles/response-times-3-important-limits/)). Every wait longer than a second is flow-of-thought your walkthrough is spending on nothing.

So the rule is two-speed. Compress every mechanical moment to a beat, and dwell on every decision.

| Moment | Rule | Why |
| --- | --- | --- |
| Page load or network wait | Cut it to zero | A wait over ~1 s breaks flow of thought; the viewer learns nothing while it spins |
| Typing, dragging, scrolling | Speed-ramp or hard-cut to a beat | The viewer needs to see that it happens, not watch it in real time |
| A decision or a fork | Hold, and slow the narration | This is where the task is actually taught; give time to read the options |
| The finished state | Hold 3-4 seconds | The proof has to land; cutting away fast wastes the whole task |

Cutting dead time is not the same as speeding the video up. A walkthrough sped to 1.5x reads as frantic; a walkthrough with the waits excised reads as calm and competent, because the pace now matches thought rather than the machine. Amy Schade's usability guidance on video is blunt about the cost of the alternative: "even a few seconds can feel lengthy to a user," and the opening matters most, so keep any intro to five seconds or less and edit tightly throughout ([Schade, NN/g, 2014](https://www.nngroup.com/articles/video-usability/)). The reclaimed seconds go to the two or three moments where the user decides something, which is the only place a walkthrough teaches.

## Keeping the walkthrough true when the task changes

A walkthrough is the video most likely to lie, and the lie is the most damaging kind. Because it follows a real flow, and real flows move, a renamed button, a new required field, or a reordered step leaves the video teaching a task that no longer exists. Since the walkthrough's entire promise is "you could repeat this," a stale one breaks that promise the moment a viewer tries to follow along, which is worse than a marketing demo that is merely a season out of date. The same [staleness that quietly erodes every product demo](/blog/why-product-demos-go-stale) lands hardest on the format whose value is step-by-step accuracy.

The structural fix is to stop treating the walkthrough as a performance and start treating it as a spec you re-render. aidemo, the engine we maintain, is built around exactly this move: the task lives as an agent-authored storyboard, so a renamed button or a reordered step becomes a one-line diff and a fresh render instead of a fresh take. Be clear-eyed about what that trades away. aidemo records inside a browser and no other surface, it expects a coding agent to write the storyboard rather than a person arranging clips by hand, and it ships no visual timeline to nudge, so the payoff is real only on a walkthrough you plan to keep accurate for years, never on a single throwaway screencast. The engine matters far less than the habit the format demands: choose one real task, follow the path a user truly takes, squeeze the mechanical beats and linger on the choices, and keep the result re-renderable rather than re-shootable. [The full script-first playbook](/blog/how-to-make-a-product-demo-video) covers what a walkthrough shares with the rest of the demo family.

## Sources

- [Nielsen Norman Group — Response Times: The 3 Important Limits (Jakob Nielsen)](https://www.nngroup.com/articles/response-times-3-important-limits/)
- [Nielsen Norman Group — Task Analysis: Support Users in Achieving Their Goals (Maria Rosala, 2020)](https://www.nngroup.com/articles/task-analysis/)
- [Nielsen Norman Group — Video Usability (Amy Schade, 2014)](https://www.nngroup.com/articles/video-usability/)
- [Vidyard — How to Make Demo Videos That Win New Business](https://www.vidyard.com/blog/demo-videos/)
- [Wistia — How to Choose the Right Marketing Video Length (2025)](https://wistia.com/learn/marketing/optimal-video-length)

## FAQ

### What is the difference between a product walkthrough and a product demo?

A walkthrough follows one real task from its starting state to a finished state, at the pace of someone doing it, so the viewer believes they could repeat it. A demo sells a single idea to a stranger and is free to skip the dull parts and cut straight to the payoff. The practical tell is what each is allowed to leave out: a demo can drop steps, a walkthrough cannot, because in a walkthrough the steps are the substance.

### How long should a software walkthrough video be?

Budget it by task depth, not by where it plays. A one-or-two-step task is 15 to 30 seconds, a three-to-five-step flow is 30 to 60, and a full six-to-nine-step task runs one to two minutes. Vidyard puts two minutes as ideal and five as the ceiling ([Vidyard, 2020](https://www.vidyard.com/blog/demo-videos/)); when a task genuinely needs longer, chapter it rather than rush it, since a rushed deep walkthrough teaches nothing.

### Should a walkthrough video show every step or skip the boring parts?

Show every decision, skip every wait. The steps where a user chooses something are the walkthrough's reason to exist, so keep them and give them time. The mechanical moments, page loads, typing, saving, teach nothing and should be cut to a beat, because any delay over about a second breaks the viewer's flow of thought ([Nielsen, NN/g, 1993](https://www.nngroup.com/articles/response-times-3-important-limits/)). Cutting dead time is not the same as speeding the video up; one reads as competent, the other as frantic.

# aidemo writer overrides — STRICT, these win over the base lane prompt

Voice and claims policy for the aidemo blog (https://aidemo.top/blog/). The
full historical writer contract lives in `blog/ops/lane-prompt.md`; machine-
enforced numbers (word bands, link budgets, mention cap, banned diction) live
in `blog/blog.config.json` — never restate them here.

## Audience & register

Developers, founders, and PMs at small software companies who need a product
demo video and would rather engineer the problem than perform it. The register
is a serious engineering blog (Stripe's blog, Increment): confident, concrete,
numerate, occasionally wry. Never breathless, never salesy.

## Claims policy

- Concrete numbers with sources: word rates, prices, durations, dates, version
  numbers. Date every third-party capability or pricing claim.
- Original synthesis per article: a worked example, a decision table,
  arithmetic nobody else has done, or a taxonomy that actually cleaves the
  space. The best answer on the internet, not the longest.
- Honest about tools — including ours. When aidemo appears in a comparison,
  disclose it is ours and state its real limitations (browser-only,
  agent-authored storyboards, no GUI timeline editor).
- Cite primary sources: vendor docs and pricing pages, standards (W3C, OSI),
  first-party engineering blogs, published research, actual repos. Never
  another content-marketing blog summarizing them.

## Style

- Markdown tables for anything enumerable — tables are where this blog wins.
- US English. Contractions welcome. No em-dash chains, no exclamation points.
- Never reused across articles: an H2, an FAQ question, a metaphor, a joke, a
  blockquote.
- Anchor text is descriptive, never "click here".

## Heroes

`hero.subject` must be ONE physical object metaphor with a distinct silhouette
(a clapperboard, an hourglass, a megaphone), ≤12 words. No screens, text, UI,
labels, or two-object comparisons — SDXL renders gibberish text and cannot
bind "X beside Y". The matte-clay house style (style/styles.json) is applied
automatically; describe only the object. Check `data/hero-subjects.json` for
metaphors already spent. The caption argues, never describes.

# aidemo blog — writer contract (lane prompt)

You are writing ONE article for the aidemo blog (https://aidemo.top/blog/) as
a single JSON file at `blog/data/articles/{slug}.json`. Your assignment (slug,
title, cluster, role, keywords, angle, evidenceHooks, crossLinks) comes from
`blog/data/topics.json`. The validator at `blog/scripts/validate.mjs` enforces
this contract mechanically — run it and fix every violation before you finish.

## Who you are writing for

Developers, founders, and PMs at small software companies who need a product
demo video and would rather engineer the problem than perform it. The register
is a serious engineering blog (think Stripe's blog or Increment): confident,
concrete, numerate, occasionally wry. Never breathless, never salesy.

## The bar

The article must be the best answer on the internet for its target queries —
not the longest, the best. That means:

- **Concrete numbers with sources.** Word rates, prices, durations, dates,
  version numbers. A claim with a number and a source beats three paragraphs
  of positioning.
- **Original synthesis.** Every article needs at least one thing a reader
  cannot get from the first page of existing results: a worked example, a
  decision table, arithmetic nobody else has done, a taxonomy that actually
  cleaves the space.
- **Honest about tools — including ours.** Date every third-party capability
  or pricing claim. When aidemo appears in a comparison, disclose it is ours
  and state its real limitations (browser-only, agent-authored storyboards,
  no GUI timeline editor).

## Research and citations (the citation gate WILL check you)

- Use web search and fetch to research. Every entry in `## Sources` must be a
  URL you have actually fetched this session and confirmed says what you cite
  it for. The validator HTTP-resolves every Source link; a dead or fabricated
  reference quarantines the article.
- Cite primary sources: vendor docs and pricing pages, standards (W3C, OSI),
  first-party engineering blogs, published research, actual repos. Never
  another content-marketing blog summarizing them.
- In prose, cite as `([Name/vendor, year or date](url))` next to the claim,
  and list the same URL in `## Sources`. Prose citations wrapped in parens
  become numbered superscripts at bake time.
- The topic's `evidenceHooks` are leads, not obligations — verify each one
  live before using it; replace any that died or say something different.

## Structure (validator-enforced)

- `content` starts with `## ` — the template owns the h1. The first H2 names
  substance (banned: "Introduction", "Overview", "What is X", "The short
  answer").
- Ends with `## Sources` (a `- ` bullet list, ≥3 external markdown links)
  then `## FAQ` (≥2 h3 headings phrased as questions ending in `?` — each
  targets a real People-Also-Ask query, answered in 2-4 sentences).
- Spokes: 1,200–2,000 words of prose (Sources excluded). Pillars: 1,800–2,600.
- Use markdown tables for anything enumerable (comparisons, budgets, decision
  matrices). Tables are where this blog wins.
- 3–6 internal links in prose as `[anchor](/blog/slug)` using slugs from
  topics.json (pillars may exceed 6 to route to their spokes). At least half
  must point at articles that already exist as files; unwritten targets are
  legal (the bake unwraps them until they publish). Anchor text is
  descriptive, never "click here".

## Diction (validator-enforced)

- aidemo: at most 2 mentions in prose (code samples excluded), unless the
  topic sets `productMentionCap` higher (comparison pieces that include
  aidemo as an entry). The CTA banner under every article does the selling —
  the prose does not.
- Banned phrasings (hard fail): "in today's fast-paced/digital…", "in the
  ever-evolving landscape of…", "game-changer", "revolutionize", "seamless(ly)",
  "unlock the power/potential", "dive in/into", "delve", "it's important to
  note", "in conclusion", "look no further", "whether you're a…", "to the
  next level", "isn't just a/about…".
- Never reused across articles: an H2, an FAQ question, a metaphor, a joke, a
  blockquote. Check sibling articles in `blog/data/articles/` before writing.
- US English. Contractions welcome. No em-dash chains, no exclamation points.

## JSON fields

- `slug`/filename must match the assignment; `status`: `"draft"` (the
  publish flip happens after review, never by you).
- `title`: the H1 — compelling and keyword-bearing, not clickbait.
- `seoTitle`: ≤60 chars, must end with ` | aidemo`.
- `seoDescription`: 130–160 chars; `excerpt`: 120–160 chars (the dek —
  it should make someone want the article, not summarize it flatly).
- `keyTakeaways`: 3–5 bullets, each ≤200 chars with a concrete number or
  decision in it — this renders as the answer-first card search engines and
  LLMs lift.
- `pillar`: your assignment's `pillar` value verbatim (null for pillars).
- `hero`: optional; fill subject/scene/alt/caption. `hero.subject` feeds the
  image lane and must be ONE physical object metaphor — a single thing with a
  distinct silhouette (a clapperboard, an hourglass, a megaphone), ≤12 words.
  No screens, text, UI, labels, or two-object comparisons: the renderer (SDXL)
  draws gibberish text and cannot bind "X beside Y" compositions. The
  matte-clay house style is applied automatically — describe only the object.
  Avoid metaphors already used by other articles: check
  `blog/data/hero-subjects.json` before choosing. The caption argues, never
  describes.
- `readingTimeMinutes`: words / 220, rounded.
- `publishedAt`/`updatedAt`: today's date.

## Definition of done

1. `blog/data/articles/{slug}.json` written.
2. `cd blog && node scripts/validate.mjs` — zero violations for your file
   (warnings are acceptable if you judged them; say why).
3. Every Source URL fetched and verified live by you this session.
4. Report back: slug, word count, source count, and the one thing in the
   article a competitor page doesn't have.

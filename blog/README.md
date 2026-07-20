# aidemo blog — static-site generator

A lightweight Node bake script that turns article JSON into the static blog
served by GitHub Pages at **https://aidemo.top/blog/** (from the committed
`docs/blog/` output — deploy = git push). The editorial design (serif reading
column, drop cap, accent rules, hairline tables, sticky TOC) is ported from
the BurnWeek blog and re-tokened to the aidemo landing palette (warm paper +
terracotta) — tokens live at the top of `templates/blog.css`, so a brand swap
is one block. English only. No web fonts, no client framework; the only
runtime JS is a ~25-line inline TOC scroll-spy plus a small per-block
copy-button handler on pages that contain code.

Code blocks are syntax-highlighted at bake time with shiki (build-time dep,
grammars/themes bundled — no CDN, no client JS for highlighting): tagged
fences (`yaml`, `js`/`ts`/`tsx`, `json`/`jsonc`/`json5`, `sh`/`bash`/`shell`,
`html`, `css`, `python`, `diff`) get inline one-light token colors re-based
onto the warm panel; untagged or unknown languages stay neutral. Each block
gets a hairline container, an uppercase language chip, and a Copy button.
HTML only — the `.md` mirrors, `llms.txt`, and `llms-full.txt` keep raw
fenced code exactly as authored.

## Layout

```
blog/
  data/
    articles/{slug}.json   one file per article (see schema below)
    topics.json            SEO topic/cluster map (bake tolerates absence)
  templates/blog.css       the design system (single source of CSS truth)
  templates/banner.html    swappable CTA banner (verbatim-injected on HTML pages)
  templates/editorial-policy.md  the E-E-A-T accountability page
  scripts/
    validate.mjs           quality gate (schema, structure, writer contract, citations)
    bake.mjs               the generator
    hero_images.mjs        hero-image lane (local SDXL — see below)
  ops/lane-prompt.md       the writer contract for article-writing agents
  data/hero-subjects.json  per-slug hero subjects (one object metaphor each)
  public/images/           committed WebP heroes: {slug}-400.webp, {slug}-800.webp
../docs/blog/              bake output (COMMITTED — GitHub Pages serves it)
```

## Article schema (`data/articles/{slug}.json`)

```jsonc
{
  "slug": "how-to-make-a-product-demo-video",  // kebab-case, must match filename
  "status": "draft",                            // "draft" | "published"
  "cluster": "demo-videos",                     // hub page key
  "pillar": "slug-of-pillar-or-null",           // null = this IS a pillar
  "title": "…",
  "excerpt": "120-160 chars — doubles as the article dek",
  "seoTitle": "≤60 chars, must end with ' | aidemo'",
  "seoDescription": "130-160 chars",
  "content": "markdown — starts with ## (template owns the h1); must end with '## Sources' (≥3 links) and '## FAQ' (≥2 question-form ### headings)",
  "keyTakeaways": ["3-5 bullets, ≤200 chars each, concrete numbers"],
  "hero": { "subject": "…", "scene": "…", "alt": "…", "caption": "one line that argues, not describes" },  // optional until an image lane exists
  "tags": ["…"],
  "readingTimeMinutes": 7,
  "publishedAt": "2026-07-18",
  "updatedAt": "2026-07-18"
}
```

`topics.json` (the SEO planning lane) has shape `{clusters: {key: {title,
description}}, topics: [{slug, title, cluster, role: "pillar"|"spoke",
pillar, keywords, intent, angle, evidenceHooks, crossLinks, wave}]}`. The
bake uses it for cluster titles/descriptions, pillar roles, and related-
article crossLinks; the validator uses it as the arbiter for roles and
internal-link targets.

## Commands

```bash
cd blog
npm install                         # one-time (deps: marked + shiki, both build-time)

node scripts/validate.mjs           # quality gate — run before every bake
node scripts/validate.mjs --resolve # + HTTP-check every Source link (citation
                                    #   gate: fabricated references must not survive)

node scripts/bake.mjs               # published articles only → ../docs/blog/
node scripts/bake.mjs --drafts      # include drafts (local review only — never commit)
node scripts/bake.mjs --out DIR     # custom output dir

npm run preview                     # serves docs/ at http://localhost:8090/blog/

node scripts/hero_images.mjs        # generate missing hero images (see below)
node scripts/hero_images.mjs --force --only some-slug   # redo one image
```

## Hero images (`scripts/hero_images.mjs`)

Heroes are generated locally with SDXL-Lightning (the same $0 backend as the
landing-page icons: `~/.venvs/sdxl/bin/python
~/dropshipping-irondust/scripts/blog/sdxl_backend.py --fast`, ~24s/image) in
the locked matte-clay house style, then encoded with `cwebp` (quality 85) to
the two files bake.mjs consumes: `public/images/{slug}-800.webp` (article hero
+ og:image) and `{slug}-400.webp` (card srcset). Both are COMMITTED — the lane
runs on this machine, never in CI.

- Subjects live in `data/hero-subjects.json` — one physical object metaphor
  per slug (≤12 words, no screens/text/UI, no two-object comparisons; SDXL
  renders gibberish text and cannot bind comparisons). The style wrapper and
  negative prompt are fixed in the script; only the subject varies.
- Images render at 1216x832 — a native SDXL landscape bucket that exactly
  matches the hero `<img width="1216" height="832">` aspect in bake.mjs.
- Deterministic: seed = fnv1a(slug) + `seedOffset` from hero-subjects.json.
  To re-roll one image, bump its `seedOffset` (committed → reproducible) and
  run with `--force --only {slug}`.
- Existing webp pairs are skipped unless `--force`. Always eyeball every new
  image before committing (broken geometry and accidental text happen).
- One GPU job at a time: the script feeds the backend a single `--jobs` batch
  (model loads once, renders sequentially). Never run two instances at once.

The bake emits: `index.html` (home), `{slug}/index.html` (articles),
`topics/{cluster}/index.html` (hubs), `sitemap.xml`, `feed.xml` (RSS 2.0,
latest 30), `images/` (copied from `public/images/`), the content-hashed
stylesheet, per-article raw-markdown mirrors (`{slug}/index.md`, advertised
via `<link rel="alternate" type="text/markdown">`), `llms.txt`, and
`llms-full.txt`. Output is deterministic — timestamps come from article
fields, never from the clock. robots.txt is NOT baked here — the site root
`docs/robots.txt` owns crawler policy and points at
`https://aidemo.top/blog/sitemap.xml`.

## Publishing flow

1. Write/edit `data/articles/{slug}.json` (status `draft`) per
   `ops/lane-prompt.md`.
2. `node scripts/validate.mjs --resolve` — must pass.
3. Review locally: `node scripts/bake.mjs --drafts && npm run preview`
   (then discard the draft bake: re-run without `--drafts`).
4. Flip status to `published`, re-validate, `node scripts/bake.mjs`.
5. Commit `blog/` + `docs/blog/` together and push — GitHub Pages is the
   deploy.

## Blog-engine migration (M3) — status: PARKED behind the next engine release

This blog is mid-migration onto the centralized
[blog-engine](https://github.com/tandryukha/blog-engine) (2026-07-20). The
consumer layer is installed and proven; the local scripts stay operational
until the engine cuts a release. **Owner-review summary — what a swap would
change: nothing.** The engine bake on main@`87918ce` is **byte-identical**
(diff -r empty, 422 files) to the committed `docs/blog/`, verified against
both a fresh local bake and the live tree, so the URL set (102 articles + 7
hubs + index + editorial-policy + sitemap + feed + llms.txt + llms-full.txt +
md mirrors + images + hashed CSS) is preserved exactly.

Installed now:

- `.claude/skills/aidemo-blog/` — thin engine skill (installed.json pins
  v0.1.1) + `.claude/settings.json` SessionStart update-check hook (merged
  additively; aidemo's own consumer-hook mechanics untouched).
- `blog/blog.config.json` — the machine-enforced knobs (brand/mention-cap 2,
  word bands, link budget, aidemo's banned openers + 14 banned phrasings,
  citations policy `resolve` with the AidemoBlogValidator UA, sdxl images at
  800/400, waves of 5). Three bake knobs are load-bearing for parity:
  `site.codeBlocks` (shiki + copy buttons), `site.indexHeading`
  (`The aidemo blog`), `publish.robots: false` (the site root
  `docs/robots.txt` owns crawler policy — never bake a second one).
- `blog/style/` — `header.html` + `footer.html` partials
  (`{{siteOrigin}}`/`{{base}}`/`{{topicLinks}}`), `styles.json` (the
  matte-clay house style extracted from hero_images.mjs),
  `writer-overrides.md` (voice/claims policy, STRICT layer for engine lane
  prompts). CSS + banner + editorial-policy stay single-sourced in
  `templates/` (the config points at them).

Why parked, not swapped:

1. **Pinning**: `#stable` = v0.1.1, which predates the three bake knobs — the
   pinned channel cannot regenerate this site yet (engine issue
   [#9](https://github.com/tandryukha/blog-engine/issues/9)).
2. **Validator parity**: the engine gate is 44/102 on this corpus — false
   positives from hardcoded BurnWeek diction doctrine
   ([#7](https://github.com/tandryukha/blog-engine/issues/7)) and the missing
   per-topic `productMentionCap`
   ([#8](https://github.com/tandryukha/blog-engine/issues/8)).

`blog/scripts/*` are therefore **frozen pending engine parity** (marked in
each header): keep using them exactly as documented above, but new pipeline
features go to the engine as feedback, not here. Retirement checklist (run
when stable ≥ the release containing 87918ce AND #7/#8 are fixed):
`blog-engine skill update` → engine `bake --out /tmp/x` + `diff -r /tmp/x
docs/blog` empty → engine `validate` green → delete `blog/scripts/*` +
`blog/ops/lane-prompt.md`, repoint `blog/package.json` scripts at
`npx -y github:tandryukha/blog-engine#stable`, thin the `blog-wave` skill to
call engine CLIs.

## Daily GSC indexing (maintainer automation)

`scripts/daily-indexing.sh` runs daily at 10:00 via launchd
(`com.aidemo.seo-indexing`) on the maintainer's machine: it drives Google
Search Console URL Inspection for the `aidemo.top` property through a
Chrome-automation agent, submitting up to 5 never-submitted URLs and
re-checking up to 3 pending ones per day (GSC's request-indexing quota is
~10-12/day per property). The queue (`data/seo/indexing-urls.txt`) was seeded
from both sitemaps and auto-appends newly published articles on every run;
`data/seo/indexing-state.json` is the submitted/indexed ledger. Install by
substituting `__REPO__`/`__HOME__`/`__NTFY_TOPIC__` in
`ops/com.aidemo.seo-indexing.plist.template` and copying it to
`~/Library/LaunchAgents/` (the notification topic is deliberately not stored
in the repo). Delete `data/seo/gsc-property-verified` to pause the job
cleanly. First run 2026-07-20: 5/5 submitted (home, blog index, 3 topic
hubs).

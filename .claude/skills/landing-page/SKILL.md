---
name: landing-page
description: >
  Maintain the aidemo marketing/landing page (docs/index.html, served by GitHub
  Pages at https://tandryukha.github.io/aidemo/) and its indexing plumbing
  (llms.txt, robots.txt, sitemap.xml). Use when the user says "update the
  landing page", "add a section to the site", "change the hero", "update
  positioning", "fix the site", or asks to reflect a new feature/integration
  on the page. Do NOT use for: the GitHub README (separate, hand-curated), the
  docs/internal/ planning docs, or recording demo videos (that's record-demo).
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# landing-page

You maintain aidemo's public landing page. It is the project's pitch to humans
AND its primary machine-readable source for LLM search (GEO). Every edit must
serve both audiences.

## Where things live

- `docs/index.html` — the entire site: one self-contained file (inline CSS/JS).
- `docs/llms.txt` — curated map for LLM crawlers; MUST stay in sync with any
  positioning/feature claims changed on the page.
- `docs/robots.txt` — AI-crawler allowlist. `docs/sitemap.xml` — single URL.
- `docs/hero-demo.mp4` (1280×800 h264, copy of the release asset) +
  `docs/hero-poster.jpg` (poster frame, also the og:image).
- `docs/icons/*.webp` — card icons (176px, shown at 44px) + real customer
  logo marks; `docs/favicon.png` (64px, from the clapper icon). See "Icon
  system" below before adding one.
- `docs/.nojekyll` — keep; Pages serves `docs/` verbatim from `main`.
- `docs/internal/` is **gitignored and private** — never link to it from the
  page, and read `docs/internal/INDEXING_PLAN.md` for strategy/decisions
  (domain-swap checklist lives there).

## Deploy = push to main

Commit straight to `main` and push (no PRs in this repo). GitHub Pages
rebuilds in ~30–60 s. Always verify after pushing:

```bash
until curl -s https://tandryukha.github.io/aidemo/ | grep -q "<distinctive new string>"; do sleep 6; done
```

Run that check with Bash `run_in_background: true`, never a bare foreground sleep.

## Hard rules (learned, do not relearn)

1. **Only claim what ships.** No named future integrations or roadmap promises
   on the page (e.g. ElevenLabs was deliberately removed; "Codex/Gemini
   planned" is the one approved exception, mirroring the README). Describe
   extensibility via what's true in code ("swappable `VoiceProvider`
   interface").
2. **Positioning (approved):** built for coding agents to *autonomously record
   product demos* — landing-page hero videos, GitHub README walkthroughs,
   what-shipped videos for customer release notes. Open-source alternative to
   Screen Studio / Clueso / Demosmith. Keep this framing consistent across
   hero sub, meta description, og:description, JSON-LD, and llms.txt.
3. **Video, never GIF, for the hero.** GIFs are 256-color mush (the old
   560×350 GIF looked terrible upscaled). Use `<video autoplay muted loop
   playsinline preload="metadata" poster=...>` with a same-origin MP4. Set
   `width`/`height` attrs to the file's REAL dimensions (check with
   `ffprobe -v error -select_streams v:0 -show_entries stream=width,height
   -of csv=p=0 <file>`) and keep CSS `width:100%; height:auto;
   aspect-ratio: W / H` — a mismatched height attribute stretches the frame.
4. **Self-contained page.** No CDN scripts, external fonts, or third-party
   requests. Inline everything. Both color schemes must work
   (`prefers-color-scheme` + the CSS variables at the top of the file).
5. **FAQ and JSON-LD move together.** Every visible FAQ `<details>` has a
   matching entry in the `FAQPage` JSON-LD block, same wording. Question-shaped
   headings ("Can Claude Code record a demo video?") — LLM search lifts them
   verbatim. New claims also go into `llms.txt`.
6. **Respect the motion system.** Load stagger = `fade` + `d1..d5` classes;
   scroll fade-in/out = `reveal` class picked up by the IntersectionObserver
   at the bottom of the file; everything is disabled under
   `prefers-reduced-motion`. New sections: `class="reveal"` on the `h2` and on
   each card/step/details. Don't add per-element `transition-delay` that would
   lag hover states (`.reveal.in` resets it to 0s for this reason).

## Design system (match, don't reinvent)

- CSS variables in `:root` (+ light-mode override block): `--bg, --panel,
  --border, --text, --muted, --accent` (#d97757 coral), `--accent-2` (#b07aff
  violet), `--shadow`.
- Building blocks already styled: `.term` (terminal window w/ traffic-light
  bar), `.cards`/`.card` (grid + hover lift), `.steps`/`.step` (numbered
  gradient chips), `.faq details`, `.pill`, `.btn primary|ghost`, `.halo`
  (blurred accent glow behind the hero video).
- Max content width 920px (`.wrap`); wide content scrolls in its own
  container, the body never scrolls horizontally.
- Section order: hero → How it works → Why it's built this way →
  Made with aidemo (#examples) → Integrations → Quickstart → FAQ → footer.
  New sections get a nav link (`hide-sm` class hides it on mobile).

## Icon system (no emojis)

Card icons, the nav brand mark, and the favicon are **locally generated
matte-clay badge tiles** (own dark backdrop → theme-proof), NOT emojis and NOT
transparent cutouts. Rendered with the dropshipping-irondust SDXL backend:

```bash
HF_HUB_DOWNLOAD_TIMEOUT=20 ~/.venvs/sdxl/bin/python \
  ~/dropshipping-irondust/scripts/blog/sdxl_backend.py --fast --jobs jobs.jsonl
```

- Job = `{"prompt", "negative", "out", "seed", "width":1024, "height":1024}`;
  prompt is used verbatim. Locked style prompt: *"3D icon of {subject},
  minimalist matte clay style, soft rounded shapes, smooth studio product
  render, centered, floating on a plain dark charcoal background, coral orange
  and violet purple rim lighting, gentle top light, soft shadow, high detail,
  square composition"* — matches `--accent`/`--accent-2`. Keep it for new
  icons or the set stops matching. Note: `--fast` runs guidance 1.0, so the
  negative prompt has little effect and CLIP truncates at 77 tokens — the
  positive prompt must carry the style.
- Generate 2–3 seeds per subject, pick at ACTUAL size (44px and 24px composited
  on `#161a20` AND white) before shipping — subjects that come out crumbly or
  abstract get re-rolled, not shipped. Object subjects work; abstract marks
  don't.
- Post-process: crop ~6% margins → 176×176 webp q85 (44px @4x) →
  `docs/icons/{name}.webp`; wire as `<img class="ic" ... width="44"
  height="44">` above the card `h3` (alt="" aria-hidden). Customer logo marks
  use `class="ic brand"` (transparent, no tile). Favicon = 64px PNG of the
  clapper icon.
- Raw seeds/jobs live in the session scratchpad only; committed output is the
  small webps. One GPU job at a time (Metal contention).

## When swapping the hero video

1. `gh release download <tag> --repo tandryukha/aidemo -p '<asset>.mp4' -O docs/hero-demo.mp4`
2. Regenerate the poster: `ffmpeg -y -v error -ss <good-second> -i
   docs/hero-demo.mp4 -frames:v 1 -q:v 3 docs/hero-poster.jpg`
3. Update the `aspect-ratio` / `width`/`height` attrs if dimensions changed.
4. Keep the "watch the narrated version" link pointing at the release asset
   URL (the page's video is muted).

## When the custom domain lands

Follow the swap checklist in `docs/internal/INDEXING_PLAN.md` §4: Pages
custom-domain setting, find-replace the `tandryukha.github.io/aidemo` URLs in
`index.html` (canonical, og:url, og:image), `robots.txt` (Sitemap line),
`sitemap.xml`, `package.json` homepage, repo website field; then Search
Console + Bing Webmaster Tools verification and sitemap submission.

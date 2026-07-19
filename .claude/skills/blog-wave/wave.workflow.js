export const meta = {
  name: 'blog-wave',
  description: 'Write one wave of aidemo blog articles (opus-xhigh writers in parallel) and ship it (fable-xhigh ship agent)',
  phases: [
    { title: 'Write', detail: 'one opus-xhigh writer per topic', model: 'opus' },
    { title: 'Ship', detail: 'validate, fix, hero images, publish, bake, push, verify' },
  ],
}
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
if (!parsedArgs || !Array.isArray(parsedArgs.topics)) throw new Error('blog-wave needs args {wave, topics[]}')
const { wave, topics } = parsedArgs
const slugs = topics.map((t) => t.slug).join(', ')

const writerPrompt = (t) => `You are a writer for the aidemo blog. Your assignment: write the ${t.role.toUpperCase()} article with slug \`${t.slug}\` (wave ${wave}).

Read these first, in order:
1. /Users/tandryukha/demo-engine/blog/ops/lane-prompt.md — the writer contract; the validator enforces it mechanically (including the hero.subject rules).
2. /Users/tandryukha/demo-engine/blog/data/topics.json — find your slug's entry (title, cluster, role, pillar, keywords, intent, angle, evidenceHooks, crossLinks, productMentionCap if set). The entry's "angle" names your article's original contribution — deliver exactly that.
3. /Users/tandryukha/demo-engine/blog/README.md — the article JSON schema.
4. List /Users/tandryukha/demo-engine/blog/data/articles/ — 22+ published articles exist. Check every H2 and FAQ question you plan against theirs (the validator hard-fails exact reuse and warns on shared 10-word passages). Fully read the 2-3 nearest-territory siblings and complement rather than repeat them: when a sibling owns a fact, table, or taxonomy, link it instead of re-deriving it.

Research with WebSearch/WebFetch. Every URL in \`## Sources\` must be one you fetched and verified live this session — the citation gate HTTP-checks them; date vendor pricing/capability claims in prose. aidemo (https://aidemo.top, https://github.com/tandryukha/aidemo) is ours — disclose that wherever it appears, with honest limits (browser-only capture, agent-authored storyboards, no GUI timeline editor). Respect your topic's mention cap.

Write to /Users/tandryukha/demo-engine/blog/data/articles/${t.slug}.json with status "draft" and publishedAt/updatedAt set to today's date (run `date +%F`). Include a hero object whose subject follows the lane-prompt rules: ONE physical object metaphor, <=12 words, no screens/text/UI/labels, not already used in blog/data/hero-subjects.json.

Internal links: 3-6 in prose per the contract (pillars may exceed to route to spokes); prefer live targets. The other wave-${wave} topics (${slugs}) are being written concurrently and may not be on disk when you validate. If the ONLY remaining violation for your file is the internal-link live ratio caused by that race, accept it and say so in your report.

When done: run \`cd /Users/tandryukha/demo-engine/blog && node scripts/validate.mjs\` and fix every violation for YOUR file (except the race case). Do not touch any other file, do not commit, do not flip status to published.

Final report (raw data): slug; word count; source count, all live-verified; warnings accepted and why; the one thing your article has that competitor pages don't.`

phase('Write')
const written = await parallel(topics.map((t) => () =>
  agent(writerPrompt(t), { label: `write:${t.slug}`, phase: 'Write', model: 'opus', effort: 'xhigh' })))

phase('Ship')
const ship = await agent(`You are the ship agent for aidemo blog wave ${wave} in /Users/tandryukha/demo-engine. Parallel writers just drafted: ${slugs}. Some may have failed — ship whatever is on disk and report missing slugs. Work autonomously to completion.

1. cd blog && node scripts/validate.mjs --resolve. Fix remaining violations with MINIMAL edits via a small python json script: for internal-link live-ratio failures, weave 1-2 links to live siblings into natural seams and/or unwrap the farthest-wave dead links (re-read every sentence you edit for grammar — a prior session broke subject-verb agreement doing this). Never rewrite a writer's prose beyond what the fix needs. Re-validate until every present wave-${wave} article passes; warnings are acceptable if you judge them (say why).
2. Hero images for the new slugs: ensure each has an entry in blog/data/hero-subjects.json (use the article's hero.subject if it obeys the house rules in blog/README.md "Hero images"; otherwise write a better single-object metaphor, distinct from all existing entries). Before generating, check for a running SDXL process (ps aux | grep sdxl_backend | grep -v grep) — the 22-hero backfill may still hold the GPU; if found, poll every 60s inside one Bash call until it exits. Then generate with node scripts/hero_images.mjs in FOREGROUND Bash calls only (never background — a prior background run died with its agent), at most 6 slugs per call, timeout 600000 each, strictly sequential. Visually Read each new {slug}-800.webp; re-roll bad images per the README (bump seedOffset, --force --only slug), up to 2 re-rolls; after 3 failures swap the metaphor.
3. Flip the present wave-${wave} articles to published. Re-run node scripts/validate.mjs (must pass). node scripts/bake.mjs.
4. Commit blog/data/articles, blog/data/hero-subjects.json, blog/public/images, and docs/blog together: git commit -s, subject "feat: blog wave ${wave} — <n> articles live", body listing the slugs and one line per article's differentiator, ending with: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>. Push to main; if rejected, git pull --rebase origin main and push again (up to 3 attempts — another lane may push concurrently).
5. Verify deploy: poll curl -sL https://aidemo.top/blog/ and one new article URL until the new content appears (up to 5 minutes).

Return raw data: slugs shipped; slugs missing/failed and why; validator fixes you made; images generated and re-roll count; commit hash; deploy verification result.`, { label: `ship-wave-${wave}`, phase: 'Ship', effort: 'xhigh' })

return { written: written.map((r, i) => ({ slug: topics[i].slug, ok: r !== null })), ship }
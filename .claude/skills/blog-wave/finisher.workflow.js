export const meta = {
  name: 'blog-wave-finisher',
  description: 'Finish shipping a wave whose drafts are already on disk (validate, heroes, publish, bake, push)',
  phases: [{ title: 'Ship', detail: 'one fable-xhigh ship agent' }],
}
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const { wave, slugs } = parsedArgs
phase('Ship')
const ship = await agent(`You are the ship agent for aidemo blog wave ${wave} in /Users/tandryukha/demo-engine. The wave's 5 draft articles are ALREADY on disk (written by a previous run that died mid-ship): ${slugs.join(', ')}. blog/data/hero-subjects.json may already carry partial entries for them from the interrupted run — reconcile rather than duplicate. Work autonomously to completion.

1. cd blog && node scripts/validate.mjs --resolve. Fix remaining violations with MINIMAL edits via a small python json script (for internal-link live-ratio failures: weave 1-2 links to live siblings into natural seams and/or unwrap the farthest-wave dead links; re-read every edited sentence for grammar). Re-validate until every wave-${wave} article passes; warnings acceptable if judged (say why).
2. Hero images: ensure each of the 5 slugs has a hero-subjects.json entry obeying the house rules in blog/README.md "Hero images" (one physical object metaphor, distinct from all existing entries; use the article's hero.subject when compliant). Check for a running SDXL process first (ps aux | grep sdxl_backend | grep -v grep); if found, poll every 60s in one Bash call until it exits. Generate with node scripts/hero_images.mjs in FOREGROUND Bash calls only (never background), at most 6 slugs per call, timeout 600000, strictly sequential. Visually Read each new {slug}-800.webp; re-roll bad images per the README (seedOffset bump, --force --only), up to 2 re-rolls; after 3 failures swap the metaphor and update the article's hero block to match.
3. Flip the 5 articles to published. Re-run node scripts/validate.mjs (must pass). node scripts/bake.mjs.
4. Commit blog/data/articles, blog/data/hero-subjects.json, blog/public/images, docs/blog together: git commit -s, subject "feat: blog wave ${wave} — 5 articles live", body listing slugs, ending with: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>. Push to main (pull --rebase retry up to 3x).
5. Verify deploy: poll curl -sL https://aidemo.top/blog/ and one new article URL until the new content appears (up to 5 minutes) — complete this poll INSIDE a foreground Bash call before you finish; do not end your turn with it pending.

Return raw data: slugs shipped; validator fixes; images generated/re-rolled/swapped; commit hash; deploy verification result.`, { label: `ship-wave-${wave}`, effort: 'xhigh' })
return { ship }
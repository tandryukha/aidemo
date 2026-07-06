<!-- Thanks! Keep PRs focused — one change per PR. See CONTRIBUTING.md. -->

## What & why

<!-- One or two sentences. Link an issue if there is one: Fixes #123 -->

## How it was tested

<!-- For engine changes, the bar is the self-contained fixture rendering end-to-end:
       node examples/local-demo/serve.mjs                          # terminal 1
       node bin/aidemo.mjs render examples/local-demo --headless   # terminal 2
     If you tested against a real storyboard/flow, describe it. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] The fixture (`examples/local-demo`) still renders end-to-end — or the change doesn't touch the pipeline
- [ ] If the storyboard schema (`src/types.ts`) changed, `.claude/skills/record-demo/SKILL.md` was updated to match
- [ ] README / SKILL.md updated if user-visible behavior changed
- [ ] All commits are signed off (`git commit -s` — DCO, required to merge)
- [ ] No new install scripts, network endpoints, or unpinned GitHub Actions (CI policy)

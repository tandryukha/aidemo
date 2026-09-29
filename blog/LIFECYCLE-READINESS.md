# aidemo blog — lifecycle readiness (blog-engine v0.4.0, 2026-09-29)

Engine upgraded to v0.4.0; `lifecycle` block added (`enabled: true`,
`gsc.siteUrl: sc-domain:aidemo.top`). Propose-only: nothing changes a served state
except a human-run `disposition apply --approve`.

## Config fixes

- Added the missing `citations.contact` (`tool: aidemo-blog`, `email:
  tandryukha@gmail.com`; the email is only sent to NCBI as the courtesy contact
  for the resolver, owner: swap for a project address if you prefer).
- `engine.minVersion` 0.2.0 -> 0.4.0.

## Offline checks (2026-09-29)

- `validate`: 102/102 pass. `critic --self-test`: OK.
- `bake`: v0.4.0 output byte-identical to v0.2.0 (422 files) and to committed
  `docs/blog` (no `indexing` field => all `indexed`).
- `wave cadence --since 2000-01-01` (limit `wave.cadencePerDay: 5`): all **102
  articles on ONE date (2026-07-18)**, entropy ratio 0.00 (0 of 4.39 bits). The
  clearest bulk-drop footprint of the three consumers.

## GSC (connected 2026-09-29)

Service account `maxfit-analytics@maxfit-478020.iam.gserviceaccount.com` has
Restricted read on `sc-domain:aidemo.top`; key via `GSC_CREDENTIALS` (never in git).
`gsc sync --days 480` -> 2025-06-06..2026-09-28, 398 page-day rows (raw gitignored).

- Blog totals since launch: **0 clicks, 1,166 impressions** (weekly impressions
  8 -> 48 -> 95 -> 11 -> 226 -> 394 -> 127 -> 58 -> 182 -> 14 -> 3). No keeper
  reaches `keepMinScore` (0 of 102). Top by impressions: cap-vs-screen-studio (142),
  demo-environments-and-seed-data (123), camtasia-alternatives (120).
- `disposition --dry-run` (`data/lifecycle/proposals/disposition-2026-09-28.csv`):
  **keep-indexed 102, noindex 0, 301 0, 410 0** — all are inside the 90-day
  probation window (launched 07-18). Near-dup fold skipped (embed_dedup.py not found).
- Report: `data/lifecycle/report-2026-09-29.md`. The September 2026 spam update is
  rolling out (since 09-24): do not change indexing states meanwhile.

## Owner actions / next step

1. After probation (~2026-10-16), re-run `gsc sync -> score -> disposition
   --dry-run` and review; expect most articles proposed for noindex at this
   click level. Decision and `apply` are human-only; re-bake `docs/blog` and review
   the diff before pushing.
2. No new bulk drops: write new articles with `"indexing": "probation"`, drip at
   `cadencePerDay` (`wave cadence --suggest N`).

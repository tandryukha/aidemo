# Recording ChatGPT apps (Apps SDK widgets)

> Part of [aidemo](../README.md). For a plain web app (a marketplace, a
> dashboard, a SaaS UI) you don't need any of this — just author
> `goto`/`type`/`click`/`scrollTo` against the site's own selectors. This page
> is only for demos whose subject is a ChatGPT Apps SDK widget embedded inside
> chatgpt.com. The `record-demo` skill and [docs/AUTHORING.md](AUTHORING.md)
> carry the full hard-won specifics.

An Apps SDK app renders as a **sandboxed iframe widget** inside chatgpt.com,
invoked by natural language. To record one:

1. Create a **dedicated Chrome profile**, open it, and log into ChatGPT with
   your app's dev connector enabled. Note its user-data dir.
2. Point the engine at it: set `AIDEMO_CHROME_PROFILE=/path/to/profile` in `.env`
   (or pass `--profile`). **Quit any Chrome using that profile first** — Playwright
   needs exclusive access.
3. In the storyboard, declare the widget iframe under `frames`, type into the
   composer with `{ "named": "composer" }`, and target widget elements with
   `{ "frame": "widget", "selector": "..." }`, waiting via `waitForWidget`.
4. Run headed: `aidemo render demos/<name>` (no `--headless`).

Because it's your genuine, logged-in Chrome, ChatGPT's bot detection isn't a
factor. Model replies still vary run-to-run, so review and re-run if a take is
off — the storyboard and narration stay the same. The `record-demo` skill and
the ChatGPT-apps section of [docs/AUTHORING.md](AUTHORING.md) document the
hard-won specifics (nested-iframe descent, login/keychain, Cloudflare,
interruption screens).

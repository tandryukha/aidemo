# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

- **Preferred:** GitHub private vulnerability reporting — use
  ["Report a vulnerability"](https://github.com/tandryukha/demo-engine/security/advisories/new)
  under the repo's Security tab.
- **Fallback:** email [tandryukha@gmail.com](mailto:tandryukha@gmail.com).

You'll get an acknowledgement, and a fix or a public advisory once resolved.

## Supported versions

Only the **latest release** receives security fixes.

## Security model

What the tool does — and doesn't do — at runtime:

- **No telemetry, no analytics.** Nothing is phoned home.
- **No install-time scripts.** `package.json` has no `postinstall`/`preinstall`
  hooks; installing runs nothing.
- **Network access is exactly two endpoints, both user-initiated:**
  - `api.openai.com` — only when you run `aidemo voice` or `aidemo captions`,
    using your own `OPENAI_API_KEY`.
  - `github.com` — only via your own locally-authenticated `gh` CLI, when you
    run `aidemo feedback`.
- **Recording and composing are fully local.** `record`, `compose`, and the
  rest of the pipeline spawn Playwright and ffmpeg on your machine; no cloud
  upload.
- **No secrets stored** beyond your own `.env` (your OpenAI key). The Chrome
  profile used for recording stays on your machine.
- **Small, auditable surface:** ~20 source files under `src/`, 5 runtime
  dependencies (`commander`, `openai`, `playwright`, `tsx`, `zod`), MIT
  licensed.

If you'd rather not track the moving `#stable` tag, pin an immutable ref:
`npx -y github:tandryukha/demo-engine#v0.3.0` (or a full commit SHA).

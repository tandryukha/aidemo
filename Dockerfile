# Container image for the aidemo MCP server (stdio transport).
#
# Real renders drive system Chrome + ffmpeg; MCP introspection (initialize +
# tools/list) needs neither, so this image stays lean and just starts the server
# and answers — which is all directory checks (e.g. Glama) require. Installs the
# latest release from npm at build time: the `latest` dist-tag moves with the
# `stable` git tag (release.yml moves both). Not `npm install -g github:…`:
# a global install nests the dependencies inside the package folder that npm is
# still unpacking from git, and the install fails.
# Pinned by digest (Scorecard Pinned-Dependencies); bump tag+digest together.
FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

RUN npm install -g @tandryukha/aidemo@latest \
 && npm cache clean --force

# stdio MCP server — no port to expose.
ENTRYPOINT ["aidemo", "mcp"]

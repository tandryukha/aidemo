# Container image for the aidemo MCP server (stdio transport).
#
# Real renders drive system Chrome + ffmpeg; MCP introspection (initialize +
# tools/list) needs neither, so this image stays lean and just starts the server
# and answers — which is all directory checks (e.g. Glama) require. Installs the
# engine from the moving `stable` git ref at build time.
FROM node:22-slim

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "github:tandryukha/aidemo#stable" \
 && npm cache clean --force

# stdio MCP server — no port to expose.
ENTRYPOINT ["aidemo", "mcp"]

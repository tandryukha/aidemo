# Container image for the aidemo MCP server (stdio transport).
#
# Real renders drive system Chrome + ffmpeg; MCP introspection (initialize +
# tools/list) needs neither, so this image stays lean and just starts the server
# and answers — which is all directory checks (e.g. Glama) require. Builds the
# engine from this checkout: production dependencies installed with `npm ci`
# from package-lock.json (pinned by hash), no install scripts. .dockerignore
# limits the build context to the files the engine reads at runtime.
# Pinned by digest (Scorecard Pinned-Dependencies); bump tag+digest together.
FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /opt/aidemo
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit \
 && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY docs/AUTHORING.md ./docs/AUTHORING.md
COPY .claude/skills/record-demo/SKILL.md ./.claude/skills/record-demo/SKILL.md
RUN ln -s /opt/aidemo/bin/aidemo.mjs /usr/local/bin/aidemo

# stdio MCP server — no port to expose.
ENTRYPOINT ["aidemo", "mcp"]

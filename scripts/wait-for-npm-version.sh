#!/usr/bin/env bash
# Wait until npm serves one published version, at the URL the MCP Registry reads
# when it checks the package's mcpName. A new version can take minutes to appear
# there (6 min for 0.20.3), and publishing before it does gets a 400.
#
#   scripts/wait-for-npm-version.sh <package> <version>
#
# Exits 0 once it's served, 1 on timeout, 2 on bad usage. Any other answer, or a
# network error, counts as not there yet. NPM_WAIT_SECONDS, NPM_WAIT_INTERVAL and
# NPM_REGISTRY_URL exist for tests.
set -uo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <package> <version>" >&2
  exit 2
fi

name="$1"
version="$2"
limit="${NPM_WAIT_SECONDS:-1200}"
interval="${NPM_WAIT_INTERVAL:-15}"
url="${NPM_REGISTRY_URL:-https://registry.npmjs.org}/${name//\//%2F}/$version"

SECONDS=0
while :; do
  if curl --silent --fail --max-time 20 --output /dev/null "$url"; then
    echo "npm serves $name@$version (waited ${SECONDS}s)"
    exit 0
  fi
  if [ "$SECONDS" -ge "$limit" ]; then
    echo "::error::npm still doesn't serve $name@$version after ${SECONDS}s ($url). Nothing was published to the MCP Registry. Re-run the failed job once that URL answers: the earlier steps skip what's already done."
    exit 1
  fi
  echo "waiting for $name@$version on npm (${SECONDS}s of ${limit}s)"
  sleep "$interval"
done

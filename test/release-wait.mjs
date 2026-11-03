// The release workflow's wait for npm: it must poll past a slow npm and fail
// loudly on timeout, never fall through to an MCP Registry publish that gets a
// 400 (release run 41676852980). Local server only, no network.
//
//   npx tsx --test test/release-wait.mjs      (part of `npm test`; needs bash + curl)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "wait-for-npm-version.sh");

function run(args, env = {}) {
  return new Promise((done) => {
    const proc = spawn("bash", [SCRIPT, ...args], {
      env: { ...process.env, NPM_WAIT_INTERVAL: "0.05", ...env },
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("close", (code) => done({ code, out }));
  });
}

/** A registry answering each request with the next status; the last one repeats. */
async function registry(statuses) {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.statusCode = statuses[Math.min(paths.length - 1, statuses.length - 1)];
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    paths,
    close: () => new Promise((r) => server.close(r)),
  };
}

const PKG = ["@tandryukha/aidemo", "1.2.3"];

test("returns at once when npm already serves the version", async () => {
  const r = await registry([200]);
  const { code, out } = await run(PKG, { NPM_REGISTRY_URL: r.url });
  await r.close();
  assert.equal(code, 0);
  assert.match(out, /npm serves @tandryukha\/aidemo@1\.2\.3/);
  assert.deepEqual(r.paths, ["/@tandryukha%2Faidemo/1.2.3"]);
});

test("keeps polling through 404s and server errors", async () => {
  const r = await registry([404, 404, 500, 503, 200]);
  const { code } = await run(PKG, { NPM_REGISTRY_URL: r.url, NPM_WAIT_SECONDS: "30" });
  await r.close();
  assert.equal(code, 0);
  assert.equal(r.paths.length, 5);
});

test("times out with a clear error instead of falling through", async () => {
  const r = await registry([404]);
  const { code, out } = await run(PKG, { NPM_REGISTRY_URL: r.url, NPM_WAIT_SECONDS: "1" });
  await r.close();
  assert.equal(code, 1);
  assert.match(out, /::error::npm still doesn't serve @tandryukha\/aidemo@1\.2\.3/);
  assert.ok(r.paths.length > 1, "polled more than once");
});

test("an unreachable registry counts as not there yet", async () => {
  const r = await registry([200]);
  const { url } = r;
  await r.close();
  const { code, out } = await run(PKG, { NPM_REGISTRY_URL: url, NPM_WAIT_SECONDS: "1" });
  assert.equal(code, 1);
  assert.match(out, /::error::/);
});

test("bad usage is its own exit code", async () => {
  assert.equal((await run(["only-one-arg"])).code, 2);
});

test("defaults wait at least 15 minutes", () => {
  const limit = Number(/NPM_WAIT_SECONDS:-(\d+)/.exec(readFileSync(SCRIPT, "utf8"))[1]);
  assert.ok(limit >= 15 * 60, `waits only ${limit}s`);
});

test("release.yml waits for npm before it publishes to the MCP Registry", () => {
  const yml = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const wait = yml.indexOf("scripts/wait-for-npm-version.sh");
  assert.ok(wait > 0, "the workflow calls the wait");
  assert.ok(wait < yml.indexOf("./mcp-publisher publish"), "the wait comes first");
  assert.doesNotMatch(yml, /for _ in 1 2 3/, "the old loop fell through on timeout");
});

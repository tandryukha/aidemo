#!/usr/bin/env node
// MCP smoke test: spins up `aidemo mcp` over stdio and exercises the tool
// surface against the bundled fixture (examples/local-demo). Needs Chrome —
// like the e2e render smoke, this is a local gate, not a CI job.
//
//   npm run mcp-smoke
//
// Covers: initialize handshake, tool listing, guide/schema tools, storyboard
// validation (positive + negative), a canceled probe job, busy rejection
// while a probe runs, a probe job polled to success, and resource reads.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = resolve(ROOT, "examples", "local-demo");
const FIXTURE_URL = "http://localhost:8787/";

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
}

function structured(res) {
  if (res.structuredContent) return res.structuredContent;
  try {
    return JSON.parse(res.content?.[0]?.text ?? "{}");
  } catch {
    return {};
  }
}

async function fixtureServer() {
  // Reuse an already-running fixture server (dev convenience), else spawn one.
  try {
    const res = await fetch(FIXTURE_URL, { signal: AbortSignal.timeout(500) });
    if (res.ok) return null;
  } catch {
    // not running — spawn below
  }
  const child = spawn("node", [resolve(FIXTURE, "serve.mjs")], {
    cwd: ROOT,
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(FIXTURE_URL, { signal: AbortSignal.timeout(500) });
      if (res.ok) return child;
    } catch {
      // keep waiting
    }
  }
  child.kill();
  throw new Error("fixture server did not come up on :8787");
}

async function pollJob(client, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.callTool({
      name: "job_status",
      arguments: { jobId },
    });
    const s = structured(res);
    if (s.status && s.status !== "running") return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const serve = await fixtureServer();
const transport = new StdioClientTransport({
  command: "node",
  args: ["bin/aidemo.mjs", "mcp"],
  cwd: ROOT,
  stderr: "inherit",
});
const client = new Client({ name: "mcp-smoke", version: "0.0.0" });

try {
  await client.connect(transport);

  // --- handshake -----------------------------------------------------------
  const info = client.getServerVersion();
  check(info?.name === "aidemo", `serverInfo.name is aidemo (got ${info?.name})`);
  check(/^\d+\.\d+\.\d+$/.test(info?.version ?? ""), `server version looks semver (${info?.version})`);

  // --- tool list ------------------------------------------------------------
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const expected of [
    "get_authoring_guide",
    "get_storyboard_schema",
    "validate_storyboard",
    "init_demo",
    "doctor",
    "job_status",
    "job_list",
    "job_cancel",
    "probe",
    "record",
    "render",
    "voice",
    "captions",
    "compose",
    "gif",
  ]) {
    check(names.has(expected), `tool registered: ${expected}`);
  }

  // --- sync tools ------------------------------------------------------------
  const guide = structured(
    await client.callTool({ name: "get_authoring_guide", arguments: {} })
  );
  check(
    typeof guide.guide === "string" && guide.guide.includes("storyboard"),
    "authoring guide mentions storyboards"
  );

  const schema = structured(
    await client.callTool({ name: "get_storyboard_schema", arguments: {} })
  );
  check(
    Boolean(schema.schema?.properties?.scenes),
    "storyboard JSON schema has properties.scenes"
  );

  const valid = structured(
    await client.callTool({
      name: "validate_storyboard",
      arguments: { dir: FIXTURE },
    })
  );
  check(valid.valid === true, `fixture storyboard validates (${JSON.stringify(valid.issues ?? [])})`);

  const invalid = structured(
    await client.callTool({
      name: "validate_storyboard",
      arguments: { json: '{"title": 1}' },
    })
  );
  check(
    invalid.valid === false && (invalid.issues?.length ?? 0) > 0,
    "bad storyboard yields structured issues"
  );

  // --- job model: cancel round-trip ------------------------------------------
  const canceled = structured(
    await client.callTool({
      name: "probe",
      arguments: { dir: FIXTURE, headless: true },
    })
  );
  check(Boolean(canceled.jobId), "probe (to cancel) returned a jobId");
  await client.callTool({
    name: "job_cancel",
    arguments: { jobId: canceled.jobId },
  });
  const canceledFinal = await pollJob(client, canceled.jobId, 60_000);
  check(
    canceledFinal.status === "canceled",
    `canceled probe settles as canceled (got ${canceledFinal.status})`
  );

  // --- job model: busy rejection + probe to success ---------------------------
  const probe = structured(
    await client.callTool({
      name: "probe",
      arguments: { dir: FIXTURE, headless: true },
    })
  );
  check(Boolean(probe.jobId), "probe returned a jobId");
  check(probe.demoDir === FIXTURE, `probe echoes absolute demoDir (${probe.demoDir})`);

  const busyRes = await client.callTool({
    name: "probe",
    arguments: { dir: FIXTURE, headless: true },
  });
  const busy = structured(busyRes);
  check(busyRes.isError === true, "second probe while busy is an error");
  check(busy.runningJobId === probe.jobId, "busy error carries runningJobId");

  const final = await pollJob(client, probe.jobId, 180_000);
  check(final.status === "succeeded", `probe succeeded (got ${final.status}: ${final.error?.message ?? ""})`);
  check((final.logTail?.length ?? 0) > 0, "job_status returns a log tail");
  check(
    final.result?.timeline && existsSync(final.result.timeline),
    `timeline exists on disk (${final.result?.timeline})`
  );
  check(final.scenesDone > 0, `scene progress tracked (${final.scenesDone}/${final.scenesTotal})`);

  const list = structured(await client.callTool({ name: "job_list", arguments: {} }));
  check((list.jobs?.length ?? 0) === 2, `job_list has both jobs (${list.jobs?.length})`);

  // --- resources --------------------------------------------------------------
  const { resources } = await client.listResources();
  const uris = new Set(resources.map((r) => r.uri));
  check(uris.has("aidemo://authoring-guide"), "authoring-guide resource listed");
  check(uris.has("aidemo://storyboard-schema"), "storyboard-schema resource listed");
  const guideRes = await client.readResource({ uri: "aidemo://authoring-guide" });
  check(
    (guideRes.contents?.[0]?.text ?? "").includes("Action vocabulary") ||
      (guideRes.contents?.[0]?.text ?? "").includes("action vocabulary"),
    "authoring-guide resource readable"
  );
} finally {
  await client.close().catch(() => {});
  serve?.kill();
}

if (failures) {
  console.error(`\nmcp-smoke: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nmcp-smoke: all checks passed");

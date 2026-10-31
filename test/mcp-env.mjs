#!/usr/bin/env node
// MCP .env regression test (issue #77) — no Chrome, no network, no API key.
//
//   npm run mcp-env-test
//
// Spawns `aidemo mcp` over stdio and reads the env back through the doctor
// tool (tts.provider ← AIDEMO_TTS_PROVIDER, tts.elevenLabsKey ← presence of
// ELEVENLABS_API_KEY). Proves that:
//   1. the server loads cwd/.env at bootstrap, exactly like the CLI;
//   2. a server spawned elsewhere (the usual MCP-client case) still picks up
//      the project's .env when a tool is given a demo dir inside that repo;
//   3. moving to a repo without a .env restores the previous values;
//   4. the "env: loaded" notice goes to stderr, never the JSON-RPC stdout.
// Assumes the engine checkout's own .env (if any) doesn't set those two keys.

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = ["AIDEMO_TTS_PROVIDER", "ELEVENLABS_API_KEY"];

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  ok: ${label}`);
  else {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "aidemo-mcp-env-"));
const projA = join(tmp, "repo-a");
const demoA = join(projA, "demos", "x");
const projB = join(tmp, "repo-b");
const elsewhere = join(tmp, "elsewhere");
for (const d of [join(projA, ".git"), demoA, join(projB, ".git"), elsewhere]) {
  mkdirSync(d, { recursive: true });
}
writeFileSync(
  join(projA, ".env"),
  "# project env\nAIDEMO_TTS_PROVIDER=elevenlabs\nELEVENLABS_API_KEY='from-dotenv'\n"
);

const env = { ...process.env };
for (const k of KEYS) delete env[k];

async function withServer(cwd, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve(ROOT, "bin", "aidemo.mjs"), "mcp"],
    cwd,
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (b) => (stderr += b));
  const client = new Client({ name: "mcp-env-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const tts = async (dir) => {
      const res = await client.callTool({ name: "doctor", arguments: dir ? { dir } : {} });
      return res.structuredContent?.tts ?? {};
    };
    await fn(tts, () => stderr);
  } finally {
    await client.close();
  }
}

try {
  console.log("server cwd = project (CLI-equivalent bootstrap):");
  await withServer(projA, async (tts) => {
    const t = await tts();
    check(t.provider === "elevenlabs", `cwd/.env loaded at bootstrap (provider=${t.provider})`);
    check(t.elevenLabsKey === "set", `quoted value loaded (elevenLabsKey=${t.elevenLabsKey})`);
  });

  console.log("server cwd elsewhere (typical MCP client):");
  await withServer(elsewhere, async (tts, stderr) => {
    const base = await tts();
    check(base.provider === "openai", `no .env in server cwd → default (provider=${base.provider})`);
    const a = await tts(demoA);
    check(a.provider === "elevenlabs", `demo dir → its repo's .env (provider=${a.provider})`);
    check(a.elevenLabsKey === "set", `demo dir → secret visible (elevenLabsKey=${a.elevenLabsKey})`);
    const b = await tts(projB);
    check(b.provider === "openai", `repo without .env → values restored (provider=${b.provider})`);
    check(b.elevenLabsKey === undefined, "repo without .env → no leaked key");
    check(
      stderr().includes(`env: loaded ${join(projA, ".env")}`),
      "env notice written to stderr (stdout stays JSON-RPC)"
    );
  });
} catch (err) {
  failures++;
  console.error(`  FAIL: ${err?.stack ?? err}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\nmcp-env: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nmcp-env: all checks passed");

// The stdio entry (`aidemo mcp`): it serves 2025-era clients (the `initialize`
// handshake deployed clients speak, at every protocol version they may ask
// for) and 2026-07-28 clients, and it exits once the client goes away.
// Spawns the real server; no Chrome needed.
//
//   npx tsx --test test/mcp-stdio.mjs      (part of `npm test`)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "aidemo.mjs");
const FIXTURE = join(ROOT, "examples", "local-demo");

async function connect(versionNegotiation) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp"],
    env: { ...process.env },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "mcp-stdio-test", version: "0.0.0" },
    versionNegotiation ? { versionNegotiation } : {}
  );
  await client.connect(transport);
  return client;
}

const ERAS = [
  ["a 2025-era client (initialize handshake)", undefined, "legacy", "2025-11-25"],
  ["a 2026-07-28 client", { mode: { pin: "2026-07-28" } }, "modern", "2026-07-28"],
  ["a client that probes for the era", { mode: "auto" }, "modern", "2026-07-28"],
];

for (const [label, negotiation, era, version] of ERAS) {
  test(`serves ${label}`, async () => {
    const client = await connect(negotiation);
    try {
      assert.equal(client.getProtocolEra(), era);
      assert.equal(client.getNegotiatedProtocolVersion(), version);
      assert.equal(client.getServerVersion()?.name, "aidemo");
      assert.match(client.getInstructions() ?? "", /get_authoring_guide/);
      const { tools } = await client.listTools();
      assert.ok(tools.length >= 20, `expected the full tool surface, got ${tools.length}`);
      const r = await client.callTool({ name: "validate_storyboard", arguments: { dir: FIXTURE } });
      assert.equal(r.isError ?? false, false, JSON.stringify(r.content));
      assert.equal(r.structuredContent.valid, true);
      const { resources } = await client.listResources();
      assert.deepEqual(resources.map((x) => x.uri).sort(), ["aidemo://authoring-guide", "aidemo://storyboard-schema"]);
    } finally {
      await client.close();
    }
  });
}

/** Raw JSON-RPC: initialize at `version`, return the reply, then close stdin and time the exit. */
async function initializeRaw(version) {
  const child = spawn(process.execPath, [BIN, "mcp"], { stdio: ["pipe", "pipe", "ignore"] });
  const exited = once(child, "exit");
  let buf = "";
  const reply = new Promise((resolveReply, reject) => {
    child.stdout.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolveReply(JSON.parse(buf.slice(0, nl)));
    });
    exited.then(([code]) => reject(new Error(`server exited (${code}) before replying`)));
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    }) + "\n"
  );
  const message = await reply;
  const closedAt = Date.now();
  child.stdin.end();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code, signal] = await exited;
  clearTimeout(timeout);
  return { message, code, signal, exitMs: Date.now() - closedAt };
}

test("answers every older protocol version a deployed client may request, and exits on stdin EOF", async () => {
  for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
    const { message, code, signal, exitMs } = await initializeRaw(version);
    assert.equal(message.result?.protocolVersion, version, JSON.stringify(message));
    assert.equal(message.result?.serverInfo?.name, "aidemo");
    assert.deepEqual(Object.keys(message.result?.capabilities ?? {}).sort(), ["resources", "tools"]);
    assert.equal(signal, null, `${version}: killed — the server did not exit on stdin EOF`);
    assert.equal(code, 0, version);
    assert.ok(exitMs < 5_000, `${version}: took ${exitMs}ms to exit`);
  }
});

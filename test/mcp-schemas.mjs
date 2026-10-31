// MCP tool input schemas: every object a tool accepts advertises
// `additionalProperties: false` (as under zod 3), while the server still
// ignores — not rejects — an unknown argument. In-process (InMemoryTransport):
// no Chrome, no child process.
//
//   npx tsx --test test/mcp-schemas.mjs      (part of `npm test`)
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/server.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let client;
let server;

before(async () => {
  ({ server } = buildMcpServer());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "mcp-schemas-test", version: "0.0.0" });
  await client.connect(clientSide);
});

after(async () => {
  await client?.close();
  await server?.close();
});

/** Paths of object schemas (with properties) that leave additionalProperties open. */
function openObjects(node, path, out) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "object" && node.properties && Object.keys(node.properties).length) {
    if (node.additionalProperties !== false) out.push(path || "/");
  }
  for (const [key, child] of Object.entries(node)) openObjects(child, `${path}/${key}`, out);
  return out;
}

test("every tool input schema is closed, nested objects included", async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 20, `expected the full tool surface, got ${tools.length}`);
  const open = tools.flatMap((t) => openObjects(t.inputSchema, "", []).map((p) => `${t.name}${p}`));
  assert.deepEqual(open, []);
  // Nested objects are covered, not just the top level.
  const probe = tools.find((t) => t.name === "probe");
  assert.equal(probe.inputSchema.properties.cookies.items.additionalProperties, false);
});

test("an unknown argument is still ignored, not rejected", async () => {
  const r = await client.callTool({
    name: "validate_storyboard",
    arguments: { dir: join(ROOT, "examples", "local-demo"), notARealArgument: true },
  });
  assert.equal(r.isError ?? false, false, JSON.stringify(r.content));
  assert.equal(r.structuredContent.valid, true);
});

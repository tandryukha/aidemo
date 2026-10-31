#!/usr/bin/env node
// MCP handshake against the container image that directories (e.g. Glama)
// build from the Dockerfile: initialize + tools/list over `docker run -i`.
// Dependency-free, so CI can run it without `npm ci`.
//
//   docker build -t aidemo-mcp . && node test/mcp-image.mjs aidemo-mcp [timeout-ms]
import { spawn } from "node:child_process";

const image = process.argv[2] ?? "aidemo-mcp";
const timeoutMs = Number(process.argv[3] ?? 120_000);
const child = spawn("docker", ["run", "-i", "--rm", image], { stdio: ["pipe", "pipe", "inherit"] });
const replies = new Map();
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id != null) replies.set(message.id, message);
  }
});

const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
const reply = (id, ms = timeoutMs) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (replies.has(id)) return resolve(replies.get(id));
      if (child.exitCode != null) return reject(new Error(`container exited (${child.exitCode}) before answering request ${id}`));
      if (Date.now() - started > ms) return reject(new Error(`no answer to request ${id} within ${ms} ms`));
      setTimeout(poll, 50);
    };
    poll();
  });

let failed = false;
try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "image-check", version: "0" } },
  });
  const init = await reply(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await reply(2);
  const tools = list.result?.tools?.length ?? 0;
  const info = init.result?.serverInfo;
  console.log(`${image}: ${info?.name} ${info?.version}, protocol ${init.result?.protocolVersion}, ${tools} tools`);
  if (info?.name !== "aidemo" || tools < 20) {
    console.error(`unexpected answer:\n${JSON.stringify({ init, list }).slice(0, 2000)}`);
    failed = true;
  }
} catch (err) {
  console.error(err.message);
  failed = true;
} finally {
  child.stdin.end();
  // A container that never answered may still be reading stdin: stop it
  // (docker run proxies the signal; --rm removes the container).
  if (failed) child.kill("SIGTERM");
}
process.exitCode = failed ? 1 : 0;

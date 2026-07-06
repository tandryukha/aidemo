#!/usr/bin/env node
// Minimal static server for the smoke-test fixture. Serves ./site on a port.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "site");
const port = Number(process.env.PORT) || 8787;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];
    const file = join(root, url === "/" ? "index.html" : url);
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => console.log(`fixture on http://localhost:${port}`));

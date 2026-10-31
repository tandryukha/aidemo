#!/usr/bin/env node
// Thin launcher so `aidemo` runs the TypeScript CLI via tsx without a build step.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Fail fast on an unsupported Node with the fix, instead of an arbitrary crash
// deep inside a dependency (openai 7 needs Node 22, commander 15 22.12). Node
// 20 reached end-of-life on 2026-04-30. Keep in sync with package.json
// "engines" and the doctor check (src/distribute.ts).
const MIN_NODE = [22, 12];
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < MIN_NODE[0] || (nodeMajor === MIN_NODE[0] && nodeMinor < MIN_NODE[1])) {
  console.error(
    `aidemo: Node.js ${MIN_NODE.join(".")}+ is required (found ${process.version}). ` +
      `Install Node ${MIN_NODE[0]} LTS or newer (nvm install ${MIN_NODE[0]}; in CI, ` +
      `actions/setup-node with node-version: ${MIN_NODE[0]}) and re-run.`
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "src", "cli.ts");
const require = createRequire(import.meta.url);

/**
 * Resolve tsx's CLI entry via Node's module resolution so it works both from a
 * local checkout (tsx under the repo's node_modules) AND from a hoisted
 * `npx github:tandryukha/aidemo@stable` install, where npm lifts tsx into a
 * parent node_modules that `<pkg>/node_modules/.bin/tsx` would miss.
 */
function findTsxBin() {
  try {
    // Walk up from tsx's resolved entry to its package.json, then read its bin.
    let dir = dirname(require.resolve("tsx"));
    for (let i = 0; i < 6 && dir !== dirname(dir); i++) {
      const pj = resolve(dir, "package.json");
      if (existsSync(pj)) {
        const pkg = require(pj);
        if (pkg.name === "tsx" && pkg.bin) {
          const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.tsx;
          if (binRel) return resolve(dir, binRel);
        }
      }
      dir = dirname(dir);
    }
  } catch {
    /* fall through to the local .bin guess */
  }
  const local = resolve(here, "..", "node_modules", ".bin", "tsx");
  return existsSync(local) ? local : null;
}

const tsxBin = findTsxBin();
if (!tsxBin) {
  console.error(
    "aidemo: could not locate the 'tsx' runtime. Run `npm install` in the engine, " +
      "or invoke via `npx -y github:tandryukha/aidemo@stable <cmd>`."
  );
  process.exit(1);
}

const res = spawnSync(process.execPath, [tsxBin, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);

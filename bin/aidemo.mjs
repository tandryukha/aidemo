#!/usr/bin/env node
// Thin launcher so `aidemo` runs the TypeScript CLI via tsx without a build step.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "src", "cli.ts");
const require = createRequire(import.meta.url);

/**
 * Resolve tsx's CLI entry via Node's module resolution so it works both from a
 * local checkout (tsx under the repo's node_modules) AND from a hoisted
 * `npx github:tandryukha/demo-engine@stable` install, where npm lifts tsx into a
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
      "or invoke via `npx -y github:tandryukha/demo-engine@stable <cmd>`."
  );
  process.exit(1);
}

const res = spawnSync(process.execPath, [tsxBin, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);

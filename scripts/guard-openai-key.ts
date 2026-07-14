#!/usr/bin/env -S npx tsx
/**
 * scripts/guard-openai-key.ts — fail if any OpenAI-calling code path bypasses the
 * sanctioned loader (src/config.ts: loadEnv() + requireOpenAiKey()).
 *
 * Sanctioned readers of `process.env.OPENAI_API_KEY` / OPENAI_API_KEY text:
 *   - src/config.ts        — the loader itself (loadEnv/readEnvFile) and the sole
 *                             requireOpenAiKey() that every OpenAI-calling module
 *                             (src/voice.ts, src/captions.ts) must go through.
 *   - src/distribute.ts    — `aidemo doctor`'s presence-only status check
 *                             ("set"/"missing"), never used to make an API call.
 *   - docs/examples/action.yml/.env.example — documentation, not code paths.
 *
 * Exit 0 + prints the resolved key's last 4 chars = clean.
 * Exit 1 + lists offending files                   = something bypasses the loader.
 *
 * Usage: npx tsx scripts/guard-openai-key.ts   (also `npm run guard-openai-key`)
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { loadEnv, ENGINE_ROOT } from "../src/config.js";

const REPO_ROOT = ENGINE_ROOT; // this guard only ever runs against the engine's own checkout

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  "chrome-profile",
  "dist",
  "build",
  ".next",
]);

// Files permitted to reference OPENAI_API_KEY / api.openai.com directly.
const ALLOWLIST = new Set([
  "scripts/guard-openai-key.ts",
  "src/config.ts",
  "src/distribute.ts",
]);

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".html", ".yml", ".yaml", ".txt"]);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), out);
    } else {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log("== Guard: OpenAI key loader compliance (demo-engine) ==");

  const allFiles = await walk(REPO_ROOT);
  const violations: string[] = [];

  for (const abs of allFiles) {
    const rel = relative(REPO_ROOT, abs);
    if (ALLOWLIST.has(rel)) continue;
    const ext = rel.slice(rel.lastIndexOf("."));
    // Only scan actual code files for bypasses. Doc/example/config files are
    // expected to mention OPENAI_API_KEY generically (this is a public CLI/Action
    // whose consumers bring their own key) — that's not a bypass of the loader.
    if (!CODE_EXTENSIONS.has(ext)) continue;
    if (DOC_EXTENSIONS.has(ext)) continue;

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (/process\.env\.OPENAI_API_KEY/.test(content) || /OPENAI_API_KEY/.test(content)) {
      violations.push(rel);
    }
  }

  // Targeted regression check for the actual historical bug: readEnvFile()/loadEnv()
  // silently skipping a key that's already in process.env (the dotenv/load_dotenv
  // "ambient wins" default). If this pattern ever comes back, an already-exported
  // ambient OPENAI_API_KEY (e.g. shared across repos via ~/.zshrc) would again
  // silently win over this repo's own .env.
  const configSrc = await readFile(resolve(REPO_ROOT, "src/config.ts"), "utf8");
  const AMBIENT_WINS_PATTERN = /if\s*\(\s*!\s*\(\s*key\s+in\s+process\.env\s*\)\s*\)/;
  if (AMBIENT_WINS_PATTERN.test(configSrc)) {
    violations.push(
      "src/config.ts (env loader skips keys already in process.env — ambient shell env would silently win over the repo's own .env; loadEnv()/readEnvFile() must always override)"
    );
  }

  if (violations.length > 0) {
    console.error("FAIL: files bypass the OPENAI_API_KEY loader (requireOpenAiKey() in src/config.ts):");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }

  // Resolve the key the same way the CLI does, and print only its last 4 chars.
  await loadEnv();
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error(`FAIL: OPENAI_API_KEY not resolvable from ${resolve(REPO_ROOT, ".env")} (or cwd .env)`);
    process.exit(1);
  }
  console.log(`PASS: no loader bypass found. Resolved OPENAI_API_KEY ends in: ...${key.slice(-4)}`);
}

main().catch((err) => {
  console.error("Guard crashed:", err);
  process.exit(1);
});

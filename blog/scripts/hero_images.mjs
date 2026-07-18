#!/usr/bin/env node
/**
 * hero_images.mjs — generate matte-clay hero images for blog articles.
 *
 * Usage:
 *   node blog/scripts/hero_images.mjs [--force] [--only slug1,slug2] [--dry-run]
 *
 * Reads blog/data/articles/*.json + blog/data/hero-subjects.json (the per-slug
 * subject map — ONE physical object metaphor per article), renders each subject
 * in the locked aidemo house style with the local SDXL-Lightning backend, and
 * post-processes to the two WebP sizes bake.mjs consumes:
 *
 *   blog/public/images/{slug}-800.webp   (800px wide — article hero + og:image)
 *   blog/public/images/{slug}-400.webp   (400px wide — card srcset)
 *
 * Size: generated at 1216x832 — a native SDXL landscape bucket that exactly
 * matches the article-hero aspect ratio bake.mjs hardcodes (<img width="1216"
 * height="832">). Downscales keep the ratio (800x547, 400x274).
 *
 * Determinism: seed = fnv1a(slug) + seedOffset (seedOffset lives in
 * hero-subjects.json, default 0 — bump it there to re-roll a single image and
 * keep the re-roll reproducible). Re-runs skip slugs whose two webp files
 * already exist unless --force (or --only limits the run).
 *
 * Requirements (local machine, not CI):
 *   - the SDXL venv:  ~/.venvs/sdxl/bin/python  (see sdxl_backend.py header)
 *   - the backend:    ~/dropshipping-irondust/scripts/blog/sdxl_backend.py
 *   - cwebp on PATH (brew install webp) — this ffmpeg build lacks libwebp
 *
 * The backend's --jobs batch mode loads the model once and renders jobs
 * SEQUENTIALLY (one GPU job at a time — Metal contention), using our per-job
 * `prompt`/`negative` VERBATIM (its built-in food-photography realism prompt
 * is only used when a job omits `prompt`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BLOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTICLES_DIR = path.join(BLOG_DIR, 'data', 'articles');
const SUBJECTS_PATH = path.join(BLOG_DIR, 'data', 'hero-subjects.json');
const IMAGES_DIR = path.join(BLOG_DIR, 'public', 'images');

const PYTHON = path.join(os.homedir(), '.venvs', 'sdxl', 'bin', 'python');
const BACKEND = path.join(os.homedir(), 'dropshipping-irondust', 'scripts', 'blog', 'sdxl_backend.py');

// The locked aidemo house style (matches the landing page). Keep the whole
// prompt under CLIP's 77 tokens: subjects must stay <= ~12 words.
const STYLE = (subject) =>
  `minimalist matte clay 3D scene of ${subject}, soft rounded shapes, ` +
  'smooth studio render, plain dark charcoal background, coral orange and ' +
  'violet purple rim lighting, gentle top light, soft shadows, high detail, ' +
  'wide cinematic composition';
const NEGATIVE =
  'text, words, letters, numbers, logos, labels, screens, user interface, ' +
  'watermark, person, face, hands, photo, photorealistic, blurry, low quality, deformed';

const WIDTH = 1216; // native SDXL landscape bucket == bake.mjs hero aspect
const HEIGHT = 832;
const WEBP_QUALITY = 85;

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 && args[onlyIdx + 1]
  ? new Set(args[onlyIdx + 1].split(',').map((s) => s.trim()).filter(Boolean))
  : null;

/** FNV-1a 32-bit — stable, dependency-free slug hash for deterministic seeds. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function seedFor(slug, seedOffset = 0) {
  return ((fnv1a(slug) + seedOffset) >>> 0) % 2147483647;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function have(cmd) {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

// ---------------------------------------------------------------------------
if (!fs.existsSync(SUBJECTS_PATH)) die(`missing ${SUBJECTS_PATH}`);
if (!dryRun) {
  if (!fs.existsSync(PYTHON)) die(`missing SDXL venv python: ${PYTHON}`);
  if (!fs.existsSync(BACKEND)) die(`missing backend: ${BACKEND}`);
  if (!have('cwebp')) die('cwebp not on PATH — brew install webp');
}

const subjects = JSON.parse(fs.readFileSync(SUBJECTS_PATH, 'utf8'));
const slugs = fs.readdirSync(ARTICLES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

const considered = slugs.filter((s) => !only || only.has(s));
const missing = considered.filter((s) => !subjects[s]?.subject);
if (missing.length) die(`no subject in hero-subjects.json for: ${missing.join(', ')}`);

const jobs = [];
const skipped = [];
for (const slug of slugs) {
  if (only && !only.has(slug)) continue;
  const done = fs.existsSync(path.join(IMAGES_DIR, `${slug}-800.webp`))
    && fs.existsSync(path.join(IMAGES_DIR, `${slug}-400.webp`));
  if (done && !force) { skipped.push(slug); continue; }
  const { subject, seedOffset = 0 } = subjects[slug];
  jobs.push({
    slug,
    prompt: STYLE(subject),
    negative: NEGATIVE,
    seed: seedFor(slug, seedOffset),
    width: WIDTH,
    height: HEIGHT,
  });
}

if (skipped.length) console.log(`skipping ${skipped.length} slug(s) with existing webp files (use --force to redo)`);
if (!jobs.length) { console.log('nothing to generate'); process.exit(0); }

console.log(`generating ${jobs.length} hero image(s) at ${WIDTH}x${HEIGHT}:`);
for (const j of jobs) console.log(`  ${j.slug}  seed=${j.seed}`);
if (dryRun) process.exit(0);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-images-'));
const jobsPath = path.join(tmpDir, 'jobs.jsonl');
fs.writeFileSync(jobsPath, jobs.map((j) => JSON.stringify({
  prompt: j.prompt,
  negative: j.negative,
  out: path.join(tmpDir, `${j.slug}.png`),
  seed: j.seed,
  width: j.width,
  height: j.height,
})).join('\n') + '\n');

// One backend process for the whole batch: model loads once, jobs render
// sequentially inside it (never run two of these in parallel — Metal).
const res = spawnSync(PYTHON, [BACKEND, '--jobs', jobsPath, '--fast'], {
  stdio: 'inherit',
  env: { ...process.env, HF_HUB_DOWNLOAD_TIMEOUT: '20' },
});
if (res.status !== 0) die(`backend exited with status ${res.status}`);

fs.mkdirSync(IMAGES_DIR, { recursive: true });
let ok = 0;
for (const j of jobs) {
  const png = path.join(tmpDir, `${j.slug}.png`);
  if (!fs.existsSync(png) || fs.statSync(png).size === 0) {
    console.error(`  FAIL ${j.slug}: backend produced no image`);
    continue;
  }
  for (const w of [800, 400]) {
    execFileSync('cwebp', ['-quiet', '-q', String(WEBP_QUALITY), '-resize', String(w), '0',
      png, '-o', path.join(IMAGES_DIR, `${j.slug}-${w}.webp`)]);
  }
  ok++;
  console.log(`  ${j.slug} -> ${j.slug}-800.webp + ${j.slug}-400.webp`);
}
console.log(`done: ${ok}/${jobs.length} hero(s) written to ${IMAGES_DIR}`);
console.log('next: review the images, then cd blog && node scripts/bake.mjs');
process.exit(ok === jobs.length ? 0 : 1);

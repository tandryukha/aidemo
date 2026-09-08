import { promises as fs } from "node:fs";
import type { Project } from "./project.js";
import {
  ProbeGoldenSchema,
  type ProbeGolden,
  type ProbeGoldenScene,
  type Storyboard,
} from "./types.js";
import { writeJson, exists } from "./util.js";
import { join } from "node:path";

/**
 * Golden probe/timeline diffing — a demo doubles as a regression test (vhs's
 * golden-file pattern). `aidemo probe --update-golden` writes a NORMALIZED,
 * deterministic projection of a probe run to golden/probe.json; `--golden`
 * re-runs the probe, normalizes, and deep-compares. The projection is
 * timing-free by construction (see ProbeActionOutcome — only op, resolved
 * target, ok, found, and goto final URL), so it is stable across runs and a
 * mismatch means a real change in the flow (a moved/renamed selector, a broken
 * navigation), not clock jitter.
 */

/** Assemble the normalized golden from the storyboard + per-scene outcomes. */
export function buildProbeGolden(
  storyboard: Storyboard,
  scenes: ProbeGoldenScene[]
): ProbeGolden {
  // Parse so the committed baseline and the freshly-built comparison are shaped
  // identically (defaults applied, stray fields stripped) — the diff then only
  // reflects genuine outcome drift.
  return ProbeGoldenSchema.parse({
    version: 1,
    title: storyboard.title,
    video: storyboard.video,
    scenes,
  });
}

export async function writeProbeGolden(
  project: Project,
  golden: ProbeGolden
): Promise<void> {
  await writeJson(project.goldenProbePath, golden);
}

/** Read + validate the committed baseline. Null when it doesn't exist yet. */
export async function readProbeGolden(
  project: Project
): Promise<ProbeGolden | null> {
  if (!(await exists(project.goldenProbePath))) return null;
  const raw = JSON.parse(await fs.readFile(project.goldenProbePath, "utf8"));
  return ProbeGoldenSchema.parse(raw);
}

/**
 * A readable, field-level deep diff: each line is `path: expected X, got Y`
 * (e.g. `$.scenes[2].actions[0].ok: expected true, got false`). Empty array =
 * identical. Treats a missing key and an `undefined` value as equal so an
 * omitted optional field never shows as a spurious diff.
 */
export function diffGolden(
  expected: unknown,
  actual: unknown,
  path = "$"
): string[] {
  if (isScalar(expected) || isScalar(actual)) {
    return valuesEqual(expected, actual)
      ? []
      : [`${path}: expected ${fmt(expected)}, got ${fmt(actual)}`];
  }
  const diffs: string[] = [];
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const ea = Array.isArray(expected) ? expected : [];
    const aa = Array.isArray(actual) ? actual : [];
    if (ea.length !== aa.length) {
      diffs.push(`${path}.length: expected ${ea.length}, got ${aa.length}`);
    }
    const n = Math.max(ea.length, aa.length);
    for (let i = 0; i < n; i++) {
      diffs.push(...diffGolden(ea[i], aa[i], `${path}[${i}]`));
    }
    return diffs;
  }
  const eo = (expected ?? {}) as Record<string, unknown>;
  const ao = (actual ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(eo), ...Object.keys(ao)])].sort();
  for (const k of keys) {
    diffs.push(...diffGolden(eo[k], ao[k], `${path}.${k}`));
  }
  return diffs;
}

function isScalar(v: unknown): boolean {
  return (
    v == null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

function valuesEqual(a: unknown, b: unknown): boolean {
  // Missing key vs explicit undefined/null read the same here.
  if (a == null && b == null) return true;
  return Object.is(a, b);
}

function fmt(v: unknown): string {
  return v === undefined ? "(absent)" : JSON.stringify(v);
}

/**
 * For a golden diff, the drift-suggestion files the probe just wrote for the
 * actions whose `ok`/`found` flipped (`logs/drift-<scene>-<n>.json`, see
 * player diagnostics) — so the fix is one edit away. Only existing files.
 */
export async function driftFilesForDiff(
  project: Project,
  golden: ProbeGolden,
  diffs: string[]
): Promise<Array<{ scene: string; action: number; file: string }>> {
  const out: Array<{ scene: string; action: number; file: string }> = [];
  const seen = new Set<string>();
  for (const d of diffs) {
    const m = /^\$\.scenes\[(\d+)\]\.actions\[(\d+)\]\.(ok|found):/.exec(d);
    if (!m) continue;
    const scene = golden.scenes[Number(m[1])];
    if (!scene) continue;
    const action = Number(m[2]);
    const file = join(project.dir, "logs", `drift-${scene.id}-${action + 1}.json`);
    if (seen.has(file) || !(await exists(file))) continue;
    seen.add(file);
    out.push({ scene: scene.id, action: action + 1, file });
  }
  return out;
}

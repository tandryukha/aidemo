import { resolve } from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { Project } from "./project.js";
import { generateVoice } from "./voice.js";
import { record, type RecordOptions } from "./recorder.js";
import { generateCaptions, generateCaptionsOffline } from "./captions.js";
import { compose } from "./compose.js";
import { captionsAutoOffline } from "./config.js";
import { readJson, log, ok, step } from "./util.js";

/**
 * Personalized demo variants — one storyboard, N per-prospect/segment renders.
 *
 * `aidemo render <dir> --variants variants.json` where variants.json is:
 *   [ { "name": "acme", "params": { "customer": "Acme" } }, ... ]
 *
 * Each variant renders as an ISOLATED project under
 * <dir>/output/variants/<name>/ — it seeds its own copy of the storyboard and
 * runs the full pipeline (voice → record → captions → compose) with its params,
 * so a param that changes narration/urls/typed text produces a genuinely
 * different take. Sequential and simple; voice hashing dedupes unchanged scenes
 * within a variant.
 */

const VariantSchema = z.object({
  name: z
    .string()
    .regex(
      /^[A-Za-z0-9._-]+$/,
      "variant name must be a filesystem-safe dir name (A-Z a-z 0-9 . _ -)"
    ),
  params: z.record(z.string(), z.string()).default({}),
});
export type Variant = z.infer<typeof VariantSchema>;

const VariantsFileSchema = z.array(VariantSchema).min(1);

/** Read + validate a variants matrix file. */
export async function loadVariants(path: string): Promise<Variant[]> {
  const abs = resolve(path);
  const raw = await readJson<unknown>(abs);
  const parsed = VariantsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid variants file ${abs}:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n")}\nExpected: [{ "name": "acme", "params": { "k": "v" } }, ...]`
    );
  }
  const seen = new Set<string>();
  for (const v of parsed.data) {
    if (seen.has(v.name)) {
      throw new Error(`duplicate variant name "${v.name}" in ${abs}`);
    }
    seen.add(v.name);
  }
  return parsed.data;
}

export interface RenderVariantsOptions {
  /** Chrome record options shared by every variant. */
  record?: Pick<RecordOptions, "profileDir" | "headed" | "capture">;
  /** Re-synthesize narration even if unchanged. */
  forceVoice?: boolean;
}

export interface VariantResult {
  name: string;
  dir: string;
  output: string;
  params: Record<string, string>;
}

/**
 * Render every variant. NOTE: a variant renders relative to its own isolated
 * dir, so storyboards that reference LOCAL asset paths (e.g. a music `track`)
 * should use absolute paths — relative ones resolve against the variant dir.
 */
export async function renderVariants(
  parentDir: string,
  variants: Variant[],
  opts: RenderVariantsOptions = {}
): Promise<VariantResult[]> {
  const parent = new Project(parentDir);
  const storyboardRaw = await fs.readFile(parent.storyboardPath, "utf8");

  const results: VariantResult[] = [];
  for (const [i, v] of variants.entries()) {
    step(`Variant ${i + 1}/${variants.length}: "${v.name}"`);
    const variantDir = parent.p("output", "variants", v.name);
    const project = new Project(variantDir);
    await project.ensureDirs();
    // Seed the storyboard so the variant is a fully self-contained project.
    await fs.writeFile(project.storyboardPath, storyboardRaw);

    // Explicit variant params win (and are typo-guarded) + get persisted.
    const storyboard = await project.loadStoryboard({ params: v.params });
    await generateVoice(project, storyboard, { force: opts.forceVoice });
    await record(project, storyboard, { ...(opts.record ?? {}) });
    if (captionsAutoOffline()) {
      log("local TTS and no STT endpoint/key — deriving captions offline");
      await generateCaptionsOffline(project, storyboard);
    } else {
      await generateCaptions(project, storyboard);
    }
    await compose(project, storyboard);
    ok(`variant "${v.name}" → ${project.outputPath}`);
    results.push({
      name: v.name,
      dir: variantDir,
      output: project.outputPath,
      params: v.params,
    });
  }
  return results;
}

/**
 * Always-fresh embeds at zero cost — pure snippet generation (no network, no
 * render). The hosting story is GitHub itself: CI publishes rendered media to a
 * dedicated orphan branch `demo-media` in the CONSUMING repo, at stable paths
 * `media/<demo>/latest.mp4|latest.gif|stills/<name>.png`. The raw URLs below
 * never change, so a README/blog/docs embed updates itself whenever CI
 * re-renders. See docs/EMBEDS.md for the recipe + cache caveats and
 * examples/workflows/demo-publish.yml for the publish workflow.
 *
 * This module only does string generation: it reads the repo's `origin` remote
 * to derive owner/repo and takes the demo name from the directory. It never
 * hits the network beyond the local `git` invocation, and never renders.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, isAbsolute, basename } from "node:path";
import { exists } from "./util.js";
import { UPSTREAM_REPO } from "./distribute.js";

const execFileAsync = promisify(execFile);

/** The dedicated orphan branch CI force-resets on each publish. */
export const DEMO_MEDIA_BRANCH = "demo-media";
/** Where the publish workflow lives inside a consuming repo. */
export const PUBLISH_WORKFLOW_REL = ".github/workflows/demo-publish.yml";
/** Copy-pasteable pointer to the workflow template in the engine repo. */
export const PUBLISH_WORKFLOW_TEMPLATE = `https://github.com/${UPSTREAM_REPO}/blob/stable/examples/workflows/demo-publish.yml`;

export interface EmbedOptions {
  /** Consuming-repo dir to detect owner/repo from. Default: process.cwd(). */
  repoDir?: string;
  /** Still-frame basename under stills/ (no extension). Default: "poster". */
  still?: string;
}

export interface EmbedResult {
  owner: string;
  repo: string;
  /** Demo name = basename of the demo directory. */
  demo: string;
  branch: string;
  still: string;
  urls: {
    /** raw.githubusercontent GIF — embeds in READMEs, comments, most sites. */
    gif: string;
    /** raw.githubusercontent MP4 — serves as application/octet-stream (see docs). */
    mp4: string;
    /** raw.githubusercontent still PNG. */
    still: string;
    /** GitHub Pages MP4 (correct video/mp4 MIME for <video>) — needs Pages on the branch. */
    pagesMp4: string;
    /** GitHub Pages project-site base. */
    pagesBase: string;
  };
  snippets: {
    /** Markdown animated-GIF embed — for READMEs, issues, PR comments. */
    markdownGif: string;
    /** Markdown still-image embed. */
    markdownStill: string;
    /** HTML <video> (docs sites / blogs) using the Pages MP4 URL. */
    htmlVideo: string;
  };
  workflow: {
    /** Path the publish workflow lives at inside the consuming repo. */
    path: string;
    /** Whether that file is already present. */
    present: boolean;
    /** Pointer to the template to copy if it isn't. */
    template: string;
  };
}

/**
 * Parse an owner/repo slug out of a GitHub remote URL. Handles the common
 * forms: scp-like `git@github.com:owner/repo.git`, `https://github.com/owner/repo(.git)`,
 * and `ssh://git@github.com/owner/repo.git`. Returns null for non-github hosts.
 */
export function parseGitHubSlug(
  remoteUrl: string
): { owner: string; repo: string } | null {
  const s = remoteUrl.trim().replace(/\/+$/, "");
  const scp = s.match(/^[^@]+@([^:]+):(?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/);
  const url = s.match(
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/
  );
  const host = scp ? scp[1] : url?.groups?.host;
  const m = scp ?? url;
  if (!m?.groups || !host || !/(^|\.)github\.com$/i.test(host)) return null;
  return { owner: m.groups.owner, repo: m.groups.repo };
}

async function detectSlug(
  repoDir: string
): Promise<{ owner: string; repo: string }> {
  let url: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoDir, "remote", "get-url", "origin"],
      { timeout: 5000 }
    );
    url = stdout.trim();
  } catch {
    throw new Error(
      `could not read the 'origin' remote in ${repoDir} — run \`aidemo embed\` ` +
        `inside the consuming repo, or pass --repo <dir>`
    );
  }
  const slug = parseGitHubSlug(url);
  if (!slug) {
    throw new Error(
      `origin remote is not a github.com repo (${url || "empty"}) — always-fresh ` +
        `embeds use raw.githubusercontent.com URLs, which need a GitHub-hosted repo`
    );
  }
  return slug;
}

/**
 * Build the stable embed URLs + ready-to-paste snippets for one demo. Pure:
 * the only side effect is reading git config + checking whether the publish
 * workflow file exists.
 */
export async function buildEmbed(
  dir: string,
  opts: EmbedOptions = {}
): Promise<EmbedResult> {
  const demoDir = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  const demo = basename(demoDir);
  const repoDir = opts.repoDir
    ? resolve(process.cwd(), opts.repoDir)
    : process.cwd();
  const { owner, repo } = await detectSlug(repoDir);
  const still = (opts.still ?? "poster").replace(/\.png$/i, "");

  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${DEMO_MEDIA_BRANCH}/media/${demo}`;
  const gif = `${rawBase}/latest.gif`;
  const mp4 = `${rawBase}/latest.mp4`;
  const stillUrl = `${rawBase}/stills/${still}.png`;
  // GitHub Pages project-site host is the lowercased owner login.
  const pagesBase = `https://${owner.toLowerCase()}.github.io/${repo}`;
  const pagesMp4 = `${pagesBase}/media/${demo}/latest.mp4`;

  const markdownGif = `![${demo} demo](${gif})`;
  const markdownStill = `![${demo}](${stillUrl})`;
  const htmlVideo =
    `<video controls muted loop playsinline width="960" poster="${stillUrl}">\n` +
    `  <source src="${pagesMp4}" type="video/mp4" />\n` +
    `  <a href="${gif}">▶ Watch the ${demo} demo</a>\n` +
    `</video>`;

  const workflowPath = resolve(repoDir, PUBLISH_WORKFLOW_REL);
  const present = await exists(workflowPath);

  return {
    owner,
    repo,
    demo,
    branch: DEMO_MEDIA_BRANCH,
    still,
    urls: { gif, mp4, still: stillUrl, pagesMp4, pagesBase },
    snippets: { markdownGif, markdownStill, htmlVideo },
    workflow: {
      path: PUBLISH_WORKFLOW_REL,
      present,
      template: PUBLISH_WORKFLOW_TEMPLATE,
    },
  };
}

/** Human-readable, copy-paste-friendly rendering of the snippets (stdout). */
export function formatEmbed(r: EmbedResult): string {
  const out: string[] = [];
  out.push(`# Always-fresh embeds — ${r.owner}/${r.repo}, demo "${r.demo}"`);
  out.push(
    `# Media publishes to the '${r.branch}' branch; these URLs never change,`
  );
  out.push(`# so the embed updates itself whenever CI re-renders.`);
  out.push("");
  out.push("## Markdown — animated GIF (READMEs, issues, PR comments)");
  out.push(r.snippets.markdownGif);
  out.push("");
  out.push("## Markdown — still image (poster)");
  out.push(r.snippets.markdownStill);
  out.push("");
  out.push(
    "## HTML — <video> (docs sites / blogs; needs GitHub Pages on the branch for correct mp4 MIME)"
  );
  out.push(r.snippets.htmlVideo);
  out.push("");
  if (r.workflow.present) {
    out.push(
      `# ✓ ${r.workflow.path} present — CI keeps these URLs fresh on every render.`
    );
  } else {
    out.push(`# ⚠ ${r.workflow.path} is absent — the URLs won't populate yet.`);
    out.push(`#   Add the publish workflow so CI keeps them fresh:`);
    out.push(`#   ${r.workflow.template}`);
  }
  out.push(`# Recipe + cache caveats: docs/EMBEDS.md`);
  return out.join("\n") + "\n";
}

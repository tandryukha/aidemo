/**
 * Topic-scoped slices of docs/AUTHORING.md. The full guide is ~1000 lines;
 * agents usually need one slice (schema, attention, ChatGPT-app facts…).
 * Slicing is by H2 heading so the doc stays the single source of truth —
 * topics are just named sets of H2 prefixes.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ENGINE_ROOT } from "./config.js";

export const GUIDE_TOPICS = {
  core: [
    "Interfaces",
    "Pipeline",
    "Steps",
    "Demo-director principles",
    "Storyboard schema",
    "Action vocabulary",
    "Verify before declaring done",
  ],
  schema: ["Storyboard schema", "Action vocabulary"],
  polish: [
    "Demo-director principles",
    "Transitions, output sizing",
    "Attention",
    "Motion blur & cursor",
    "Produced look",
  ],
  attention: ["Attention", "Motion blur & cursor"],
  "chatgpt-apps": ["ChatGPT Apps SDK recording"],
  stills: ["Stills"],
  variants: ["Parameterized storyboards", "Multi-language renders"],
  captions: ["Captions:", "Multi-language renders"],
  debug: ["Verify before declaring done", "Debugging", "Demo as regression test"],
  ci: ["Demo as regression test", "Interfaces"],
} as const;

export type GuideTopic = keyof typeof GUIDE_TOPICS;
export const GUIDE_TOPIC_NAMES = Object.keys(GUIDE_TOPICS) as GuideTopic[];

export const guidePath = (): string => resolve(ENGINE_ROOT, "docs", "AUTHORING.md");

export async function readGuide(): Promise<string> {
  return readFile(guidePath(), "utf8");
}

interface Section {
  heading: string;
  body: string;
}

/** Split the guide into its H2 sections (the preamble before the first H2 is heading ""). */
export function splitGuide(md: string): Section[] {
  const out: Section[] = [];
  let heading = "";
  let buf: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) inFence = !inFence;
    if (!inFence && /^## /.test(line)) {
      out.push({ heading, body: buf.join("\n") });
      heading = line.slice(3).trim();
      buf = [line];
      continue;
    }
    buf.push(line);
  }
  out.push({ heading, body: buf.join("\n") });
  return out;
}

/** Headings in the doc, in order (for `guide --list`, MCP hints). */
export function guideHeadings(md: string): string[] {
  return splitGuide(md)
    .map((s) => s.heading)
    .filter(Boolean);
}

/**
 * Slice the guide to a topic (or to any H2 whose heading starts with the
 * given text, case-insensitive). Returns the sections in document order
 * plus a one-line pointer to the other topics; unknown topic → null.
 */
export function sliceGuide(md: string, topic: string): string | null {
  const sections = splitGuide(md);
  const key = topic.trim().toLowerCase();
  const prefixes: readonly string[] =
    (GUIDE_TOPICS as Record<string, readonly string[]>)[key] ?? [topic.trim()];
  const picked = sections.filter(
    (s) => s.heading && prefixes.some((p) => s.heading.toLowerCase().startsWith(p.toLowerCase()))
  );
  if (!picked.length) return null;
  const others = GUIDE_TOPIC_NAMES.filter((t) => t !== key).join(", ");
  return (
    `<!-- aidemo authoring guide · topic "${topic}" (${picked.length} section${picked.length === 1 ? "" : "s"}). ` +
    `Other topics: ${others}; omit topic for the full guide. -->\n\n` +
    picked.map((s) => s.body.trimEnd()).join("\n\n") +
    "\n"
  );
}

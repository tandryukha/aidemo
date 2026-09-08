/**
 * `aidemo import-trace`: turn what a Playwright run already knows — a
 * `trace.zip` from `context.tracing` / `npx playwright test --trace on`, or a
 * `*.spec.ts` test file — into a draft storyboard. Actions and selectors come
 * from the trace verbatim (the flow is proven to work), scenes are cut at
 * navigations and async payoffs, narration is left as placeholders. No LLM.
 */

import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ImportedAction {
  op: string;
  [k: string]: unknown;
}
export interface ImportedScene {
  id: string;
  narration: string;
  actions: ImportedAction[];
}
export interface ImportResult {
  source: string;
  kind: "trace" | "test";
  storyboard: Record<string, unknown>;
  /** What was skipped or approximated, for the agent to review. */
  notes: string[];
  steps: number;
}

// ---------------------------------------------------------------------------
// Minimal zip reader (stored + deflate entries) — enough for trace.zip.
// ---------------------------------------------------------------------------

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // End of central directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("zip: bad local header");
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`zip: unsupported compression method ${method} for ${name}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selector normalization: Playwright's internal engines → public selectors the
// storyboard can carry, plus nth/last/frame extraction.
// ---------------------------------------------------------------------------

export interface NormalizedTarget {
  selector: string;
  nth?: number;
  last?: boolean;
  /** Selector of the iframe the target lives in (frameLocator chain). */
  frameSelector?: string;
  note?: string;
}

function unquote(s: string): string {
  const m = /^"((?:[^"\\]|\\.)*)"([is]?)$/.exec(s.trim());
  return m ? m[1].replace(/\\"/g, '"') : s.trim();
}

function publicPart(part: string): { sel: string; note?: string } {
  const t = part.trim();
  let m: RegExpExecArray | null;
  if ((m = /^internal:testid=\[([^=]+)="((?:[^"\\]|\\.)*)"s?\]$/.exec(t))) {
    return { sel: `[${m[1]}="${m[2]}"]` };
  }
  if ((m = /^internal:role=(\w+)(?:\[(.*)\])?$/.exec(t))) {
    return { sel: m[2] ? `role=${m[1]}[${m[2]}]` : `role=${m[1]}` };
  }
  if ((m = /^internal:text=(.*)$/.exec(t))) {
    const exact = /"s$/.test(t);
    return { sel: exact ? `text="${unquote(m[1])}"` : `text=${unquote(m[1])}` };
  }
  if ((m = /^internal:has-text=(.*)$/.exec(t))) {
    return { sel: `:has-text("${unquote(m[1])}")` };
  }
  if (/^internal:label=/.test(t)) {
    // Playwright resolves `internal:label=` in a plain locator string and it
    // lands on the labelled CONTROL (verified against page.locator), which is
    // what getByLabel means — keep it verbatim rather than degrading it to a
    // text match on the label element.
    return { sel: t };
  }
  if ((m = /^internal:attr=\[([^=]+)="((?:[^"\\]|\\.)*)"[is]?\]$/.exec(t))) {
    return { sel: `[${m[1]}="${m[2]}"]` };
  }
  if (/^internal:/.test(t)) {
    return { sel: t, note: `kept Playwright-internal selector "${t}" — verify with aidemo probe` };
  }
  return { sel: t };
}

export function normalizeSelector(raw: string): NormalizedTarget {
  const parts = raw.split(/\s*>>\s*/);
  const out: NormalizedTarget = { selector: "" };
  const keep: string[] = [];
  const notes: string[] = [];
  let frameParts: string[] | null = null;
  for (const part of parts) {
    if (part === "internal:control=enter-frame") {
      // Everything before this point located the iframe.
      frameParts = keep.splice(0, keep.length);
      continue;
    }
    const nth = /^nth=(-?\d+)$/.exec(part);
    if (nth) {
      const n = Number(nth[1]);
      if (n < 0) out.last = true;
      else if (n > 0) out.nth = n;
      continue;
    }
    if (/^internal:control=/.test(part)) continue;
    const { sel, note } = publicPart(part);
    keep.push(sel);
    if (note) notes.push(note);
  }
  // A `:has-text()` part chains onto the previous CSS part; other parts join
  // with Playwright's `>>` which page.locator understands. A `:scope…` part is
  // a filter on the located element, not a suffix — it keeps its own `>>`.
  out.selector = keep.reduce(
    (acc, s) =>
      s.startsWith(":") && !s.startsWith(":scope") ? acc + s : acc ? `${acc} >> ${s}` : s,
    ""
  );
  if (frameParts?.length) out.frameSelector = frameParts.join(" >> ");
  if (notes.length) out.note = notes.join("; ");
  return out;
}

// ---------------------------------------------------------------------------
// Steps → storyboard
// ---------------------------------------------------------------------------

interface Step {
  method: string;
  selector?: string;
  value?: string;
  key?: string;
  url?: string;
  files?: string[];
  ms?: number;
  /** For dragAndDrop. */
  target?: string;
  option?: string;
  urlIsRegex?: boolean;
  valueIsRegex?: boolean;
}

function stepsFromTrace(entries: Map<string, Buffer>, notes: string[]): Step[] {
  const files = [...entries.keys()].filter((n) => n.endsWith(".trace"));
  if (!files.length) throw new Error("no *.trace entry in the zip — is this a Playwright trace.zip?");
  const steps: Step[] = [];
  for (const f of files) {
    const lines = entries.get(f)!.toString("utf8").split("\n");
    // Calls that threw (a failed locator, a caught timeout) are not part of
    // the flow the test proved — drop them by callId.
    const failed = new Set<string>();
    for (const line of lines) {
      if (!line.startsWith('{"type":"after"')) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.error) failed.add(String(ev.callId));
      } catch {
        /* skip */
      }
    }
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type !== "before") continue;
      if (failed.has(String(ev.callId))) {
        notes.push(`dropped ${ev.class}.${ev.method}(${ev.params?.selector ?? ev.params?.url ?? ""}) — it failed in the trace`);
        continue;
      }
      const m = String(ev.method ?? "");
      const p = ev.params ?? {};
      const cls = String(ev.class ?? "");
      if (cls !== "Frame" && cls !== "Page" && cls !== "ElementHandle") continue;
      switch (m) {
        case "goto":
          steps.push({ method: "goto", url: p.url });
          break;
        case "fill":
        case "type":
        case "pressSequentially":
          steps.push({ method: "type", selector: p.selector, value: p.value ?? p.text });
          break;
        case "press":
          steps.push({ method: "press", selector: p.selector, key: p.key });
          break;
        case "keyboardPress":
          steps.push({ method: "press", key: p.key });
          break;
        case "click":
        case "dblclick":
        case "check":
        case "uncheck":
        case "tap":
          steps.push({ method: "click", selector: p.selector });
          break;
        case "hover":
          steps.push({ method: "hover", selector: p.selector });
          break;
        case "selectOption": {
          const o = p.options?.[0] ?? {};
          steps.push({ method: "select", selector: p.selector, option: o.valueOrLabel ?? o.value ?? o.label });
          break;
        }
        case "setInputFiles":
          steps.push({
            method: "upload",
            selector: p.selector,
            files: (p.localPaths ?? p.payloads?.map((x: any) => x.name) ?? []).map((x: string) => basename(x)),
          });
          break;
        case "waitForSelector":
          steps.push({ method: "waitFor", selector: p.selector });
          break;
        case "waitForTimeout":
          steps.push({ method: "pause", ms: Number(p.timeout) || 1000 });
          break;
        case "scrollIntoViewIfNeeded":
          steps.push({ method: "scrollTo", selector: p.selector });
          break;
        case "dragAndDrop":
          steps.push({ method: "drag", selector: p.source, target: p.target });
          break;
        case "goBack":
          steps.push({ method: "back" });
          break;
        case "expect":
          // Assertions: toBeVisible / toHaveText / toContainText / toHaveURL.
          if (p.selector) steps.push({ method: "assert", selector: p.selector, value: p.expectedText?.[0]?.string });
          break;
        default:
          if (/^(waitForLoadState|waitForNavigation|waitForURL|evaluate|screenshot|bringToFront|setViewportSize|title|content|url|isVisible|textContent|innerText|count|boundingBox|focus|blur)/.test(m)) break;
          notes.push(`skipped ${cls}.${m}`);
      }
    }
  }
  return steps;
}

/** Tolerant line-based parse of a Playwright test file (page.* chains). */
export function stepsFromTest(src: string, notes: string[]): Step[] {
  const steps: Step[] = [];
  // `const cart = page.getByTestId("cart")` … `await cart.click()`. Locators
  // parked in a const are the common shape of a readable spec; without this
  // every use of one was skipped with a note.
  const aliases = new Map<string, string>();
  const str = `(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)"|\`((?:[^\`\\\\]|\\\\.)*)\`)`;
  const S = (m: RegExpMatchArray, i: number) => m[i] ?? m[i + 1] ?? m[i + 2] ?? "";
  // Collapse statements onto one line.
  const stmts = src.replace(/\r/g, "").split(/;\s*\n|\n(?=\s*(?:await|expect|test|const|let))/);
  for (const stRaw of stmts) {
    const st = stRaw.replace(/\s+/g, " ").trim();
    let m: RegExpMatchArray | null;
    if ((m = st.match(new RegExp(`page\\.goto\\(\\s*${str}`)))) {
      steps.push({ method: "goto", url: S(m, 1) });
      continue;
    }
    const head = /^(?:await\s+)?(?:const\s+[A-Za-z_$][\w$]*\s*=\s*)?(?:expect\(\s*)?([A-Za-z_$][\w$]*)\b/.exec(st);
    const aliased = head && aliases.get(head[1]);
    if (!aliased && !/\b(page|frame|locator|expect)\b/.test(st)) continue;
    // Locator chain → selector.
    let selector: string | undefined = aliased || undefined;
    let frameSel: string | undefined;
    let nth: string | undefined;
    const chain = [...st.matchAll(new RegExp(`\\.(getByRole|getByTestId|getByText|getByLabel|getByPlaceholder|getByTitle|getByAltText|locator|frameLocator|first|last|nth)\\(\\s*(?:${str}|(\\d+))?\\s*(?:,\\s*\\{([^}]*)\\})?\\s*\\)`, "g"))];
    for (const c of chain) {
      const fn = c[1];
      const arg = c[2] ?? c[3] ?? c[4] ?? c[5] ?? "";
      const opts = c[6] ?? "";
      const name = opts.match(new RegExp(`name\\s*:\\s*${str}`));
      const exact = /exact\s*:\s*true/.test(opts);
      const hasText = opts.match(new RegExp(`hasText\\s*:\\s*${str}`));
      let part = "";
      switch (fn) {
        case "getByRole":
          part = name ? `role=${arg}[name="${S(name, 1)}"${exact ? "" : "i"}]` : `role=${arg}`;
          break;
        case "getByTestId":
          part = `[data-testid="${arg}"]`;
          break;
        case "getByText":
          part = exact ? `text="${arg}"` : `text=${arg}`;
          break;
        case "getByLabel":
          // Same engine the trace importer emits: resolves to the control.
          part = `internal:label="${arg.replace(/"/g, '\\"')}"${exact ? "s" : "i"}`;
          break;
        case "getByPlaceholder":
          part = `[placeholder="${arg}"]`;
          break;
        case "getByTitle":
          part = `[title="${arg}"]`;
          break;
        case "getByAltText":
          part = `[alt="${arg}"]`;
          break;
        case "locator":
          part = arg;
          if (hasText) part += `:has-text("${S(hasText, 1)}")`;
          break;
        case "frameLocator":
          frameSel = arg;
          continue;
        case "first":
          continue;
        case "last":
          nth = "-1";
          continue;
        case "nth":
          nth = arg;
          continue;
      }
      selector = selector ? `${selector} >> ${part}` : part;
    }
    if (nth != null && selector) selector += ` >> nth=${nth}`;
    if (frameSel && selector) selector = `${frameSel} >> internal:control=enter-frame >> ${selector}`;
    const term = st.match(new RegExp(`\\.(click|dblclick|check|uncheck|fill|type|pressSequentially|press|hover|selectOption|setInputFiles|waitFor|scrollIntoViewIfNeeded|dragTo|toBeVisible|toHaveText|toContainText|toHaveURL|toHaveValue|toBeEnabled|toHaveCount|toBeChecked|toHaveAttribute|toHaveScreenshot)\\(\\s*(?:${str}|/((?:[^/\\\\]|\\\\.)+)/[a-z]*)?`));
    if (!term) {
      if (/page\.waitForTimeout\((\d+)/.test(st)) {
        steps.push({ method: "pause", ms: Number(/page\.waitForTimeout\((\d+)/.exec(st)![1]) });
      } else if (/page\.goBack\(/.test(st)) steps.push({ method: "back" });
      else if (/\bpage\.keyboard\.press\(/.test(st)) {
        const k = st.match(new RegExp(`keyboard\\.press\\(\\s*${str}`));
        if (k) steps.push({ method: "press", key: S(k, 1) });
      } else if (selector) {
        const decl = /^const\s+([A-Za-z_$][\w$]*)\s*=/.exec(st);
        if (decl) aliases.set(decl[1], selector);
        else notes.push(`skipped: ${st.slice(0, 80)}`);
      }
      continue;
    }
    const regexArg = term[5];
    const arg = S(term, 2);
    switch (term[1]) {
      case "click":
      case "dblclick":
      case "check":
      case "uncheck":
        steps.push({ method: "click", selector });
        break;
      case "fill":
      case "type":
      case "pressSequentially":
        steps.push({ method: "type", selector, value: arg });
        break;
      case "press":
        steps.push({ method: "press", selector, key: arg });
        break;
      case "hover":
        steps.push({ method: "hover", selector });
        break;
      case "selectOption":
        steps.push({ method: "select", selector, option: arg });
        break;
      case "setInputFiles":
        steps.push({ method: "upload", selector, files: [basename(arg)] });
        break;
      case "waitFor":
        steps.push({ method: "waitFor", selector });
        break;
      case "scrollIntoViewIfNeeded":
        steps.push({ method: "scrollTo", selector });
        break;
      case "dragTo": {
        const to = [...st.matchAll(new RegExp(`\\.(?:locator|getByTestId|getByText)\\(\\s*${str}`, "g"))];
        const last = to[to.length - 1];
        steps.push({ method: "drag", selector, target: last ? S(last, 1) : undefined });
        break;
      }
      case "toHaveURL":
        steps.push({ method: "assert", url: regexArg ?? arg, urlIsRegex: !!regexArg });
        break;
      case "toBeVisible":
      case "toBeEnabled":
      case "toHaveCount":
        if (selector) steps.push({ method: "assert", selector });
        break;
      case "toBeChecked":
        // The storyboard's `assert` proves an element is THERE, so push the
        // checked-ness into the selector itself (`:scope` filters the located
        // element rather than its descendants).
        if (selector) steps.push({ method: "assert", selector: `${selector} >> :scope:checked` });
        break;
      case "toHaveAttribute": {
        if (!selector) break;
        const attrs = [...st.matchAll(new RegExp(`toHaveAttribute\\(\\s*${str}\\s*(?:,\\s*${str})?`, "g"))][0];
        const attr = attrs ? S(attrs, 1) : "";
        const val = attrs ? S(attrs, 4) : "";
        if (attr && val && !regexArg) {
          steps.push({
            method: "assert",
            selector: `${selector} >> :scope[${attr}="${val.replace(/"/g, '\\"')}"]`,
          });
        } else if (attr) {
          steps.push({ method: "assert", selector: `${selector} >> :scope[${attr}]` });
        }
        break;
      }
      case "toHaveScreenshot":
        // A pixel baseline has no place in a demo; the beat it guarded does.
        notes.push(
          `toHaveScreenshot() dropped — it asserts pixels, not a story beat; add a \`still\` marker there if you want the frame`
        );
        break;
      case "toHaveText":
      case "toContainText":
      case "toHaveValue":
        if (selector) steps.push({ method: "assert", selector, value: regexArg ?? arg, valueIsRegex: !!regexArg });
        break;
    }
  }
  return steps;
}

function targetOf(sel: string, frames: Record<string, string>, notes: string[]): Record<string, unknown> {
  const n = normalizeSelector(sel);
  const t: Record<string, unknown> = { selector: n.selector };
  if (n.nth != null) t.nth = n.nth;
  if (n.last) t.last = true;
  if (n.frameSelector) {
    let name = Object.keys(frames).find((k) => frames[k] === n.frameSelector);
    if (!name) {
      name = `frame${Object.keys(frames).length + 1}`;
      frames[name] = n.frameSelector;
    }
    t.frame = name;
  }
  if (n.note) notes.push(n.note);
  return t;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labelFor(step: Step): string {
  const sel = step.selector ?? "";
  const m = /name="([^"]+)"|text="?([^">]+)"?|data-testid="?([\w-]+)"?|#([\w-]+)/.exec(sel);
  return (m && (m[1] || m[2] || m[3] || m[4])) || sel.slice(0, 40);
}

/** Cut steps into scenes: at every goto, and before a click whose payoff is an explicit wait/assert. */
export function storyboardFromSteps(name: string, source: string, steps: Step[], notes: string[]): Record<string, unknown> {
  const frames: Record<string, string> = {};
  const scenes: ImportedScene[] = [];
  let cur: ImportedScene | null = null;
  const open = (label: string) => {
    if (cur && cur.actions.length) {
      cur.actions.push({ op: "pause", ms: 1400 });
      scenes.push(cur);
    }
    const id = `s${scenes.length + 1}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "step"}`;
    cur = { id, narration: `<narrate: ${label}>`, actions: [] };
  };
  const conv = (s: Step): ImportedAction | null => {
    switch (s.method) {
      case "goto":
        return { op: "goto", url: s.url };
      case "type":
        return { op: "type", target: targetOf(s.selector!, frames, notes), text: s.value ?? "" };
      case "press":
        return { op: "press", key: s.key ?? "Enter" };
      case "click":
        return { op: "click", target: targetOf(s.selector!, frames, notes) };
      case "hover":
        return { op: "hover", target: targetOf(s.selector!, frames, notes) };
      case "select":
        return { op: "select", target: targetOf(s.selector!, frames, notes), value: s.option ?? "" };
      case "upload":
        notes.push(`upload: copy ${s.files?.join(", ") || "the file"} into input/ and point files[] at it`);
        return { op: "upload", target: targetOf(s.selector!, frames, notes), files: (s.files ?? []).map((f) => `input/${f}`) };
      case "waitFor":
        return { op: "waitForWidget", target: targetOf(s.selector!, frames, notes), label: "thinking", timeoutMs: 30000 };
      case "pause":
        return { op: "pause", ms: Math.min(s.ms ?? 1000, 4000) };
      case "scrollTo":
        return { op: "scrollTo", target: targetOf(s.selector!, frames, notes), easing: "smooth" };
      case "drag":
        return {
          op: "drag",
          target: targetOf(s.selector!, frames, notes),
          to: s.target ? { target: targetOf(s.target, frames, notes) } : { x: 0, y: 0 },
        };
      case "back":
        return { op: "back" };
      case "assert": {
        const a: ImportedAction = { op: "assert" };
        if (s.selector) a.target = targetOf(s.selector, frames, notes);
        if (s.value) a.textMatches = s.valueIsRegex ? s.value : escapeRe(s.value);
        if (s.url) a.url = s.urlIsRegex ? s.url : escapeRe(s.url);
        if (!a.target && !a.url) return null;
        return a;
      }
    }
    return null;
  };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const next = steps[i + 1];
    const scene = cur as ImportedScene | null;
    if (s.method === "goto") open(`open ${s.url}`);
    else if (!scene) open("start");
    else if (s.method === "click" && next && (next.method === "waitFor" || next.method === "assert") && scene.actions.length > 0) {
      open(labelFor(s));
    }
    const a = conv(s);
    if (!a) continue;
    const at = cur as unknown as ImportedScene;
    at.actions.push(a);
    if (s.method === "goto") at.actions.push({ op: "pause", ms: 1200 });
  }
  const tail = cur as unknown as ImportedScene | null;
  if (tail && tail.actions.length) {
    tail.actions.push({ op: "pause", ms: 1600 });
    scenes.push(tail);
  }
  return {
    _README:
      `Draft imported from ${basename(source)} — the actions and selectors are the test's own (they already pass). ` +
      "Write the narration (one idea per scene, ~2.5 words/s), merge or split scenes so each carries one beat, " +
      "and run `aidemo probe` — then `render`.",
    title: name,
    targetLengthSeconds: Math.max(30, Math.min(90, scenes.length * 9)),
    video: { width: 1280, height: 720 },
    ...(Object.keys(frames).length ? { frames } : {}),
    voice: {
      voiceId: "marin",
      instructions: "Confident, friendly founder. Clear and warm, brisk but not rushed.",
      speed: 1.05,
    },
    zoom: { scale: 1.55, easeMs: 600, holdMs: 1700 },
    intro: { title: name, subtitle: "<one-line value prop>", durationMs: 2600 },
    outro: { title: "<call to action>", subtitle: "<your-domain.example>", durationMs: 2600 },
    scenes,
    ...(notes.length ? { _notes: [...new Set(notes)] } : {}),
  };
}

export async function importTrace(file: string, name: string): Promise<ImportResult> {
  const notes: string[] = [];
  const ext = extname(file).toLowerCase();
  let steps: Step[];
  let kind: ImportResult["kind"];
  if (ext === ".zip") {
    kind = "trace";
    steps = stepsFromTrace(readZipEntries(await fs.readFile(file)), notes);
  } else if ([".ts", ".js", ".mjs", ".mts", ".tsx", ".jsx"].includes(ext)) {
    kind = "test";
    steps = stepsFromTest(await fs.readFile(file, "utf8"), notes);
  } else {
    throw new Error(`import-trace: expected a Playwright trace.zip or a test file (.ts/.js), got ${basename(file)}`);
  }
  if (!steps.length) throw new Error(`import-trace: no browser actions found in ${basename(file)}`);
  const storyboard = storyboardFromSteps(name, file, steps, notes);
  return { source: file, kind, storyboard, notes: [...new Set(notes)], steps: steps.length };
}

import { Project } from "./project.js";
import { exists, ok } from "./util.js";

/** Write the imported draft as demos/<name>/ (storyboard + a short brief). */
export async function scaffoldImported(
  baseDir: string,
  name: string,
  result: ImportResult,
  opts: { force?: boolean } = {}
): Promise<string> {
  const project = new Project(`${baseDir}/demos/${name}`);
  if ((await exists(project.storyboardPath)) && !opts.force) {
    throw new Error(`${project.storyboardPath} exists — pass --force to overwrite`);
  }
  await project.ensureDirs();
  await fs.writeFile(project.storyboardPath, JSON.stringify(result.storyboard, null, 2) + "\n");
  const brief = `# Demo Brief — ${name}

Imported from \`${basename(result.source)}\` (${result.kind}, ${result.steps} step(s)).
The storyboard's actions are the test's own; write the narration and cut the
scenes to one beat each, then \`aidemo probe\`.
${result.notes.length ? `\nReview notes:\n${result.notes.map((n) => `- ${n}`).join("\n")}\n` : ""}
## Product
<your product>

## Demo goal
<the flow the test proves, told as a story>

## Audience / Tone / CTA
<fill in>
`;
  await fs.writeFile(project.p("input", "brief.md"), brief);
  ok(`imported ${result.steps} step(s) → demos/${name}/ (${(result.storyboard.scenes as unknown[]).length} scene(s))`);
  return project.dir;
}

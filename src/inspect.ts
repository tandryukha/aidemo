/**
 * Page inspection — selector discovery without an LLM in the loop.
 *
 * `inspect_page` / `aidemo inspect <url>` opens the URL in the recording
 * profile (logged-in state included), waits for it to settle, and returns
 * every visible interactive element with a ranked list of selectors that
 * are UNIQUE on the page right now (data-testid → id → aria-label →
 * role/text → name/placeholder → tag.class → structural path). The same scan
 * feeds the drift suggestions written next to a failed take, so an agent can
 * fix a selector from the failure artifact instead of guessing.
 */

import { chromium, type Frame, type Page } from "playwright";
import { chromeProfileDir } from "./config.js";
import { ensureProfileUnlocked } from "./login.js";

export interface InspectElement {
  /** ARIA role (explicit or implied by the tag). */
  role: string;
  /** Accessible-ish name: aria-label, text, placeholder, alt, title, value. */
  name: string;
  tag: string;
  testid?: string;
  id?: string;
  href?: string;
  /** Best unique selector (first of `selectors`). */
  selector: string;
  /** All unique selectors, best first. Empty when nothing unique was found. */
  selectors: string[];
  /** Viewport-relative box in CSS px. */
  rect: { x: number; y: number; w: number; h: number };
  inViewport: boolean;
  /** Storyboard `frames` name when the element lives in an iframe. */
  frame?: string;
}

export interface InspectResult {
  url: string;
  finalUrl: string;
  title: string;
  viewport: { width: number; height: number };
  headings: Array<{ level: number; text: string }>;
  elements: InspectElement[];
  /** iframes on the page (name/src), so `frames` can be authored. */
  iframes: Array<{ name: string; src: string; selector: string }>;
  truncated: boolean;
  screenshot?: string;
}

export interface InspectOptions {
  url: string;
  profileDir?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Max elements returned (default 80). */
  limit?: number;
  /** Write a viewport screenshot here. */
  screenshotPath?: string;
  /** Storyboard `frames` map (name → iframe selector) to scan as well. */
  frames?: Record<string, string>;
  /** Settle time after load (ms, default 1200). */
  settleMs?: number;
}

const DEFAULT_LIMIT = 80;

/**
 * In-page scan. Kept as a STRING (not a function) on purpose: tsx's keepNames
 * transform breaks named inner functions inside page.evaluate callbacks
 * (see AGENTS.md); a string is evaluated verbatim by the browser.
 */
const SCAN_JS = String.raw`(() => {
  const LIMIT = __LIMIT__;
  const IMPLIED = { a: "link", button: "button", input: "textbox", select: "combobox", textarea: "textbox", summary: "button", option: "option" };
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [role=textbox], [role=combobox], [contenteditable=true], [tabindex]:not([tabindex="-1"]), [onclick]';
  const all = Array.from(document.querySelectorAll(sel));
  const vw = window.innerWidth, vh = window.innerHeight;
  const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
  const q = (s) => s.replace(/["\\]/g, "\\$&");
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => norm(el.innerText || el.textContent || "");
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return norm(aria);
    const lab = el.getAttribute("aria-labelledby");
    if (lab) { const t = lab.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(" "); if (t) return t; }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const ph = el.getAttribute("placeholder"); if (ph) return norm(ph);
      if (el.id) { const l = document.querySelector('label[for="' + cssEsc(el.id) + '"]'); if (l) return textOf(l); }
      const pl = el.closest("label"); if (pl) return textOf(pl);
      const v = el.getAttribute("value"); if (v && (el.type === "submit" || el.type === "button")) return norm(v);
      return norm(el.getAttribute("name") || el.getAttribute("title") || "");
    }
    const t = textOf(el); if (t) return t.slice(0, 80);
    const img = el.querySelector("img[alt]"); if (img) return norm(img.getAttribute("alt"));
    return norm(el.getAttribute("title") || "");
  };
  const roleOf = (el) => el.getAttribute("role") || IMPLIED[el.tagName.toLowerCase()] || (el.getAttribute("contenteditable") === "true" ? "textbox" : "generic");
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.05;
  };
  const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch (e) { return false; } };
  const stableId = (id) => /^[A-Za-z][\w-]*$/.test(id) && !/\d{3,}/.test(id) && !/^(radix|headlessui|mui)-/i.test(id);
  const stableClass = (c) => /^[A-Za-z][\w-]{1,40}$/.test(c) && !/[0-9a-f]{5,}/i.test(c) && !/^(css|sc|jsx|emotion)-/.test(c) && !/_[A-Za-z0-9]{4,}$/.test(c);
  const items = [];
  const seen = new Set();
  for (const el of all) {
    if (!visible(el)) continue;
    if (seen.has(el)) continue; seen.add(el);
    const tag = el.tagName.toLowerCase();
    const name = nameOf(el);
    const role = roleOf(el);
    const rect = el.getBoundingClientRect();
    const cands = [];
    for (const attr of ["data-testid", "data-test", "data-cy", "data-qa"]) {
      const v = el.getAttribute(attr); if (v) cands.push("[" + attr + '="' + q(v) + '"]');
    }
    if (el.id && stableId(el.id)) cands.push("#" + cssEsc(el.id));
    const aria = el.getAttribute("aria-label"); if (aria) cands.push(tag + '[aria-label="' + q(aria) + '"]');
    const nm = el.getAttribute("name"); if (nm && (tag === "input" || tag === "select" || tag === "textarea" || tag === "button")) cands.push(tag + '[name="' + q(nm) + '"]');
    const ph = el.getAttribute("placeholder"); if (ph) cands.push(tag + '[placeholder="' + q(ph) + '"]');
    const href = el.getAttribute("href"); if (href && tag === "a" && href.length < 80 && !/^(#|javascript:)/.test(href)) cands.push('a[href="' + q(href) + '"]');
    const classes = Array.from(el.classList).filter(stableClass).slice(0, 2);
    if (classes.length) cands.push(tag + "." + classes.map(cssEsc).join("."));
    const uniq = cands.filter(unique);
    // role/text: Playwright-only syntax, uniqueness = same tag + same text count.
    const t = textOf(el);
    if (t && t.length <= 40 && (tag === "button" || tag === "a" || role === "button" || role === "link" || role === "tab" || role === "menuitem")) {
      const same = all.filter((o) => o !== el && o.tagName === el.tagName && textOf(o) === t && visible(o)).length;
      if (same === 0) uniq.push(tag + ':has-text("' + q(t) + '")');
    }
    if (!uniq.length) {
      // Structural fallback: short nth-of-type path up to a landmark/id.
      let node = el; const parts = [];
      for (let d = 0; node && node !== document.body && d < 4; d++) {
        const tg = node.tagName.toLowerCase();
        if (node.id && stableId(node.id)) { parts.unshift("#" + cssEsc(node.id)); break; }
        const sibs = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName) : [];
        parts.unshift(sibs.length > 1 ? tg + ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")" : tg);
        node = node.parentElement;
      }
      const path = parts.join(" > ");
      if (unique(path)) uniq.push(path);
    }
    const item = {
      role, name, tag,
      selector: uniq[0] || "",
      selectors: uniq,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw,
    };
    const tid = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy");
    if (tid) item.testid = tid;
    if (el.id) item.id = el.id;
    if (href && tag === "a") item.href = href;
    items.push(item);
    if (items.length >= LIMIT) break;
  }
  const headings = Array.from(document.querySelectorAll("h1, h2, h3")).filter(visible).slice(0, 30)
    .map((h) => ({ level: Number(h.tagName[1]), text: textOf(h).slice(0, 120) }));
  const iframes = Array.from(document.querySelectorAll("iframe")).filter(visible).slice(0, 20).map((f, i) => ({
    name: f.getAttribute("name") || f.getAttribute("title") || ("iframe-" + (i + 1)),
    src: (f.getAttribute("src") || "").slice(0, 200),
    selector: f.id && stableId(f.id) ? "#" + cssEsc(f.id) : (f.getAttribute("name") ? 'iframe[name="' + q(f.getAttribute("name")) + '"]' : "iframe:nth-of-type(" + (i + 1) + ")"),
  }));
  return { title: document.title, elements: items, headings, iframes, truncated: all.length > LIMIT && items.length >= LIMIT, total: all.length };
})()`;

interface ScanResult {
  title: string;
  elements: InspectElement[];
  headings: Array<{ level: number; text: string }>;
  iframes: Array<{ name: string; src: string; selector: string }>;
  truncated: boolean;
  total: number;
}

/** Scan one frame for visible interactive elements (see SCAN_JS). */
export async function scanInteractive(
  target: Page | Frame,
  limit = DEFAULT_LIMIT
): Promise<ScanResult> {
  return (await target.evaluate(SCAN_JS.replace("__LIMIT__", String(limit)))) as ScanResult;
}

/** Open the URL in the recording profile and scan it. */
export async function inspectPage(opts: InspectOptions): Promise<InspectResult> {
  const profileDir = opts.profileDir ?? chromeProfileDir();
  await ensureProfileUnlocked(profileDir);
  const viewport = opts.viewport ?? { width: 1280, height: 720 };
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: opts.headless !== false,
    args: ["--disable-blink-features=AutomationControlled"],
    viewport,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(opts.url, { waitUntil: "domcontentloaded" });
    await page
      .waitForLoadState("networkidle", { timeout: 4000 })
      .catch(() => {});
    await page.waitForTimeout(opts.settleMs ?? 1200);
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const main = await scanInteractive(page, limit);
    const elements = [...main.elements];
    let truncated = main.truncated;
    // Authored iframes (storyboard `frames`): scan each, tagging the frame name.
    for (const [name, selector] of Object.entries(opts.frames ?? {})) {
      const handle = await page.$(selector).catch(() => null);
      const frame = handle ? await handle.contentFrame().catch(() => null) : null;
      if (!frame) continue;
      const sub = await scanInteractive(frame, Math.max(10, limit - elements.length)).catch(() => null);
      if (!sub) continue;
      for (const el of sub.elements) elements.push({ ...el, frame: name });
      truncated = truncated || sub.truncated;
    }
    let screenshot: string | undefined;
    if (opts.screenshotPath) {
      await page.screenshot({ path: opts.screenshotPath, timeout: 8000 }).catch(() => {});
      screenshot = opts.screenshotPath;
    }
    return {
      url: opts.url,
      finalUrl: page.url(),
      title: main.title,
      viewport,
      headings: main.headings,
      elements,
      iframes: main.iframes,
      truncated,
      ...(screenshot ? { screenshot } : {}),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Drift ranking: which elements on the page look like the one a failed
// selector was after? Pure string similarity over what the selector encodes
// (testid / id / text / classes / tag) vs each element's testid / id / name.
// ---------------------------------------------------------------------------

function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const out = new Set<string>();
  for (const w of t.split(" ")) {
    if (!w) continue;
    if (w.length === 1) out.add(w);
    for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}

/** Dice coefficient over character bigrams (0..1). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

/** What a selector is "about": the human-ish tokens it encodes. */
export function selectorHints(selector: string): { tag?: string; text: string[]; ids: string[] } {
  const text: string[] = [];
  const ids: string[] = [];
  for (const m of selector.matchAll(/:(?:has-text|text-is|text)\(\s*["']?([^"')]+)["']?\s*\)/g)) text.push(m[1]);
  for (const m of selector.matchAll(/\[(?:data-testid|data-test|data-cy|data-qa|name|aria-label|placeholder|id)\s*[*^$~|]?=\s*["']?([^"'\]]+)["']?\]/g)) ids.push(m[1]);
  for (const m of selector.matchAll(/#([\w-]+)/g)) ids.push(m[1]);
  for (const m of selector.matchAll(/\.([A-Za-z][\w-]+)/g)) ids.push(m[1]);
  const tagM = selector.match(/(?:^|[\s>+~])([a-z][a-z0-9]*)(?=[.#\[:]|$)/);
  return { ...(tagM ? { tag: tagM[1] } : {}), text, ids };
}

export interface DriftCandidate extends InspectElement {
  score: number;
}

/** Rank scanned elements by how much they resemble what `selector` asked for. */
export function rankCandidates(
  selector: string,
  elements: InspectElement[],
  limit = 8
): DriftCandidate[] {
  const hints = selectorHints(selector);
  const wanted = [...hints.text, ...hints.ids.map((s) => s.replace(/[-_]/g, " "))];
  const scored = elements.map((el) => {
    let s = 0;
    const own = [el.name, el.testid ?? "", el.id ?? ""].filter(Boolean);
    for (const w of wanted) for (const o of own) s = Math.max(s, similarity(w, o));
    if (hints.tag && hints.tag === el.tag) s += 0.1;
    if (!wanted.length && hints.tag && hints.tag === el.tag) s = 0.3;
    if (!el.selector) s *= 0.5;
    return { ...el, score: Number(s.toFixed(3)) };
  });
  return scored
    .filter((c) => c.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

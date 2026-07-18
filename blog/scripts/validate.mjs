#!/usr/bin/env node
/**
 * validate.mjs — aidemo blog article quality gate.
 *
 * Usage: node blog/scripts/validate.mjs [--resolve]
 *
 * Checks every blog/data/articles/*.json for schema completeness, length
 * bounds, required content structure (Sources, FAQ), internal-link sanity,
 * and forbidden strings. With --resolve it also HTTP-checks every external
 * Source link — the citation gate: fabricated references must not survive.
 *
 * It also enforces the writer contract in blog/ops/lane-prompt.md
 * mechanically — word count, internal-link budget + live ratio, the aidemo
 * mention cap, the banned AI-slop phrasings, the banned openers, pillar/
 * topics agreement, and cross-article duplication. A rule that survives only
 * on the writer's memory does not scale to hundreds of articles (the
 * BurnWeek corpus this pipeline is ported from shipped a whole wave of
 * contract violations green before the contract was mechanized).
 *
 * Exit code is non-zero when any article has violations. Warnings never
 * fail the run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const articlesDir = path.join(BLOG_DIR, 'data', 'articles');
const topicsPath = path.join(BLOG_DIR, 'data', 'topics.json');
const resolveLinks = process.argv.includes('--resolve');

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// The writer contract, as numbers (blog/ops/lane-prompt.md is the prose source)
// ---------------------------------------------------------------------------

/** Contract: spokes 1,200-2,000 words; pillars 1,800-2,600. */
const WORDS_BY_ROLE = { spoke: [1200, 2000], pillar: [1800, 2600] };

/**
 * Word counting has a real noise floor (~5% across defensible counters —
 * whether URLs/anchors/hyphenates count as words), so the band gets a
 * measurement tolerance: VIOLATE only outside band+tolerance, WARN inside it.
 */
const WORD_TOLERANCE = 0.05;

/** Contract: 3-6 internal [anchor](/blog/slug) links in prose. */
const INTERNAL_LINKS = [3, 6];

/**
 * Contract: aidemo tie-in is capped at TWO mentions in prose (the CTA banner
 * does the selling). Comparison/listicle articles that include aidemo as an
 * entry get a little more room, but a mention on every screen reads as
 * advertorial and burns the blog's credibility for the educational queries
 * it exists to rank for. Counted on prose with code fences stripped —
 * `aidemo render` in a code sample is documentation, not a plug.
 */
const MAX_PRODUCT_MENTIONS = 2;

/** The first H2 must name the substance, not announce that an answer follows. */
const BANNED_OPENERS = [/^introduction$/i, /^overview$/i, /^the short answer\b/i, /^what is\b/i];

/**
 * Banned AI-slop phrasings — the frames that make a page read as generated
 * filler to both humans and search quality raters. Literal frames only;
 * fresh-worded clones are the human reviewer's call.
 */
const BANNED_PHRASES = [
  [/\bin today'?s (?:fast-paced|digital|competitive)\b/i, "in today's fast-paced/digital…"],
  [/\bin the (?:ever-)?(?:changing|evolving) (?:world|landscape) of\b/i, 'in the ever-evolving landscape of…'],
  [/\bgame[- ]chang(?:er|ing)\b/i, 'game-changer'],
  [/\brevolutioniz\w+\b/i, 'revolutionize'],
  [/\bseamless(?:ly)?\b/i, 'seamless(ly)'],
  [/\bunlock the (?:power|potential|full potential)\b/i, 'unlock the power/potential'],
  [/\b(?:let'?s )?di(?:ve|ving) (?:in|into|deep)\b/i, "dive in/into"],
  [/\bdelve\b/i, 'delve'],
  [/\bit'?s (?:important|worth) (?:to note|noting)\b/i, "it's important to note"],
  [/\bin conclusion\b/i, 'in conclusion'],
  [/\blook no further\b/i, 'look no further'],
  [/\bwhether you'?re a\b/i, "whether you're a…"],
  [/\bto the next level\b/i, 'to the next level'],
  [/\bisn'?t just (?:a|about)\b/i, "isn't just a/about… (it's-more trope)"],
];

// ---------------------------------------------------------------------------
// Cross-article duplication — independent convergence is the real failure
// mode (different writers, same contract + same sources, converging on the
// same sentences). 8-word shingles merged into maximal runs, reported by run
// length (>=10 words), links/statistics/Sources excluded at the source.
// WARN, never fail — every long run needs a human reading.
// ---------------------------------------------------------------------------
const DUP_NGRAM = 8;
const DUP_REPORT_WORDS = 10;
const DUP_MAX_PER_ARTICLE = 3;
const DUP_WORD = /^[a-z][a-z'-]{2,}$/; // a real word, not a numeral or a unit

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
if (!fs.existsSync(articlesDir)) {
  console.error(`No articles directory at ${articlesDir}`);
  process.exit(1);
}

let topics = null;
let topicsAvailable = false;
if (fs.existsSync(topicsPath)) {
  try {
    topics = JSON.parse(fs.readFileSync(topicsPath, 'utf8'));
    topicsAvailable = true;
  } catch {
    console.warn('warn: topics.json exists but is not parsable (mid-write?) — topic checks skipped');
  }
}
const topicSlugs = new Set((topics?.topics ?? []).map((t) => t.slug));
const topicBySlug = new Map((topics?.topics ?? []).map((t) => [t.slug, t]));
const clusterKeys = new Set(Object.keys(topics?.clusters ?? {}));

const files = fs.readdirSync(articlesDir).filter((f) => f.endsWith('.json')).sort();
const articles = [];
const results = new Map(); // filename -> {violations: [], warnings: []}

for (const file of files) {
  const r = { violations: [], warnings: [] };
  results.set(file, r);
  try {
    articles.push({ file, data: JSON.parse(fs.readFileSync(path.join(articlesDir, file), 'utf8')) });
  } catch (e) {
    r.violations.push(`unparsable JSON: ${e.message}`);
  }
}

const articleSlugs = new Set(articles.map((a) => a.data.slug).filter(Boolean));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Content may open with HTML comments (e.g. pipeline-sample markers). */
function stripLeadingComments(md) {
  let s = String(md);
  for (;;) {
    const trimmed = s.replace(/^\s+/, '');
    if (trimmed.startsWith('<!--')) {
      const end = trimmed.indexOf('-->');
      if (end === -1) return trimmed;
      s = trimmed.slice(end + 3);
    } else {
      return trimmed;
    }
  }
}

/** Text of a `## Heading` section, up to the next `## ` or EOF. */
function section(md, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const m = re.exec(md);
  if (!m) return null;
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function markdownLinks(md) {
  return [...md.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => ({ text: m[1], href: m[2] }));
}

/**
 * The article minus its bibliography. `## Sources` is a reference list, not
 * prose: it must not buy word count, and a shared one is expected.
 */
function dropSources(md) {
  const m = /^##\s+Sources\s*$/im.exec(md);
  return m === null ? md : md.slice(0, m.index);
}

/** Every `## Heading` in order. */
function h2s(md) {
  return [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
}

/** Prose with code fences and inline code stripped — for diction checks. */
function dropCode(md) {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/**
 * Prose words. A URL is not a word; anchor text IS words; markdown
 * punctuation and table rules are not. See WORD_TOLERANCE.
 */
function proseWords(md) {
  const s = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/[#>*_~|]/g, ' ');
  return (s.match(/[A-Za-z0-9][A-Za-z0-9'’./%-]*/g) ?? []).length;
}

/** A one-line window around `at`, so a violation can be found in the file. */
function excerptAround(md, at, span = 60) {
  return md.slice(Math.max(0, at - 10), at + span).replace(/\s+/g, ' ').trim();
}

/** Internal `/blog/<slug>` deep-link targets in prose, deduped. */
function internalTargets(md) {
  const out = new Set();
  for (const { href } of markdownLinks(md)) {
    const m = href.match(/^\/blog\/([a-z0-9-]+)\/?(?:#[A-Za-z0-9-]*)?$/);
    if (m && m[1] !== 'topics') out.add(m[1]);
  }
  return out;
}

/**
 * Duplication tokens: the prose word stream with never-a-finding spans cut
 * out (code, links incl. wrapping parens). Offsets stay absolute so a match
 * can be quoted back from the original text; `seg` rises across every removed
 * span so a shingle never spans text that was not adjacent.
 */
function dupTokens(md) {
  const src = dropSources(stripLeadingComments(md));
  const cuts = [
    /```[\s\S]*?```/g,                                  // code
    /\(?\[[^\]]*\]\([^)\s]*(?:\s+"[^"]*")?\)\)?/g,      // any link, plus a wrapping paren pair
  ].flatMap((re) => [...src.matchAll(re)].map((m) => [m.index, m.index + m[0].length]))
    .sort((a, b) => a[0] - b[0]);

  const toks = [];
  let seg = 0;
  let cut = 0;
  for (const m of src.matchAll(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)) {
    while (cut < cuts.length && cuts[cut][1] <= m.index) { cut++; seg++; }
    if (cut < cuts.length && m.index >= cuts[cut][0]) continue; // inside a removed span
    toks.push({ w: m[0].toLowerCase().replace(/[’]/g, "'"), at: m.index, len: m[0].length, seg });
  }
  return { src, toks };
}

// ---------------------------------------------------------------------------
// Per-article checks
// ---------------------------------------------------------------------------
const REQUIRED_STRINGS = ['slug', 'status', 'cluster', 'title', 'excerpt', 'seoTitle', 'seoDescription', 'content', 'publishedAt', 'updatedAt'];

for (const { file, data: a } of articles) {
  const r = results.get(file);
  const v = (msg) => r.violations.push(msg);
  const w = (msg) => r.warnings.push(msg);

  // --- schema completeness
  for (const key of REQUIRED_STRINGS) {
    if (typeof a[key] !== 'string' || !a[key].trim()) v(`missing or empty field: ${key}`);
  }
  if (!('pillar' in a)) v('missing field: pillar (use null for pillar articles)');
  else if (a.pillar !== null && (typeof a.pillar !== 'string' || !KEBAB.test(a.pillar))) v('pillar must be null or a kebab-case slug');
  if (!Array.isArray(a.tags) || a.tags.length === 0) v('tags must be a non-empty array');
  if (!Number.isFinite(a.readingTimeMinutes) || a.readingTimeMinutes < 1) v('readingTimeMinutes must be a positive number');
  if (!a.hero || typeof a.hero !== 'object') {
    w('no hero object — cards use the styled no-image tile; add hero subject/scene/alt/caption when an image lane exists');
  } else {
    if (!a.hero.alt?.trim()) w('hero.alt missing — alt text falls back to the title at bake');
    if (!a.hero.caption?.trim()) w('hero.caption missing — hero renders without its argumentative caption');
  }
  if (!Array.isArray(a.keyTakeaways) || a.keyTakeaways.filter((t) => String(t).trim()).length < 3) {
    w('keyTakeaways missing or <3 bullets — article bakes without the answer-first summary card');
  }
  if (a.status && !['draft', 'published'].includes(a.status)) v(`status must be "draft"|"published", got "${a.status}"`);
  for (const key of ['publishedAt', 'updatedAt']) {
    if (typeof a[key] === 'string' && !ISO_DATE.test(a[key])) v(`${key} must be YYYY-MM-DD`);
  }

  // --- slug rules
  if (typeof a.slug === 'string') {
    if (!KEBAB.test(a.slug)) v(`slug is not kebab-case: "${a.slug}"`);
    if (file !== `${a.slug}.json`) v(`filename ${file} does not match slug "${a.slug}"`);
    const dupes = articles.filter((o) => o.data.slug === a.slug);
    if (dupes.length > 1) v(`slug "${a.slug}" is not unique (also in ${dupes.map((d) => d.file).filter((f) => f !== file).join(', ')})`);
    if (topicsAvailable && !topicSlugs.has(a.slug)) w(`slug "${a.slug}" not found in topics.json`);
  }

  // --- length bounds
  if (typeof a.excerpt === 'string' && (a.excerpt.length < 120 || a.excerpt.length > 160)) {
    v(`excerpt must be 120-160 chars (is ${a.excerpt.length})`);
  }
  if (typeof a.seoDescription === 'string' && (a.seoDescription.length < 130 || a.seoDescription.length > 160)) {
    v(`seoDescription must be 130-160 chars (is ${a.seoDescription.length})`);
  }
  if (typeof a.seoTitle === 'string') {
    if (a.seoTitle.length > 60) v(`seoTitle must be <=60 chars (is ${a.seoTitle.length})`);
    if (!a.seoTitle.endsWith(' | aidemo')) v('seoTitle must end with " | aidemo"');
  }

  // --- content structure
  if (typeof a.content !== 'string') continue;
  const content = a.content;
  const body = stripLeadingComments(content);
  if (!body.startsWith('## ')) v('content must start with an h2 ("## ...") — the template owns the h1');
  if (/^#\s/m.test(content)) v('content contains an h1 ("# ...") — the template owns the h1');

  const sources = section(content, 'Sources');
  if (sources === null) v('content is missing a "## Sources" section');
  else {
    const links = markdownLinks(sources).filter((l) => /^https?:\/\//.test(l.href));
    if (links.length < 3) v(`"## Sources" must contain >=3 markdown links (has ${links.length})`);
    a._sourceLinks = links; // stashed for --resolve
  }

  const faqSection = section(content, 'FAQ');
  if (faqSection === null) v('content is missing a "## FAQ" section');
  else {
    const questions = [...faqSection.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].trim());
    const qForm = questions.filter((q) => q.endsWith('?'));
    if (qForm.length < 2) v(`"## FAQ" must contain >=2 question-form ("...?") h3 headings (has ${qForm.length})`);
    if (questions.length !== qForm.length) w('FAQ contains h3 headings that do not end with "?" — they will not be picked up for FAQPage JSON-LD');
  }

  // --- internal links point at known article/topic slugs
  for (const { href } of markdownLinks(content)) {
    if (!href.startsWith('/blog')) continue;
    if (/^\/blog\/?$/.test(href)) continue;
    const hub = href.match(/^\/blog\/topics\/([a-z0-9-]+)\/?$/);
    if (hub) {
      const known = clusterKeys.has(hub[1]) || articles.some((o) => o.data.cluster === hub[1]);
      if (!known) (topicsAvailable ? v : w)(`internal hub link targets unknown cluster: ${href}`);
      continue;
    }
    const art = href.match(/^\/blog\/([a-z0-9-]+)\/?(#[A-Za-z0-9-]*)?$/);
    if (!art) { v(`malformed internal link: ${href}`); continue; }
    const slug = art[1];
    if (articleSlugs.has(slug) || topicSlugs.has(slug)) continue;
    // Unknown slug: hard violation when topics.json is the arbiter; a warning
    // when it is absent (bake unwraps the link either way, so nothing 404s).
    (topicsAvailable ? v : w)(`internal link targets unknown slug: ${href}`);
  }

  // -------------------------------------------------------------------------
  // The writer contract (lane-prompt.md), enforced
  // -------------------------------------------------------------------------
  const topic = topicBySlug.get(a.slug);
  // Role decides the word band. topics.json is the arbiter; if the slug is
  // not in it (warned above), the article's own `pillar: null` says the same
  // thing — a pillar is exactly the article with no pillar above it.
  const role = topic?.role ?? (a.pillar === null ? 'pillar' : 'spoke');
  const prose = dropSources(body);
  const heads = h2s(body);

  // --- pillar must agree with topics.json
  if (topic && topic.pillar !== undefined && a.pillar !== topic.pillar) {
    v(`pillar disagrees with topics.json: article says ${JSON.stringify(a.pillar)}, topics.json says ${JSON.stringify(topic.pillar)}`);
  }
  if (topic?.role === 'pillar' && a.pillar !== null) v('topics.json calls this a pillar, so article pillar must be null');

  // --- word count (role-aware, bibliography excluded, tolerance per WORD_TOLERANCE)
  const [lo, hi] = WORDS_BY_ROLE[role];
  const words = proseWords(prose);
  const hardLo = Math.floor(lo * (1 - WORD_TOLERANCE));
  const hardHi = Math.ceil(hi * (1 + WORD_TOLERANCE));
  const band = `a ${role} wants ${lo}-${hi}`;
  const tol = `${WORD_TOLERANCE * 100}% counter tolerance`;
  const src = 'counted on prose, excluding "## Sources"';
  if (words < hardLo) v(`content is ${words} words — ${band}, so it is ${lo - words} under the floor and past the ${tol} (${src})`);
  else if (words > hardHi) v(`content is ${words} words — ${band}, so it is ${words - hi} over the ceiling and past the ${tol} (${src})`);
  else if (words < lo) w(`content is ${words} words — ${band}, so it is ${lo - words} under the floor, but within the ${tol}, so not a fail (${src})`);
  else if (words > hi) w(`content is ${words} words — ${band}, so it is ${words - hi} over the ceiling, but within the ${tol}, so not a fail (${src})`);

  // --- internal links: 3-6 in prose, at least half of them live
  const targets = internalTargets(prose);
  if (targets.size < INTERNAL_LINKS[0]) {
    v(`${targets.size} internal link(s) in prose, contract wants ${INTERNAL_LINKS[0]}-${INTERNAL_LINKS[1]} — orphan articles rank worse and route nothing`);
  } else if (role !== 'pillar' && targets.size > INTERNAL_LINKS[1]) {
    v(`${targets.size} internal links in prose, contract caps a spoke at ${INTERNAL_LINKS[1]} (counting distinct targets; linking one slug twice counts once)`);
  }
  // The ceiling is NOT applied to pillars: a pillar routes to its spokes, and
  // a cluster can have more than 6. "Live" = an article file exists, NOT
  // status:published — a whole wave is written as drafts and flipped together
  // after the gates, so testing status here would fail every writer for
  // linking the siblings it was told to link.
  const live = [...targets].filter((s) => articleSlugs.has(s));
  if (targets.size && live.length * 2 < targets.size) {
    const dead = [...targets].filter((s) => !articleSlugs.has(s));
    v(
      `only ${live.length} of ${targets.size} internal links point at a written article — contract wants at least half. ` +
        `Unwritten (legal, bake unwraps them, but they light up later, not now): ${dead.join(', ')}`,
    );
  }
  if (role === 'pillar') {
    const spokes = articles.filter((o) => o.data.pillar === a.slug && o.data.slug).map((o) => o.data.slug);
    const linked = spokes.filter((s) => targets.has(s)).length;
    // Routing minimum, not every-spoke: the hub page already lists every spoke
    // as a card and each article gets a related-articles module. The failure
    // to catch is a hub that routes to almost nothing — a sink, not a hub.
    const need = Math.min(spokes.length, 4);
    if (linked < need) {
      const missed = spokes.filter((s) => !targets.has(s));
      w(`pillar prose-links only ${linked} of ${spokes.length} spokes — a hub should route to ≥${need} of its most relevant spokes in prose. Candidates: ${missed.slice(0, 6).join(', ')}${missed.length > 6 ? '…' : ''}`);
    }
  }

  // --- aidemo tie-in: capped, counted outside code samples. Comparison
  // pieces that include aidemo as an entry may raise the cap per-topic via
  // topics.json `productMentionCap` — the default stays deliberately low.
  const diction = dropCode(prose);
  const mentionCap = Number.isFinite(topic?.productMentionCap) ? topic.productMentionCap : MAX_PRODUCT_MENTIONS;
  const mentions = (diction.match(/\baidemo\b/gi) ?? []).length;
  if (mentions > mentionCap) v(`${mentions} aidemo mentions in prose (code samples excluded), contract caps this topic at ${mentionCap} — the CTA banner does the selling`);

  // --- banned openers: the first H2 must name the substance
  if (heads.length && BANNED_OPENERS.some((re) => re.test(heads[0]))) {
    v(`first H2 "${heads[0]}" is a banned opener — name the substance instead of announcing that an answer follows`);
  }

  // --- the banned AI-slop phrasings
  for (const [re, label] of BANNED_PHRASES) {
    const hit = re.exec(diction);
    if (hit) v(`banned phrasing "${label}": …${excerptAround(diction, hit.index)}…`);
  }

  // --- forbidden strings (pipeline provenance must not leak into articles)
  const flat = JSON.stringify(a);
  if (/burnweek|maxfit|irondust|calorie-slo/i.test(flat)) v('article references burnweek/maxfit/irondust/calorie-slo');
}

// ---------------------------------------------------------------------------
// Cross-article checks
// ---------------------------------------------------------------------------

/**
 * Exact reuse of an H2 or an FAQ question across two articles. The FAQ block
 * emits FAQPage schema and competes for one People-Also-Ask slot — a
 * duplicate is two of our own articles bidding against each other.
 */
function checkReusedHeadings() {
  const h2Seen = new Map();
  const faqSeen = new Map();
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const { file, data: a } of articles) {
    if (typeof a.content !== 'string') continue;
    const body = stripLeadingComments(a.content);
    for (const h of h2s(body)) {
      if (/^(FAQ|Sources)$/i.test(h)) continue; // structural, required in every article
      const k = norm(h);
      if (!h2Seen.has(k)) h2Seen.set(k, []);
      h2Seen.get(k).push({ file, text: h });
    }
    const faq = section(a.content, 'FAQ');
    for (const m of (faq ?? '').matchAll(/^###\s+(.+)$/gm)) {
      const k = norm(m[1]);
      if (!faqSeen.has(k)) faqSeen.set(k, []);
      faqSeen.get(k).push({ file, text: m[1].trim() });
    }
  }
  for (const [kind, seen, why] of [
    ['H2', h2Seen, 'contract: an H2 is never reused across articles'],
    ['FAQ question', faqSeen, 'contract: FAQ questions must be unique across the corpus — a duplicate is two of our articles bidding for one People-Also-Ask slot'],
  ]) {
    for (const hits of seen.values()) {
      if (hits.length < 2) continue;
      for (const hit of hits) {
        const others = hits.filter((o) => o.file !== hit.file).map((o) => o.file);
        if (!others.length) continue; // same article twice: its own problem, not reuse
        results.get(hit.file).violations.push(`${kind} "${hit.text}" is also in ${others.join(', ')} — ${why}`);
      }
    }
  }
}
checkReusedHeadings();

/**
 * Independent convergence across articles — see the DUP_* header. Inverted
 * shingle index, linear in corpus words; only shingles at least two articles
 * share ever produce pair work.
 */
function checkDuplication() {
  const docs = articles
    .filter(({ data }) => typeof data.content === 'string' && data.slug)
    .map(({ file, data }) => ({ file, slug: data.slug, ...dupTokens(data.content) }));
  if (docs.length < 2) return;

  const index = new Map();
  docs.forEach((d, di) => {
    for (let i = 0; i + DUP_NGRAM <= d.toks.length; i++) {
      const win = d.toks.slice(i, i + DUP_NGRAM);
      if (win[0].seg !== win[DUP_NGRAM - 1].seg) continue; // never span a removed span
      if (win.filter((t) => DUP_WORD.test(t.w)).length * 2 < DUP_NGRAM) continue; // a statistic, not prose
      const key = win.map((t) => t.w).join(' ');
      let e = index.get(key);
      if (!e) index.set(key, (e = []));
      e.push({ di, pos: i });
    }
  });

  const pairHits = new Map();
  for (const hits of index.values()) {
    if (hits.length < 2) continue;
    for (let x = 0; x < hits.length; x++) {
      for (let y = x + 1; y < hits.length; y++) {
        if (hits[x].di === hits[y].di) continue;
        const pk = `${hits[x].di}|${hits[y].di}`;
        let p = pairHits.get(pk);
        if (!p) pairHits.set(pk, (p = []));
        p.push([hits[x].pos, hits[y].pos]);
      }
    }
  }

  /** Merge shingle hits that step together 1:1 into their maximal shared run. */
  const mergeRuns = (hits) => {
    hits.sort((u, v) => u[0] - v[0] || u[1] - v[1]);
    const runs = [];
    for (const [x, y] of hits) {
      const last = runs[runs.length - 1];
      if (last && x - last.a <= last.len && y - last.b === x - last.a) last.len = x - last.a + DUP_NGRAM;
      else runs.push({ a: x, b: y, len: DUP_NGRAM });
    }
    return runs;
  };
  const quote = (d, pos, len) => {
    const s = d.toks[pos];
    const e = d.toks[pos + len - 1];
    return d.src.slice(s.at, e.at + e.len).replace(/\s+/g, ' ');
  };

  // Group each article's findings by the shared TEXT, not by the partner:
  // one passage reused by six articles is one thing to fix, not six warnings.
  const found = new Map(); // di -> Map(text -> Set(partner slug))
  for (const [pk, hits] of pairHits) {
    const [x, y] = pk.split('|').map(Number);
    for (const run of mergeRuns(hits)) {
      if (run.len < DUP_REPORT_WORDS) continue;
      for (const [self, other, pos] of [[x, y, run.a], [y, x, run.b]]) {
        if (!found.has(self)) found.set(self, new Map());
        const byText = found.get(self);
        const text = quote(docs[self], pos, run.len);
        if (!byText.has(text)) byText.set(text, new Set());
        byText.get(text).add(docs[other].slug);
      }
    }
  }

  for (const [di, byText] of found) {
    const top = [...byText.entries()]
      .sort((u, v) => v[0].length - u[0].length)
      .slice(0, DUP_MAX_PER_ARTICLE);
    for (const [text, partners] of top) {
      const shown = text.length > 160 ? `${text.slice(0, 160)}…` : text;
      results.get(docs[di].file).warnings.push(
        `shared passage with ${[...partners].sort().join(', ')}: "${shown}" — independent convergence, not copying. ` +
          'One article owns a claim; the other gets a sentence and a link.',
      );
    }
  }
}
checkDuplication();

// ---------------------------------------------------------------------------
// --resolve: HTTP-check every external Source link (the citation gate)
// ---------------------------------------------------------------------------
async function checkUrl(url) {
  const UA = 'Mozilla/5.0 (compatible; AidemoBlogValidator/1.0; +https://aidemo.top)';
  for (let attempt = 0; attempt <= 2; attempt++) {
    for (const method of attempt === 0 ? ['HEAD', 'GET'] : ['GET']) {
      try {
        const res = await fetch(url, {
          method,
          redirect: 'follow',
          signal: AbortSignal.timeout(10_000),
          headers: { 'user-agent': UA, accept: 'text/html,*/*' },
        });
        if (res.ok) return { ok: true, status: res.status };
        // Some hosts (e.g. support.google.com) 404 HEAD requests they serve
        // fine via GET — only trust a dead verdict from GET.
        if ((res.status === 404 || res.status === 410) && method === 'GET') {
          return { ok: false, status: res.status, dead: true };
        }
        if (method === 'GET' && [401, 403, 405, 429, 503].includes(res.status)) {
          return { ok: false, status: res.status, blocked: true }; // bot-blocked, can't verify
        }
        if (method === 'GET') return { ok: false, status: res.status, dead: true };
      } catch (e) {
        if (method === 'GET' && attempt === 2) return { ok: false, error: e.message, dead: true };
      }
    }
  }
  return { ok: false, error: 'unreachable', dead: true };
}

if (resolveLinks) {
  for (const { file, data: a } of articles) {
    const r = results.get(file);
    for (const { href } of a._sourceLinks ?? []) {
      const res = await checkUrl(href);
      if (res.ok) continue;
      if (res.blocked) r.warnings.push(`source link could not be verified (HTTP ${res.status}, likely bot-blocked): ${href}`);
      else r.violations.push(`dead source link (${res.status ?? res.error}): ${href}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let failed = 0;
for (const file of files) {
  const { violations, warnings } = results.get(file);
  if (!violations.length && !warnings.length) {
    console.log(`OK    ${file}`);
    continue;
  }
  if (violations.length) {
    failed++;
    console.log(`FAIL  ${file}`);
    for (const msg of violations) console.log(`      violation: ${msg}`);
  } else {
    console.log(`OK    ${file} (with warnings)`);
  }
  for (const msg of warnings) console.log(`      warning:   ${msg}`);
}

if (!files.length) console.log('no articles found — nothing to validate');
console.log(`\n${files.length - failed}/${files.length} article(s) pass${resolveLinks ? ' (with --resolve citation gate)' : ''}`);
process.exit(failed ? 1 : 0);

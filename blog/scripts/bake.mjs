#!/usr/bin/env node
/**
 * bake.mjs — aidemo blog static-site generator (ported from the BurnWeek blog).
 *
 * FROZEN pending engine parity at a released tag — this script stays the
 * operational bake (the site must remain regenerable) but takes no new
 * features; file blog-engine feedback instead. The centralized engine
 * (github:tandryukha/blog-engine) reproduces this output byte-for-byte on
 * main@87918ce with blog/blog.config.json (site.codeBlocks/indexHeading,
 * publish.robots=false), but #stable (v0.1.1) predates those knobs. Retire
 * per the checklist in blog/README.md § "Blog-engine migration (M3)" +
 * blog-engine issue #9.
 *
 * Usage: node blog/scripts/bake.mjs [--drafts] [--out docs/blog]
 *
 * Reads blog/data/articles/*.json (+ blog/data/topics.json when present,
 * tolerating absence or a mid-write unparsable file) and emits a fully
 * static site to docs/blog/ (committed — GitHub Pages serves it under
 * https://aidemo.top/blog/, so deploy = git push).
 *
 * Design notes:
 * - Deterministic: stable ordering, no Date.now() in emitted content —
 *   all timestamps come from article publishedAt/updatedAt fields.
 * - All internal URLs are absolute under the /blog/ base path.
 * - Internal-link resolution: prose links to /blog/{slug} whose target is
 *   not part of this bake are unwrapped to plain text so nothing ever 404s;
 *   they light up automatically once the target article publishes.
 * - The stylesheet is content-hashed (blog.<sha8>.css) so a design change
 *   always busts caches/CDNs regardless of Pages cache headers.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { createHighlighter } from 'shiki';

const BLOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ORIGIN = 'https://aidemo.top';
const BASE = '/blog';
const AI_DISCLOSURE =
  'This article was researched and drafted with AI assistance and reviewed by the aidemo maintainers. Tool capabilities and prices change — check vendor docs before deciding.';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const includeDrafts = args.includes('--drafts');
const outFlag = args.indexOf('--out');
const OUT_DIR = outFlag !== -1 && args[outFlag + 1]
  ? path.resolve(process.cwd(), args[outFlag + 1])
  : path.join(BLOG_DIR, '..', 'docs', 'blog');

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXml(s) {
  return escapeHtml(s).replace(/'/g, '&apos;');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const RSS_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RSS_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function rssDate(iso) {
  const dt = new Date(`${iso}T00:00:00Z`);
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${RSS_DAYS[dt.getUTCDay()]}, ${dd} ${RSS_MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()} 00:00:00 GMT`;
}

function jsonLd(obj) {
  // </script>-safe JSON-LD
  return JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
}

function titleCase(key) {
  return key.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
const articlesDir = path.join(BLOG_DIR, 'data', 'articles');
const imagesDir = path.join(BLOG_DIR, 'public', 'images');

/**
 * Drop leading HTML comments from article content.
 *
 * Pipeline/draft markers live at the top of `content` as `<!-- ... -->`. They are
 * invisible in rendered HTML, which is exactly why one shipped: the markdown mirror
 * (`index.md`) and `llms-full.txt` serve content as PLAIN TEXT to AI crawlers, so a
 * marker reading "review before flipping status to published" was being fed to LLMs as
 * content about a published article. validate.mjs strips these to validate and bake
 * then wrote them out anyway.
 *
 * Strip once at load so every consumer (HTML, md mirror, llms-full) is clean by
 * construction rather than by three remembering to do it.
 */
function stripLeadingComments(md) {
  let s = String(md);
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (!t.startsWith('<!--')) return t;
    const end = t.indexOf('-->');
    if (end === -1) return t; // unterminated — leave it rather than eat the article
    s = t.slice(end + 3);
  }
}

const allArticles = fs.existsSync(articlesDir)
  ? fs.readdirSync(articlesDir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(articlesDir, f), 'utf8')))
    .map((a) => (a.content ? { ...a, content: stripLeadingComments(a.content) } : a))
  : [];

let topics = null; // { clusters: {key:{title,description}}, topics: [{slug,title,cluster,role,pillar,keywords,crossLinks,wave}] }
const topicsPath = path.join(BLOG_DIR, 'data', 'topics.json');
if (fs.existsSync(topicsPath)) {
  try {
    topics = JSON.parse(fs.readFileSync(topicsPath, 'utf8'));
  } catch {
    console.warn('warn: topics.json exists but is not parsable (mid-write?) — falling back to article fields');
  }
}
const topicBySlug = new Map((topics?.topics ?? []).map((t) => [t.slug, t]));

const included = allArticles
  .filter((a) => a.status === 'published' || (includeDrafts && a.status === 'draft'))
  .sort((a, b) => (a.publishedAt === b.publishedAt
    ? a.slug.localeCompare(b.slug)
    : b.publishedAt.localeCompare(a.publishedAt))); // newest first, slug tiebreak

const includedSlugs = new Set(included.map((a) => a.slug));
const clusters = [...new Set(included.map((a) => a.cluster))].sort();
const clusterSet = new Set(clusters);

// ---------------------------------------------------------------------------
// Hero image handling — files come from blog/public/images/{slug}-{400,800}.webp.
// Never emit a broken <img>: fall back to a styled no-image variant.
// ---------------------------------------------------------------------------
function heroFiles(slug) {
  const has = (suffix) => fs.existsSync(path.join(imagesDir, `${slug}-${suffix}.webp`));
  return { w400: has(400), w800: has(800) };
}

function heroSrcset(slug, files) {
  const parts = [];
  if (files.w400) parts.push(`${BASE}/images/${slug}-400.webp 400w`);
  if (files.w800) parts.push(`${BASE}/images/${slug}-800.webp 800w`);
  return parts.join(', ');
}

function cardImageHtml(article, { featured = false } = {}) {
  const files = heroFiles(article.slug);
  const cls = featured ? 'blog-featured-image' : 'article-card-image';
  if (!files.w400 && !files.w800) {
    // Intentional-looking tile (topic lockup on a tinted wash) — never a
    // giant orphan initial, never a broken <img>.
    return `<div class="${cls} ${cls}--noimg" aria-hidden="true"><span class="noimg-topic">${escapeHtml(clusterMeta(article.cluster).title)}</span></div>`;
  }
  const src = files.w400 ? `${BASE}/images/${article.slug}-400.webp` : `${BASE}/images/${article.slug}-800.webp`;
  const sizes = featured ? '(max-width: 768px) 100vw, 600px' : '(max-width: 768px) 100vw, 400px';
  return `<div class="${cls}"><img loading="lazy" src="${src}" srcset="${heroSrcset(article.slug, files)}" sizes="${sizes}" alt="${escapeHtml(article.hero?.alt ?? article.title)}"></div>`;
}

// ---------------------------------------------------------------------------
// Markdown rendering (marked v13+ token-object renderer API)
// ---------------------------------------------------------------------------

// Build-time syntax highlighting (shiki — grammars/themes are bundled, no
// network at bake). one-light auditioned best against the warm-paper palette;
// its background is stripped (the .code-block container owns the tinted
// panel) and its comment grey is darkened for contrast on that panel.
// HTML-only: the .md mirrors and llms*.txt keep raw fenced code verbatim.
// Shiki's async setup is a single top-level await — everything downstream
// (renderContent, main) stays synchronous.
const CODE_THEME = 'one-light';
const CODE_LANGS = ['yaml', 'javascript', 'typescript', 'tsx', 'json', 'jsonc',
  'json5', 'shellscript', 'html', 'css', 'python', 'diff'];
const CODE_LANG_ALIASES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', yml: 'yaml', py: 'python',
  sh: 'shellscript', bash: 'shellscript', shell: 'shellscript', zsh: 'shellscript',
};
const CODE_COLOR_REPLACEMENTS = {
  '#fafafa': 'transparent', // one-light bg — .code-block owns the panel color
  '#a0a1a7': '#6f747e',     // comments: 2.3:1 → 4.3:1 on the tinted panel
};
const highlighter = await createHighlighter({ themes: [CODE_THEME], langs: CODE_LANGS });

/**
 * Fenced code block → dev-grade chrome: bordered tinted container, uppercase
 * language chip (tagged fences only), and a copy button (COPY_JS is injected
 * only on pages that contain one of these). Tagged fences get inline shiki
 * token colors; untagged (and unknown-language) fences stay neutral.
 */
function codeBlockHtml(code, infostring) {
  const tag = String(infostring ?? '').trim().split(/\s+/)[0].toLowerCase();
  const lang = CODE_LANG_ALIASES[tag] ?? tag;
  const pre = lang && highlighter.getLoadedLanguages().includes(lang)
    ? highlighter.codeToHtml(code, { lang, theme: CODE_THEME, colorReplacements: CODE_COLOR_REPLACEMENTS })
    : `<pre class="code-plain" tabindex="0"><code>${escapeHtml(code)}</code></pre>`;
  const chip = tag ? `<span class="code-lang">${escapeHtml(tag)}</span>` : '';
  return `<div class="code-block">
<div class="code-block-bar">${chip}<button class="code-copy" type="button" aria-label="Copy code to clipboard">Copy</button></div>
${pre}
</div>
`;
}

/** Resolve an internal link. Returns a href to keep, or null to unwrap. */
function resolveLink(href) {
  if (!href || !href.startsWith('/blog')) return href; // external / non-blog: pass through
  if (/^\/blog\/?$/.test(href)) return `${BASE}/`;
  const hub = href.match(/^\/blog\/topics\/([a-z0-9-]+)\/?$/);
  if (hub) return clusterSet.has(hub[1]) ? `${BASE}/topics/${hub[1]}/` : null;
  const art = href.match(/^\/blog\/([a-z0-9-]+)\/?(#[A-Za-z0-9-]*)?$/);
  if (art) return includedSlugs.has(art[1]) ? `${BASE}/${art[1]}/${art[2] ?? ''}` : null;
  return href; // deeper internal path (e.g. /blog/images/...) — pass through
}

function tokenPlainText(tokens) {
  return tokens.map((t) => {
    if (t.tokens) return tokenPlainText(t.tokens);
    return t.text ?? '';
  }).join('');
}

function createMarkdown() {
  const md = new Marked();
  md.use({
    renderer: {
      code(token) {
        return codeBlockHtml(token.text, token.lang);
      },
      heading(token) {
        const text = this.parser.parseInline(token.tokens);
        const plain = tokenPlainText(token.tokens).trim();
        const id = slugify(plain);
        const cls = token.depth === 3 && plain.endsWith('?') ? ' class="blog-faq-q"' : '';
        // Hover anchor on h2/h3 — stable, shareable deep links per section.
        const anchor = token.depth === 2 || token.depth === 3
          ? `<a class="hanchor" href="#${id}" aria-label="Link to section: ${escapeHtml(plain)}">#</a>`
          : '';
        return `<h${token.depth} id="${id}"${cls}>${text}${anchor}</h${token.depth}>\n`;
      },
      link(token) {
        const text = this.parser.parseInline(token.tokens);
        const href = resolveLink(token.href);
        if (href === null) return text; // unwrap — target not published yet
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        const external = /^https?:\/\//.test(href) && !href.startsWith(SITE_ORIGIN);
        const rel = external ? ' rel="noopener"' : '';
        return `<a href="${escapeHtml(href)}"${title}${rel}>${text}</a>`;
      },
    },
  });
  return md;
}

const md = createMarkdown();

function renderContent(markdown) {
  const html = md.parse(markdown);
  // Editorial tables scroll inside their own container on small screens.
  return html
    .replace(/<table>/g, '<div class="table-scroll"><table>')
    .replace(/<\/table>/g, '</table></div>');
}

/** h2 headings for the TOC (skips nothing — Sources/FAQ are part of the read). */
function extractH2s(markdown) {
  return md.lexer(markdown)
    .filter((t) => t.type === 'heading' && t.depth === 2)
    .map((t) => {
      const plain = tokenPlainText(t.tokens ?? []).trim() || t.text.trim();
      return { text: plain, id: slugify(plain) };
    });
}

/**
 * Sources extracted from the `## Sources` bullet list at the end of the
 * article body: [{ text, href }] in authored order. Numbering is 1-based
 * everywhere (src-1 … src-N anchors, [1] … [N] superscripts).
 */
function extractSources(markdown) {
  const tokens = md.lexer(markdown);
  let inSources = false;
  const out = [];
  const findLink = (tks) => {
    for (const t of tks ?? []) {
      if (t.type === 'link') return t;
      const nested = findLink(t.tokens);
      if (nested) return nested;
    }
    return null;
  };
  for (const t of tokens) {
    if (t.type === 'heading' && t.depth === 2) {
      inSources = /^sources$/i.test(t.text.trim());
      continue;
    }
    if (!inSources || t.type !== 'list') continue;
    for (const item of t.items) {
      out.push({
        text: tokenPlainText(item.tokens ?? []).trim(),
        href: findLink(item.tokens)?.href ?? null,
      });
    }
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Examine-style numbered citations (HTML pages only — the .md mirrors keep
 * the inline author-year links, which machines prefer):
 * - prose citations `([Lichtman et al., 1992](url))` whose url appears in the
 *   Sources list become superscript `[n]` anchors to `#src-n`, so a reader is
 *   never bounced off-site mid-paragraph;
 * - the `## Sources` bullet list becomes a numbered <ol> with `id="src-n"`
 *   targets carrying the outbound links.
 * Links NOT wrapped in parens (table Evidence cells, in-sentence links) are
 * left untouched.
 */
function applyCitations(markdown, sources) {
  let out = markdown;
  sources.forEach((s, i) => {
    if (!s.href) return;
    const n = i + 1;
    const re = new RegExp(`\\s*\\(\\[[^\\]]+\\]\\(${escapeRegExp(s.href)}\\)\\)`, 'g');
    out = out.replace(re, () =>
      `<sup class="article-cite"><a href="#src-${n}" title="${escapeHtml(s.text)}">${n}</a></sup>`);
  });
  const ol = `<ol class="article-sources">\n${sources.map((s, i) =>
    `<li id="src-${i + 1}">${s.href
      ? `<a href="${escapeHtml(s.href)}" rel="noopener">${escapeHtml(s.text)}</a>`
      : escapeHtml(s.text)}</li>`).join('\n')}\n</ol>`;
  out = out.replace(/(## Sources[ \t]*\n+)(?:-[ \t].+\n?)+/, (_m, heading) => `${heading}${ol}\n`);
  return out;
}

/** FAQ Q/A pairs for the FAQPage JSON-LD: `### …?` headings inside `## FAQ`. */
function extractFaq(markdown) {
  const tokens = md.lexer(markdown);
  const out = [];
  let inFaq = false;
  let current = null;
  for (const t of tokens) {
    if (t.type === 'heading' && t.depth === 2) {
      inFaq = /^faq$/i.test(t.text.trim());
      current = null;
      continue;
    }
    if (!inFaq) continue;
    if (t.type === 'heading' && t.depth === 3) {
      const q = tokenPlainText(t.tokens ?? []).trim() || t.text.trim();
      current = q.endsWith('?') ? { question: q, answer: '' } : null;
      if (current) out.push(current);
      continue;
    }
    if (current && t.type === 'paragraph') {
      const text = tokenPlainText(t.tokens ?? []).trim();
      current.answer = current.answer ? `${current.answer} ${text}` : text;
    }
  }
  return out.filter((f) => f.answer);
}

// ---------------------------------------------------------------------------
// Related articles: same pillar family → topics.json crossLinks → same cluster
// ---------------------------------------------------------------------------
function relatedArticles(article) {
  const picks = [];
  const seen = new Set([article.slug]);
  const add = (a) => {
    if (a && !seen.has(a.slug)) { seen.add(a.slug); picks.push(a); }
  };
  const bySlug = new Map(included.map((a) => [a.slug, a]));

  // 1. Same pillar family: shared pillar, the pillar itself, or our spokes.
  const pillar = article.pillar ?? topicBySlug.get(article.slug)?.pillar ?? null;
  if (pillar) add(bySlug.get(pillar));
  for (const a of included) {
    const otherPillar = a.pillar ?? topicBySlug.get(a.slug)?.pillar ?? null;
    if (pillar && otherPillar === pillar) add(a);
    if (otherPillar === article.slug) add(a); // we are their pillar
  }

  // 2. topics.json crossLinks (authored order).
  for (const slug of topicBySlug.get(article.slug)?.crossLinks ?? []) add(bySlug.get(slug));

  // 3. Same cluster, newest first.
  for (const a of included) if (a.cluster === article.cluster) add(a);

  return picks.slice(0, 3);
}

// ---------------------------------------------------------------------------
// HTML fragments
// ---------------------------------------------------------------------------
function clusterMeta(key) {
  const c = topics?.clusters?.[key];
  return {
    title: c?.title ?? titleCase(key),
    description: c?.description ?? '',
  };
}

let CSS_HREF = `${BASE}/blog.css`; // replaced with the content-hashed name in main()
let EDITORIAL_POLICY_BAKED = false; // set in main() before bakeSitemap()

/**
 * Waiting-list CTA banner — templates/banner.html injected verbatim on HTML
 * pages only (never the .md mirrors or llms.txt). Missing or empty file →
 * no banner anywhere (clean kill switch).
 */
const bannerPath = path.join(BLOG_DIR, 'templates', 'banner.html');
const BANNER_HTML = (() => {
  if (!fs.existsSync(bannerPath)) return '';
  const raw = fs.readFileSync(bannerPath, 'utf8').trim();
  return raw ? `${raw}\n` : '';
})();

function head({ title, description, canonical, ogType = 'website', ogImage = null, ldBlocks = [], markdownAlternate = null }) {
  const og = [
    `<meta property="og:type" content="${ogType}">`,
    `<meta property="og:site_name" content="aidemo">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
  ];
  if (ogImage) og.push(`<meta property="og:image" content="${escapeHtml(ogImage)}">`);
  const twitter = [
    `<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
  ];
  if (ogImage) twitter.push(`<meta name="twitter:image" content="${escapeHtml(ogImage)}">`);
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${escapeHtml(canonical)}">
${markdownAlternate ? `<link rel="alternate" type="text/markdown" href="${escapeHtml(markdownAlternate)}">\n` : ''}<link rel="stylesheet" href="${CSS_HREF}">
<link rel="alternate" type="application/rss+xml" title="aidemo blog" href="${SITE_ORIGIN}${BASE}/feed.xml">
${og.join('\n')}
${twitter.join('\n')}
${ldBlocks.map((b) => `<script type="application/ld+json">\n${b}\n</script>`).join('\n')}`;
}

function siteHeader() {
  return `<header class="site-header">
  <div class="site-header-inner">
    <a class="site-logo" href="${SITE_ORIGIN}/">ai<em>demo</em></a>
    <nav class="site-nav">
      <a href="${BASE}/">Blog</a>
      <a href="https://github.com/tandryukha/aidemo" rel="noopener">GitHub</a>
      <a href="${SITE_ORIGIN}/">Get started</a>
    </nav>
  </div>
</header>`;
}

function siteFooter() {
  const topicLinks = clusters
    .map((c) => `<a href="${BASE}/topics/${c}/">${escapeHtml(clusterMeta(c).title)}</a>`)
    .join('\n      ');
  return `<footer class="site-footer">
  <div class="site-footer-inner">
    <div class="site-footer-col">
      <span class="site-footer-brand">aidemo — your coding agent writes the storyboard; the engine renders the narrated, captioned demo video. MIT open source.</span>
      <nav class="site-footer-topics" aria-label="Topics">
      ${topicLinks}
      </nav>
    </div>
    <nav class="site-footer-links" aria-label="Site">
      <a href="${SITE_ORIGIN}/">aidemo.top</a>
      <a href="https://github.com/tandryukha/aidemo" rel="noopener">GitHub</a>
      <a href="${BASE}/editorial-policy/">Editorial policy</a>
      <a href="${BASE}/feed.xml">RSS</a>
      <a href="${BASE}/llms.txt">llms.txt</a>
    </nav>
  </div>
</footer>`;
}

function page({ lang = 'en', headHtml, bodyHtml }) {
  return `<!doctype html>
<html lang="${lang}">
<head>
${headHtml}
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

function cardHtml(article) {
  const { title: clusterTitle } = clusterMeta(article.cluster);
  return `<a class="article-card" href="${BASE}/${article.slug}/">
  ${cardImageHtml(article)}
  <div class="article-card-content">
    <div class="article-card-category">${escapeHtml(clusterTitle)}</div>
    <h3 class="article-card-title">${escapeHtml(article.title)}</h3>
    <p class="article-card-excerpt">${escapeHtml(article.excerpt)}</p>
    <div class="article-card-meta"><span>${prettyDate(article.publishedAt)}</span><span>${article.readingTimeMinutes} min read</span></div>
  </div>
</a>`;
}

function featuredCardHtml(article) {
  const { title: clusterTitle } = clusterMeta(article.cluster);
  return `<section class="blog-featured">
<a class="blog-featured-card" href="${BASE}/${article.slug}/">
  ${cardImageHtml(article, { featured: true })}
  <div class="blog-featured-content">
    <div class="blog-featured-category">${escapeHtml(clusterTitle)}</div>
    <h2 class="blog-featured-title">${escapeHtml(article.title)}</h2>
    <p class="blog-featured-excerpt">${escapeHtml(article.excerpt)}</p>
    <div class="blog-featured-meta"><span>${prettyDate(article.publishedAt)}</span><span>${article.readingTimeMinutes} min read</span></div>
  </div>
</a>
</section>`;
}

function clusterTabsHtml(activeKey = null) {
  if (!clusters.length) return '';
  const tabs = [
    `<a class="blog-category-tab${activeKey === null ? ' active' : ''}" href="${BASE}/">All</a>`,
    ...clusters.map((c) => `<a class="blog-category-tab${c === activeKey ? ' active' : ''}" href="${BASE}/topics/${c}/">${escapeHtml(clusterMeta(c).title)}</a>`),
  ];
  return `<nav class="blog-category-tabs" aria-label="Topics">\n${tabs.join('\n')}\n</nav>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
function bakeIndex() {
  const [featured, ...rest] = included;
  const canonical = `${SITE_ORIGIN}${BASE}/`;
  const description = 'Practical, evidence-backed writing on product demo videos — scripting, recording, automating, and keeping them fresh — from the team behind aidemo, the open-source demo engine for coding agents.';
  const ld = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'aidemo blog',
    url: canonical,
    description,
    publisher: { '@type': 'Organization', name: 'aidemo', url: SITE_ORIGIN },
  });
  const body = `${siteHeader()}
<main class="blog-page">
  <div class="blog-header">
    <h1>The aidemo blog</h1>
    <p>${escapeHtml(description)}</p>
  </div>
  ${clusterTabsHtml(null)}
  ${featured ? featuredCardHtml(featured) : '<p>No articles published yet — check back soon.</p>'}
  <div class="blog-grid">
${rest.map(cardHtml).join('\n')}
  </div>
${BANNER_HTML}</main>
${siteFooter()}`;
  writePage('index.html', page({
    headHtml: head({ title: 'aidemo blog — product demo videos, automated', description, canonical, ldBlocks: [ld] }),
    bodyHtml: body,
  }));
}

function bakeHub(cluster) {
  const meta = clusterMeta(cluster);
  const inCluster = included.filter((a) => a.cluster === cluster);
  const isPillar = (a) => {
    const role = topicBySlug.get(a.slug)?.role;
    if (role) return role === 'pillar';
    return a.pillar === null || a.pillar === undefined;
  };
  const pillars = inCluster.filter(isPillar);
  const spokes = inCluster.filter((a) => !isPillar(a));
  const canonical = `${SITE_ORIGIN}${BASE}/topics/${cluster}/`;
  const description = meta.description || `Articles about ${meta.title.toLowerCase()} from the aidemo project.`;
  const ld = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${meta.title} — aidemo blog`,
    url: canonical,
    description,
    isPartOf: { '@type': 'Blog', name: 'aidemo blog', url: `${SITE_ORIGIN}${BASE}/` },
  });
  const body = `${siteHeader()}
<main class="blog-page">
  <div class="hub-header">
    <div class="hub-eyebrow">Topic</div>
    <h1>${escapeHtml(meta.title)}</h1>
    ${meta.description ? `<p>${escapeHtml(meta.description)}</p>` : ''}
  </div>
  ${clusterTabsHtml(cluster)}
  ${pillars.map(featuredCardHtml).join('\n')}
  ${spokes.length ? `<div class="hub-section-title">More on ${escapeHtml(meta.title)}</div>\n<div class="blog-grid">\n${spokes.map(cardHtml).join('\n')}\n</div>` : ''}
${BANNER_HTML}</main>
${siteFooter()}`;
  writePage(path.join('topics', cluster, 'index.html'), page({
    headHtml: head({ title: `${meta.title} | aidemo blog`, description, canonical, ldBlocks: [ld] }),
    bodyHtml: body,
  }));
}

const SCROLL_SPY_JS = `(function () {
  var fill = document.querySelector('.article-progress-fill');
  if (fill) {
    var paint = function () {
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      fill.style.width = (max > 0 ? Math.min(1, window.scrollY / max) * 100 : 0) + '%';
    };
    window.addEventListener('scroll', paint, { passive: true });
    window.addEventListener('resize', paint, { passive: true });
    paint();
  }
  var items = {};
  document.querySelectorAll('.article-sidebar .article-toc-item').forEach(function (li) {
    var a = li.querySelector('.article-toc-link');
    if (a) items[a.getAttribute('href').slice(1)] = li;
  });
  var headings = Array.prototype.slice.call(document.querySelectorAll('.article-content h2[id]'));
  if (!headings.length || !('IntersectionObserver' in window)) return;
  var current = null;
  function activate(id) {
    if (current === id) return;
    current = id;
    Object.keys(items).forEach(function (k) { items[k].classList.toggle('active', k === id); });
  }
  var observer = new IntersectionObserver(function () {
    var y = window.scrollY + 120;
    var active = headings[0].id;
    headings.forEach(function (h) { if (h.offsetTop <= y) active = h.id; });
    activate(active);
  }, { rootMargin: '0px 0px -60% 0px', threshold: [0, 1] });
  headings.forEach(function (h) { observer.observe(h); });
  window.addEventListener('scroll', function () {
    var y = window.scrollY + 120;
    var active = headings[0].id;
    headings.forEach(function (h) { if (h.offsetTop <= y) active = h.id; });
    activate(active);
  }, { passive: true });
})();`;

/** Per-code-block copy button. Clipboard API only; buttons hide when absent. */
const COPY_JS = `(function () {
  var btns = document.querySelectorAll('.code-copy');
  if (!navigator.clipboard || !window.isSecureContext) {
    btns.forEach(function (b) { b.hidden = true; });
    return;
  }
  btns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.closest('.code-block').querySelector('code');
      if (!code) return;
      navigator.clipboard.writeText(code.innerText).then(function () {
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1600);
      }, function () {});
    });
  });
})();`;

function bakeArticle(article) {
  const meta = clusterMeta(article.cluster);
  const canonical = `${SITE_ORIGIN}${BASE}/${article.slug}/`;
  const files = heroFiles(article.slug);
  const ogImage = files.w800 ? `${SITE_ORIGIN}${BASE}/images/${article.slug}-800.webp`
    : files.w400 ? `${SITE_ORIGIN}${BASE}/images/${article.slug}-400.webp` : null;

  const sources = extractSources(article.content);
  const contentHtml = renderContent(applyCitations(article.content, sources));
  const toc = extractH2s(article.content);
  const faq = extractFaq(article.content);
  if (!files.w400 && !files.w800) {
    console.warn(`warn: ${article.slug} has no hero image — cards use the styled no-image tile (fine until an image lane exists)`);
  }

  const ldArticle = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.seoDescription,
    ...(ogImage ? { image: [ogImage] } : {}),
    datePublished: article.publishedAt,
    dateModified: article.updatedAt,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    wordCount: article.content.trim().split(/\s+/).length,
    author: { '@type': 'Organization', name: 'aidemo', url: SITE_ORIGIN },
    publisher: { '@type': 'Organization', name: 'aidemo', url: SITE_ORIGIN },
    ...(sources.some((s) => s.href) ? {
      citation: sources.filter((s) => s.href)
        .map((s) => ({ '@type': 'CreativeWork', name: s.text, url: s.href })),
    } : {}),
  });
  const ldBreadcrumb = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Blog', item: `${SITE_ORIGIN}${BASE}/` },
      { '@type': 'ListItem', position: 2, name: meta.title, item: `${SITE_ORIGIN}${BASE}/topics/${article.cluster}/` },
      { '@type': 'ListItem', position: 3, name: article.title, item: canonical },
    ],
  });
  const ldBlocks = [ldArticle, ldBreadcrumb];
  if (faq.length) {
    ldBlocks.push(jsonLd({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer },
      })),
    }));
  }

  const heroCaption = article.hero?.caption?.trim();
  const heroHtml = (files.w400 || files.w800)
    ? `<figure class="article-hero"><img src="${BASE}/images/${article.slug}-${files.w800 ? 800 : 400}.webp" srcset="${heroSrcset(article.slug, files)}" sizes="(max-width: 900px) 100vw, 840px" width="1216" height="832" alt="${escapeHtml(article.hero?.alt ?? article.title)}">${heroCaption ? `<figcaption>${escapeHtml(heroCaption)}</figcaption>` : ''}</figure>`
    : '';

  // Key takeaways — answer-first summary card (Healthline/Examine pattern);
  // also the block search snippets and LLMs lift verbatim.
  const takeaways = (article.keyTakeaways ?? []).filter((t) => String(t).trim());
  const takeawaysHtml = takeaways.length ? `<aside class="article-takeaways" aria-labelledby="key-takeaways-label">
  <div class="article-takeaways-title" id="key-takeaways-label">Key takeaways</div>
  <ul>
${takeaways.map((t) => `    <li>${escapeHtml(t)}</li>`).join('\n')}
  </ul>
</aside>` : '';

  const tocLinks = toc.map((h) => `<li class="article-toc-item"><a class="article-toc-link" href="#${h.id}">${escapeHtml(h.text)}</a></li>`);
  const tocHtml = toc.length ? `<aside class="article-sidebar">
  <nav class="article-toc" aria-label="Table of contents">
    <div class="article-toc-title">On this page</div>
    <ul class="article-toc-list">
${tocLinks.map((l) => `      ${l}`).join('\n')}
    </ul>
  </nav>
</aside>` : '<aside class="article-sidebar" hidden></aside>';

  // Same TOC as a collapsible block for narrow viewports (sidebar is hidden there).
  const tocMobileHtml = toc.length ? `<details class="article-toc-mobile">
  <summary>On this page</summary>
  <ul>
${tocLinks.map((l) => `    ${l}`).join('\n')}
  </ul>
</details>` : '';

  const related = relatedArticles(article);
  const relatedHtml = related.length ? `<section class="related-articles">
  <h2>Keep reading</h2>
  <div class="related-articles-grid">
${related.map(cardHtml).join('\n')}
  </div>
</section>` : '';

  const updatedHtml = article.updatedAt && article.updatedAt !== article.publishedAt
    ? `<span class="dot">&middot;</span>Updated <time datetime="${article.updatedAt}">${prettyDate(article.updatedAt)}</time>`
    : '';
  const linkedSources = sources.filter((s) => s.href).length;
  const badgeHtml = linkedSources >= 3
    ? `<a class="article-badge" href="#sources">Evidence-based &middot; ${linkedSources} sources</a>`
    : '';

  const body = `${siteHeader()}
<div class="article-progress" aria-hidden="true"><div class="article-progress-fill"></div></div>
<main class="article-page">
  <nav class="article-breadcrumb" aria-label="Breadcrumb">
    <a href="${BASE}/">Blog</a><span class="sep">/</span><a href="${BASE}/topics/${article.cluster}/">${escapeHtml(meta.title)}</a><span class="sep">/</span><span>${escapeHtml(article.title)}</span>
  </nav>
  <div class="article-layout">
    <article class="article-main">
      <header class="article-header">
        <a class="article-category" href="${BASE}/topics/${article.cluster}/">${escapeHtml(meta.title)}</a>
        <h1 class="article-title">${escapeHtml(article.title)}</h1>
        <p class="article-dek">${escapeHtml(article.excerpt)}</p>
        <div class="article-meta">
          <span class="article-meta-line">By <a href="${BASE}/editorial-policy/">the aidemo maintainers</a><span class="dot">&middot;</span><time datetime="${article.publishedAt}">${prettyDate(article.publishedAt)}</time>${updatedHtml}<span class="dot">&middot;</span>${article.readingTimeMinutes} min read</span>
          ${badgeHtml}
        </div>
      </header>
      ${tocMobileHtml}
      ${heroHtml}
      ${takeawaysHtml}
      <div class="article-content">
${contentHtml}
      </div>
      <p class="article-ai-disclosure">${escapeHtml(AI_DISCLOSURE)} <a href="${BASE}/editorial-policy/">How we research and correct our articles &rarr;</a></p>
      <div class="article-tags">
${(article.tags ?? []).map((t) => `        <span class="article-tag">${escapeHtml(t)}</span>`).join('\n')}
      </div>
      ${BANNER_HTML}${relatedHtml}
    </article>
    ${tocHtml}
  </div>
</main>
${siteFooter()}
<script>
${SCROLL_SPY_JS}${contentHtml.includes('class="code-block"') ? `\n${COPY_JS}` : ''}
</script>`;

  writePage(path.join(article.slug, 'index.html'), page({
    headHtml: head({
      title: article.seoTitle || article.title,
      description: article.seoDescription,
      canonical,
      ogType: 'article',
      ogImage,
      ldBlocks,
      markdownAlternate: `${BASE}/${article.slug}/index.md`,
    }),
    bodyHtml: body,
  }));
}

// ---------------------------------------------------------------------------
// LLM-friendly outputs: raw-markdown mirrors + llms.txt (https://llmstxt.org)
// ---------------------------------------------------------------------------

/** dist/{slug}/index.md — the article as plain markdown, body verbatim. */
function bakeMarkdownMirror(article) {
  const meta = clusterMeta(article.cluster);
  const canonical = `${SITE_ORIGIN}${BASE}/${article.slug}/`;
  const takeaways = (article.keyTakeaways ?? []).filter((t) => String(t).trim());
  const takeawaysMd = takeaways.length
    ? `\n**Key takeaways**\n\n${takeaways.map((t) => `- ${t}`).join('\n')}\n`
    : '';
  const md = `# ${article.title}

${prettyDate(article.publishedAt)} · ${meta.title} · ${article.readingTimeMinutes} min read · ${canonical}

> ${article.excerpt}
${takeawaysMd}
${article.content.trim()}
`;
  writePage(path.join(article.slug, 'index.md'), md);
}

/**
 * dist/llms-full.txt — the entire corpus as one markdown document, so an
 * agent can ingest everything in a single fetch (llms.txt companion file).
 */
function bakeLlmsFullTxt() {
  const parts = [
    '# aidemo blog — full corpus',
    '',
    '> Every published article, concatenated as markdown. Per-article mirrors live at the .md URL next to each canonical URL below.',
  ];
  for (const a of included) {
    const meta = clusterMeta(a.cluster);
    parts.push(
      '',
      '---',
      '',
      `# ${a.title}`,
      '',
      `${prettyDate(a.publishedAt)} · ${meta.title} · ${SITE_ORIGIN}${BASE}/${a.slug}/`,
      '',
      `> ${a.excerpt}`,
      '',
      a.content.trim(),
    );
  }
  parts.push('');
  writePage('llms-full.txt', parts.join('\n'));
}

/** dist/llms.txt — index of the markdown mirrors, grouped by cluster. */
function bakeLlmsTxt() {
  const lines = [
    '# aidemo blog',
    '',
    '> Practical, evidence-backed articles on product demo videos — scripting, recording, automation, AI tooling, and demos-as-code — from the team behind aidemo, the open-source engine that turns an agent-authored storyboard into a narrated, captioned demo video.',
    '',
    'Every article is available as raw markdown at the .md URLs below (the .md suffix on any article URL).',
  ];
  for (const cluster of clusters) {
    lines.push('', `## ${clusterMeta(cluster).title}`, '');
    for (const a of included.filter((x) => x.cluster === cluster)) {
      lines.push(`- [${a.title}](${SITE_ORIGIN}${BASE}/${a.slug}/index.md): ${a.excerpt}`);
    }
  }
  lines.push(
    '',
    '## Optional',
    '',
    `- [Full corpus, one file](${SITE_ORIGIN}${BASE}/llms-full.txt): every article concatenated as markdown`,
    `- [Editorial policy](${SITE_ORIGIN}${BASE}/editorial-policy/): how articles are researched, cited, and corrected`,
    `- [Blog home (HTML)](${SITE_ORIGIN}${BASE}/)`,
    `- [Sitemap](${SITE_ORIGIN}${BASE}/sitemap.xml)`,
    '',
  );
  writePage('llms.txt', lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Editorial-policy page — the E-E-A-T accountability page linked from every
// byline, AI disclosure, and the footer. Content: templates/editorial-policy.md
// (first `# heading` becomes the title; absent file → page not baked).
// ---------------------------------------------------------------------------
function bakeEditorialPolicy() {
  const src = path.join(BLOG_DIR, 'templates', 'editorial-policy.md');
  if (!fs.existsSync(src)) return false;
  const raw = fs.readFileSync(src, 'utf8').trim();
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Editorial policy';
  const bodyMd = titleMatch ? raw.replace(titleMatch[0], '').trim() : raw;
  const canonical = `${SITE_ORIGIN}${BASE}/editorial-policy/`;
  const description = 'How aidemo blog articles are researched, written, reviewed, and corrected — evidence standards, AI-assistance disclosure, and how to file corrections.';
  const ld = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: `${title} — aidemo blog`,
    url: canonical,
    description,
    publisher: { '@type': 'Organization', name: 'aidemo', url: SITE_ORIGIN },
  });
  const policyHtml = renderContent(bodyMd);
  const body = `${siteHeader()}
<main class="article-page">
  <nav class="article-breadcrumb" aria-label="Breadcrumb">
    <a href="${BASE}/">Blog</a><span class="sep">/</span><span>${escapeHtml(title)}</span>
  </nav>
  <div class="article-layout">
    <article class="article-main">
      <header class="article-header">
        <h1 class="article-title">${escapeHtml(title)}</h1>
      </header>
      <div class="article-content article-content--plain">
${policyHtml}
      </div>
    </article>
    <aside class="article-sidebar" hidden></aside>
  </div>
</main>
${siteFooter()}${policyHtml.includes('class="code-block"') ? `\n<script>\n${COPY_JS}\n</script>` : ''}`;
  writePage(path.join('editorial-policy', 'index.html'), page({
    headHtml: head({ title: `${title} | aidemo blog`, description, canonical, ldBlocks: [ld] }),
    bodyHtml: body,
  }));
  return true;
}

// ---------------------------------------------------------------------------
// Feeds (robots.txt is owned by the site root — docs/robots.txt — not the blog)
// ---------------------------------------------------------------------------
function bakeSitemap() {
  const maxUpdated = (list) => list.map((a) => a.updatedAt).sort().at(-1);
  const urls = [
    { loc: `${SITE_ORIGIN}${BASE}/`, lastmod: maxUpdated(included) },
    ...(EDITORIAL_POLICY_BAKED
      ? [{ loc: `${SITE_ORIGIN}${BASE}/editorial-policy/`, lastmod: maxUpdated(included) }]
      : []),
    ...clusters.map((c) => ({
      loc: `${SITE_ORIGIN}${BASE}/topics/${c}/`,
      lastmod: maxUpdated(included.filter((a) => a.cluster === c)),
    })),
    ...included.map((a) => ({ loc: `${SITE_ORIGIN}${BASE}/${a.slug}/`, lastmod: a.updatedAt })),
  ].filter((u) => u.lastmod);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escapeXml(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;
  writePage('sitemap.xml', xml);
}

function bakeFeed() {
  const items = included.slice(0, 30).map((a) => `    <item>
      <title>${escapeXml(a.title)}</title>
      <link>${SITE_ORIGIN}${BASE}/${a.slug}/</link>
      <guid isPermaLink="true">${SITE_ORIGIN}${BASE}/${a.slug}/</guid>
      <pubDate>${rssDate(a.publishedAt)}</pubDate>
      <description>${escapeXml(a.excerpt)}</description>
    </item>`).join('\n');
  const newest = included[0];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>aidemo blog</title>
    <link>${SITE_ORIGIN}${BASE}/</link>
    <atom:link href="${SITE_ORIGIN}${BASE}/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Practical, evidence-backed writing on product demo videos and demo automation.</description>
    <language>en</language>
${newest ? `    <lastBuildDate>${rssDate(newest.publishedAt)}</lastBuildDate>` : ''}
${items}
  </channel>
</rss>
`;
  writePage('feed.xml', xml);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function writePage(rel, content) {
  const full = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Stylesheet — content-hashed because prod nginx serves *.css as immutable/1y.
  // Deterministic: same CSS bytes → same hashed filename. HTML is no-cache, so
  // pages always reference the current hash. (Hero images keep stable names.)
  const cssSource = path.join(BLOG_DIR, 'templates', 'blog.css');
  const css = fs.readFileSync(cssSource, 'utf8');
  const hash = crypto.createHash('sha256').update(css).digest('hex').slice(0, 8);
  const cssName = `blog.${hash}.css`;
  CSS_HREF = `${BASE}/${cssName}`;
  writePage(cssName, css);

  if (fs.existsSync(imagesDir)) {
    fs.cpSync(imagesDir, path.join(OUT_DIR, 'images'), { recursive: true });
  }

  bakeIndex();
  for (const cluster of clusters) bakeHub(cluster);
  for (const article of included) {
    bakeArticle(article);
    bakeMarkdownMirror(article);
  }
  EDITORIAL_POLICY_BAKED = bakeEditorialPolicy();
  bakeSitemap();
  bakeFeed();
  bakeLlmsTxt();
  bakeLlmsFullTxt();

  console.log(`baked ${included.length} article(s), ${clusters.length} hub(s) → ${OUT_DIR}`);
  console.log(`  stylesheet: ${cssName}`);
  if (includeDrafts) {
    const drafts = included.filter((a) => a.status === 'draft').length;
    if (drafts) console.log(`  note: --drafts included ${drafts} draft(s) — do not deploy this output`);
  }
}

main();

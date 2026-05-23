/**
 * internal-link-planner.js — finds anchor opportunities for a newly
 * published target URL across the Astro content corpus.
 *
 * For each target page, scan sibling pages for:
 *   - first unlinked mention of the target's primary keyword
 *   - first unlinked mention of "{service} in {city}" / "{city} {service}"
 *
 * Skip rules:
 *   - already linked (matched text is inside [text](url))
 *   - inside fenced code block (``` … ```)
 *   - inside YAML frontmatter (--- … ---)
 *   - inside HTML comment (<!-- … -->)
 *   - already links to the SAME target_url somewhere on the page
 *
 * Per-page cap: at most ONE new link per source page per target.
 * Site-wide cap: at most N new links per planning run.
 *
 * Pure functions. The runner (Step 11) takes the planned edits and
 * opens an Astro PR via github-client (out of scope here).
 */

const fs = require('fs');
const path = require('path');
const { CITIES } = require('./scoring-config');

const DEFAULT_LINK_CAP = 5; // per planning run
const DEFAULT_PER_PAGE_CAP = 1; // per source file per target URL

// ── anchor candidates (pure) ─────────────────────────────────────────

/**
 * Generate ranked anchor-text candidates for a target page.
 *
 *   target = { url, keyword, city, service, title }
 *
 * Returns [{ phrase, priority }] sorted by priority desc. Phrases are
 * matched case-insensitively against source page bodies; first
 * occurrence wins.
 */
function anchorCandidates(target) {
  const out = [];
  if (target.keyword) out.push({ phrase: target.keyword, priority: 10 });
  if (target.city && target.service) {
    const city = target.city;
    const service = target.service;
    out.push({ phrase: `${service} in ${city}`, priority: 9 });
    out.push({ phrase: `${city} ${service}`, priority: 8 });
  }
  if (target.title) out.push({ phrase: target.title, priority: 5 });
  // De-dupe by lowercased phrase.
  const seen = new Set();
  return out.filter(({ phrase }) => {
    const k = phrase.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── corpus scanner ──────────────────────────────────────────────────

/**
 * Strip regions that must NOT be searched for matches:
 *   - YAML frontmatter at top of file (--- … ---)
 *   - fenced code blocks (``` … ```)
 *   - HTML comments (<!-- … -->)
 *   - existing markdown links/reference definitions
 *
 * Returns the body with those regions replaced by spaces of the same
 * length, so character offsets in the result line up 1:1 with the
 * source — important for application of edits later.
 */
function maskExcludedRegions(text) {
  let s = String(text || '');
  // Frontmatter at the very top.
  s = s.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/, (m) => ' '.repeat(m.length));
  // Fenced code blocks.
  s = s.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));
  // HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  // Markdown links and reference definitions. This masks both labels
  // and destinations; otherwise short anchors can match inside hrefs
  // like [details](/termite-control-sarasota/) and corrupt the URL.
  s = s.replace(/\[[^\]\n]+\]\(\s*(?:<[^>\n]+>|[^\n)]*)\)/g, (m) => ' '.repeat(m.length));
  s = s.replace(/\[[^\]\n]+\]\[[^\]\n]*\]/g, (m) => ' '.repeat(m.length));
  s = s.replace(/^\s{0,3}\[[^\]\n]+\]:\s*(?:<[^>\n]+>|[^\s]+)(?:\s+.*)?$/gm, (m) => ' '.repeat(m.length));
  return s;
}

/**
 * Find the FIRST occurrence of `phrase` in `text` that is NOT already
 * inside a markdown or HTML link. Returns { index, length, snippet }
 * or null.
 */
function findFirstUnlinkedOccurrence(text, phrase) {
  if (!text || !phrase) return null;
  const masked = maskExcludedRegions(text);
  // Require word boundaries — raw indexOf matched short keywords like
  // "ant" inside "plant" or "pest" inside "pesticide" and corrupted
  // the rendered markdown when applyTaskToBody wrapped the partial.
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'gi');
  let m;
  while ((m = re.exec(masked)) !== null) {
    const idx = m.index;
    const length = m[0].length;
    if (isInsideLink(masked, idx, idx + length)) continue;
    return {
      index: idx,
      length,
      snippet: snippetAround(text, idx, length),
    };
  }
  return null;
}

/**
 * Is the [start, end) range inside an existing markdown link [text](url)
 * or HTML anchor <a … >…</a>?
 */
function isInsideLink(text, start, end) {
  // Markdown link: [foo](bar). The match must NOT be inside the [foo]
  // span. We do a quick scan for the nearest unclosed '[' before start.
  for (let i = start - 1; i >= 0 && i >= start - 250; i--) {
    const ch = text[i];
    if (ch === ']' || ch === '\n') break; // closed bracket or line break — not inside
    if (ch === '[') {
      // Look forward from start for inline `[text](url)` or
      // reference-style `[text][id]` link syntax.
      const rest = text.slice(end, end + 250);
      if (/^[^\n\]]*\](?:\(|\[[^\]\n]*\])/.test(rest)) return true;
      break;
    }
  }
  // HTML anchor: <a … >match</a>. Quick scan for unclosed <a.
  const upToEnd = text.slice(Math.max(0, start - 300), end);
  const lastOpen = upToEnd.lastIndexOf('<a ');
  const lastClose = upToEnd.lastIndexOf('</a>');
  if (lastOpen > lastClose) return true;
  return false;
}

function snippetAround(text, start, length, padding = 50) {
  const s = Math.max(0, start - padding);
  const e = Math.min(text.length, start + length + padding);
  const out = text.slice(s, e).replace(/\s+/g, ' ').trim();
  return (s > 0 ? '…' : '') + out + (e < text.length ? '…' : '');
}

/**
 * Does the page already contain a markdown link whose href matches
 * (case-insensitively) the target URL? If so we skip — over-linking
 * to the same target hurts.
 */
function pageAlreadyLinksTo(text, targetUrl) {
  if (!text || !targetUrl) return false;
  const target = normalizePath(targetUrl);
  if (!target) return false;
  const mdLink = /\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  let m;
  while ((m = mdLink.exec(text)) !== null) {
    if (normalizePath(unwrapAngleHref(m[1])) === target) return true;
  }
  const refDef = /^\s{0,3}\[[^\]\n]+\]:\s*(<[^>]+>|[^\s]+)(?:\s+.*)?$/gm;
  while ((m = refDef.exec(text)) !== null) {
    if (normalizePath(unwrapAngleHref(m[1])) === target) return true;
  }
  const href = /href=["']([^"']+)["']/g;
  while ((m = href.exec(text)) !== null) {
    if (normalizePath(m[1]) === target) return true;
  }
  return false;
}

function unwrapAngleHref(href) {
  const s = String(href || '').trim();
  return s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
}

/**
 * Canonical comparison form for a URL or href — strips host, query,
 * hash, trailing slashes, and lowercases. Without query/hash
 * stripping, a page already linking to /pest-control-bradenton-fl#faq
 * wasn't recognized as covering target /pest-control-bradenton-fl/.
 */
function normalizePath(url) {
  return String(url || '')
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// ── main planner ────────────────────────────────────────────────────

class InternalLinkPlanner {
  /**
   * planForTarget(target, { corpus, opportunityId, cap, perPageCap })
   *
   * target: { url, keyword, city, service, title }
   * corpus: [{ file, body, url? }] — caller is responsible for loading
   *   Astro pages into memory. Pass [] to no-op.
   * opportunityId: optional UUID for trace.
   * cap: site-wide max new links (default 5).
   * perPageCap: max new links per source file (default 1).
   *
   * Returns [{ source_file, target_url, anchor_text, context_snippet,
   *            source_offset, opportunity_id }]
   */
  planForTarget(target, { corpus = [], opportunityId = null, cap = DEFAULT_LINK_CAP, perPageCap = DEFAULT_PER_PAGE_CAP } = {}) {
    if (!target?.url) return [];
    const candidates = anchorCandidates(target);
    if (!candidates.length) return [];

    const targetPath = canonicalInternalPath(target.url);
    if (!targetPath) return [];
    const tasks = [];
    const perFileCount = new Map();

    for (const page of corpus) {
      if (tasks.length >= cap) break;
      if (sameUrl(page.url, targetPath)) continue; // never link page to itself
      if (pageAlreadyLinksTo(page.body, targetPath)) continue;

      for (const { phrase } of candidates) {
        if ((perFileCount.get(page.file) || 0) >= perPageCap) break;
        const occ = findFirstUnlinkedOccurrence(page.body, phrase);
        if (!occ) continue;
        // Preserve the original casing from the matched text rather
        // than the candidate phrase.
        const actualAnchor = page.body.slice(occ.index, occ.index + occ.length);
        tasks.push({
          source_file: page.file,
          target_url: targetPath,
          anchor_text: actualAnchor,
          context_snippet: occ.snippet,
          source_offset: occ.index,
          opportunity_id: opportunityId,
        });
        perFileCount.set(page.file, (perFileCount.get(page.file) || 0) + 1);
        break; // only one anchor per page per target
      }
    }
    return tasks;
  }

  /**
   * Apply a planned task to a body string and return the patched body.
   * Re-locates the phrase before replacing (in case the file changed
   * since planning) so offsets aren't load-bearing.
   */
  applyTaskToBody(body, task) {
    if (!body || !task) return body;
    const occ = findFirstUnlinkedOccurrence(body, task.anchor_text);
    if (!occ) return body;
    const anchor = body.slice(occ.index, occ.index + occ.length);
    const replacement = `[${anchor}](${task.target_url})`;
    return body.slice(0, occ.index) + replacement + body.slice(occ.index + occ.length);
  }

  /**
   * Load Astro pages from a local clone. Walks src/content/{blog,
   * services, locations} and returns [{ file, body, url? }].
   * Convenience for CLI usage; the runner can also pass a corpus
   * loaded via github-client.
   */
  loadAstroCorpus(astroRoot, { collections = ['blog', 'services', 'locations'] } = {}) {
    const out = [];
    for (const c of collections) {
      const dir = path.join(astroRoot, 'src', 'content', c);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!/\.mdx?$/.test(file)) continue;
        const full = path.join(dir, file);
        const body = fs.readFileSync(full, 'utf8');
        out.push({
          file: path.relative(astroRoot, full),
          body,
          url: deriveUrlFromFile(c, file, body),
        });
      }
    }
    return out;
  }
}

// ── url helpers ─────────────────────────────────────────────────────

function stripHost(url) {
  return String(url || '').replace(/^https?:\/\/[^/]+/, '');
}

function sameUrl(a, b) {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}

function canonicalInternalPath(url) {
  const p = normalizePath(url);
  if (!p) return '';
  return `${p}/`;
}

function deriveUrlFromFile(collection, file, body = '') {
  const slug = extractFrontmatterSlug(body);
  if (slug) return slug;
  const base = file.replace(/\.mdx?$/, '');
  if (collection === 'blog') return `/blog/${base}/`;
  return `/${base}/`;
}

function extractFrontmatterSlug(body) {
  const m = String(body || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const slugLine = m[1].match(/^\s*slug\s*:\s*(.+?)\s*$/m);
  if (!slugLine) return null;
  let slug = slugLine[1].trim();
  if (slug.startsWith('"') || slug.startsWith("'")) {
    const q = slug[0];
    const end = slug.indexOf(q, 1);
    if (end !== -1) slug = slug.slice(1, end).trim();
  } else {
    slug = slug.replace(/\s+#.*$/, '').trim();
  }
  if (!slug) return null;
  if (!slug.startsWith('/')) slug = `/${slug}`;
  if (!slug.endsWith('/')) slug += '/';
  return slug;
}

module.exports = new InternalLinkPlanner();
module.exports.InternalLinkPlanner = InternalLinkPlanner;
module.exports._internals = {
  DEFAULT_LINK_CAP,
  DEFAULT_PER_PAGE_CAP,
  anchorCandidates,
  maskExcludedRegions,
  findFirstUnlinkedOccurrence,
  isInsideLink,
  snippetAround,
  pageAlreadyLinksTo,
  unwrapAngleHref,
  normalizePath,
  canonicalInternalPath,
  stripHost,
  sameUrl,
  deriveUrlFromFile,
  extractFrontmatterSlug,
};

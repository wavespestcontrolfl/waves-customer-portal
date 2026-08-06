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
const GitHubClient = require('../content-astro/github-client');
const fm = require('../content-astro/frontmatter');
const policy = require('./internal-link-seo-policy');
const { CITIES } = require('./scoring-config');

const DEFAULT_LINK_CAP = 5; // per planning run
const DEFAULT_PER_PAGE_CAP = 1; // per source file per target URL
// Mirrors the executor's source_link_density_high default — a source above
// it is rejected at execution, so planning it would burn a cap slot.
const DEFAULT_MAX_SOURCE_CONTEXTUAL_LINKS = 30;
const ALLOWED_SITE_HOSTS = new Set(['www.wavespestcontrol.com', 'wavespestcontrol.com']);
const INLINE_MARKDOWN_LINK_RE = /\[[^\]\n]+\]\(\s*(?:<[^>\n]+>|(?:[^\s()\n]+|\([^()\n]*\))*)(?:\s+[^)]*)?\)/g;
const SERVICE_ANCHOR_ALIASES = {
  pest: 'pest control',
  termite: 'termite control',
  mosquito: 'mosquito control',
  rodent: 'rodent control',
  lawn: 'lawn care',
  tree_shrub: 'tree and shrub care',
  'tree-shrub': 'tree and shrub care',
  specialty: 'pest control',
};

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
    const service = serviceAnchorPhrase(target.service);
    out.push({ phrase: `${service} in ${city}`, priority: 9 });
    out.push({ phrase: `${city} ${service}`, priority: 8 });
  }
  for (const segment of keywordSegments(target.keyword)) {
    out.push({ phrase: segment, priority: 7 });
  }
  if (target.title) out.push({ phrase: target.title, priority: 5 });
  // De-dupe by lowercased phrase, and drop candidates the executor's anchor
  // policy is guaranteed to reject (too long, sentence punctuation, generic).
  // The planner commits to the FIRST matching phrase per page, so a doomed
  // high-priority candidate (e.g. a 9-word comparison keyword) would
  // otherwise shadow a workable lower-priority segment on the same page.
  const seen = new Set();
  return out.filter(({ phrase }) => {
    const k = phrase.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return policy.validateAnchorPolicy(phrase).ok;
  });
}

function serviceAnchorPhrase(service) {
  const normalized = String(service || '').trim().toLowerCase().replace(/\s+/g, '_');
  return SERVICE_ANCHOR_ALIASES[normalized] || String(service || '').trim();
}

/**
 * Long-tail primary keywords ("bed bug bites vs flea bites", "tiny ants in
 * kitchen identification") occur verbatim almost nowhere in the corpus, so
 * the full-keyword candidate finds nothing and planning silently returns
 * zero tasks. Split the keyword on comparison/connective separators into
 * multi-word segments ("bed bug bites", "flea bites") that DO occur in
 * sibling pages. Single-word and stopword-only segments are dropped — they
 * anchor poorly and match promiscuously. Comma/slash between digits is
 * numeric punctuation ("2,500", "1/2"), not a boundary.
 */
function keywordSegments(keyword) {
  const raw = String(keyword || '').trim();
  if (!raw) return [];
  return raw
    .split(/\s+(?:vs\.?|versus|and|or|in|for|with|without)\s+|\s*[:;()—–?!]\s*|\s*(?<!\d)[,/]\s*|\s*[,/](?!\d)\s*/i)
    .map((segment) => String(segment || '').trim())
    .filter((segment) => segment
      && segment.toLowerCase() !== raw.toLowerCase()
      && segment.split(/\s+/).length >= 2
      && policy._internals.meaningfulTokens(segment).size > 0);
}

/**
 * Same page-type/cluster inference the executor's fact builder uses (it
 * delegates here) — ranking with different facts than the gate re-opens the
 * cap-burn bug where mis-scored matches consume slots.
 */
function inferPageType(file, frontmatter = {}) {
  if (frontmatter.page_type || frontmatter.content_type) return String(frontmatter.page_type || frontmatter.content_type);
  const normalized = String(file || '').replace(/\\/g, '/');
  if (normalized.includes('/blog/')) return 'supporting-blog';
  if (normalized.includes('/services/')) return /-fl\.mdx?$/.test(normalized) ? 'city-service' : 'service';
  if (normalized.includes('/locations/')) return 'location';
  return 'unknown';
}

function inferCluster(file, frontmatter = {}) {
  const text = [
    frontmatter.category,
    frontmatter.service,
    frontmatter.primary_keyword,
    frontmatter.title,
    file,
  ].filter(Boolean).join(' ').toLowerCase();
  for (const cluster of ['termite', 'mosquito', 'rodent', 'lawn', 'tree', 'shrub', 'pest']) {
    if (text.includes(cluster)) return cluster === 'tree' || cluster === 'shrub' ? 'tree-shrub' : cluster;
  }
  return null;
}

/**
 * The topical facts scoreTopicalRelevance consumes, built with the SAME
 * field precedence as the executor's pageFromAstroFile/pageFacts — when the
 * target page exists in the corpus the plan-time score equals the gate's
 * score exactly.
 */
function topicalFacts(file, frontmatter = {}, { bodyExcerpt = null } = {}) {
  return {
    page_type: inferPageType(file, frontmatter),
    topic: frontmatter.primary_keyword || frontmatter.target_keyword || frontmatter.title || null,
    topic_cluster: frontmatter.category || frontmatter.service || frontmatter.target_service || inferCluster(file, frontmatter),
    title: frontmatter.title || null,
    keyword: frontmatter.primary_keyword || frontmatter.target_keyword || null,
    body_excerpt: bodyExcerpt,
  };
}

// ── corpus scanner ──────────────────────────────────────────────────

/**
 * Strip regions that must NOT be searched for matches:
 *   - YAML frontmatter at top of file (--- … ---)
 *   - fenced code blocks (``` … ```)
 *   - HTML comments (<!-- … -->)
 *   - HTML anchor regions (<a …>…</a>)
 *   - existing markdown links/reference definitions
 *   - MDX/HTML tags and attributes
 *
 * Returns the body with those regions replaced by spaces of the same
 * length, so character offsets in the result line up 1:1 with the
 * source — important for application of edits later.
 */
function maskExcludedRegions(text) {
  let s = maskNonContentRegions(text);
  // HTML anchor regions.
  s = s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, blankRegion);
  // Markdown links and reference definitions. This masks both labels
  // and destinations; otherwise short anchors can match inside hrefs
  // like [details](/termite-control-sarasota/) and corrupt the URL.
  s = s.replace(INLINE_MARKDOWN_LINK_RE, blankRegion);
  s = s.replace(/\[[^\]\n]+\]\[[^\]\n]*\]/g, blankRegion);
  s = s.replace(/^\s{0,3}\[[^\]\n]+\]:\s*(?:<[^>\n]+>|[^\s]+)(?:\s+.*)?$/gm, blankRegion);
  // Remaining MDX/HTML tags. Leave children visible, but prevent matches
  // inside component props or tag attributes.
  s = s.replace(/<\/?[A-Za-z][A-Za-z0-9:._-]*(?:\s+[^<>]*?)?\/?>/g, blankRegion);
  return s;
}

function maskNonContentRegions(text) {
  let s = String(text || '');
  // Frontmatter at the very top.
  s = s.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/, blankRegion);
  // CommonMark fenced code blocks: backtick or tilde fences.
  s = s.replace(/(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\r?\n[\s\S]*?\r?\n[ \t]{0,3}\2[ \t]*(?=\r?\n|$))/g, blankRegion);
  // HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, blankRegion);
  return s;
}

function blankRegion(region) {
  return String(region || '').replace(/[^\r\n]/g, ' ');
}

/**
 * Find the FIRST occurrence of `phrase` in `text` that is NOT already
 * inside a markdown or HTML link. Returns { index, length, snippet }
 * or null.
 */
function findFirstUnlinkedOccurrence(text, phrase, { fromIndex = 0 } = {}) {
  if (!text || !phrase) return null;
  const masked = maskExcludedRegions(text);
  // Require word-like phrase boundaries — raw indexOf matched short keywords like
  // "ant" inside "plant" or "pest" inside "pesticide" and corrupted
  // the rendered markdown when applyTaskToBody wrapped the partial.
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');
  re.lastIndex = Math.max(0, fromIndex);
  let m;
  while ((m = re.exec(masked)) !== null) {
    const idx = m.index;
    const length = m[0].length;
    if (!hasPhraseBoundary(masked, idx, length, phrase)) continue;
    if (isInsideLink(masked, idx, idx + length)) continue;
    if (isInsideMarkdownHeading(masked, idx)) continue;
    return {
      index: idx,
      length,
      snippet: snippetAround(text, idx, length),
    };
  }
  return null;
}

function isInsideMarkdownHeading(text, index) {
  const lineStart = String(text || '').lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  return /^[ \t]{0,3}#{1,6}\s/.test(String(text || '').slice(lineStart, index + 1));
}

function hasPhraseBoundary(text, start, length, phrase) {
  if (startsWithWordChar(phrase) && isWordChar(text[start - 1])) return false;
  if (endsWithWordChar(phrase) && isWordChar(text[start + length])) return false;
  return true;
}

function startsWithWordChar(value) {
  return isWordChar(String(value || '')[0]);
}

function endsWithWordChar(value) {
  const s = String(value || '');
  return isWordChar(s[s.length - 1]);
}

function isWordChar(ch) {
  return /[A-Za-z0-9_]/.test(ch || '');
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

/**
 * The blank-line-delimited paragraph containing `index`. This is the SAME
 * context the executor's relevance gate scores (it delegates here) — the
 * plan-time ranking must see identical text or weak matches can outrank a
 * viable page whose supporting tokens sit outside a short snippet.
 */
function paragraphAround(body, index) {
  const text = String(body || '');
  let start = text.lastIndexOf('\n\n', Math.max(0, index - 1));
  start = start === -1 ? 0 : start + 2;
  let end = text.indexOf('\n\n', index);
  end = end === -1 ? text.length : end;
  return text.slice(start, end).trim();
}

/**
 * Same check the executor's gate applies before patching (it delegates
 * here): a paragraph that already carries a link is not a valid placement.
 * The planner must apply it BEFORE the site-wide cap or such matches burn
 * cap slots and then all skip as paragraph_already_has_link.
 */
function paragraphHasLink(paragraph) {
  return /\[[^\]\n]+\]\(\s*[^)]+\)/.test(paragraph) || /<a\b[^>]*\bhref\s*=/i.test(paragraph);
}

// Bound on how many occurrences of one phrase to examine per page — a
// runaway phrase ("pest control" on an index page) shouldn't scan forever.
const MAX_PLACEMENT_SCAN = 20;

/**
 * The FIRST occurrence of `phrase` that is a placement the executor would
 * accept: not inside a link/heading (findFirstUnlinkedOccurrence), in a
 * paragraph with no existing link, and passing the contextual anchor
 * policy there. Planner, executor dry-run, and applyTaskToBody all use
 * THIS scan, so they always select the same occurrence — an early
 * ineligible mention no longer hides a later clean one.
 */
function findEligiblePlacement(body, phrase) {
  let fromIndex = 0;
  for (let i = 0; i < MAX_PLACEMENT_SCAN; i++) {
    const occ = findFirstUnlinkedOccurrence(body, phrase, { fromIndex });
    if (!occ) return null;
    const paragraph = paragraphAround(body, occ.index);
    const anchor = String(body).slice(occ.index, occ.index + occ.length);
    if (!paragraphHasLink(paragraph)
      && policy.validateAnchorPolicy(anchor, { surroundingText: paragraph }).ok) {
      return { ...occ, paragraph, anchor };
    }
    fromIndex = occ.index + occ.length;
  }
  return null;
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
  const target = canonicalInternalPath(targetUrl);
  if (!target) return false;
  const searchable = maskNonContentRegions(text);
  const mdLink = /\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  let m;
  while ((m = mdLink.exec(searchable)) !== null) {
    if (canonicalInternalPath(unwrapAngleHref(m[1])) === target) return true;
  }
  const refDef = /^\s{0,3}\[[^\]\n]+\]:\s*(<[^>]+>|[^\s]+)(?:\s+.*)?$/gm;
  while ((m = refDef.exec(searchable)) !== null) {
    if (canonicalInternalPath(unwrapAngleHref(m[1])) === target) return true;
  }
  const href = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = href.exec(searchable)) !== null) {
    if (canonicalInternalPath(m[1]) === target) return true;
  }
  return false;
}

/**
 * Source pages are only safe to patch when they render exclusively on the
 * hub. The Astro build's multi-domain filter renders an entry on a spoke
 * domain when its frontmatter `domains` array names that spoke key; absent
 * or hub-only `domains` means hub-only. A hub-relative link injected into a
 * spoke-rendered page would ship on the spoke build too, pointing at a URL
 * that 404s there (hub-only pages are excluded from spoke builds).
 */
function sourceRendersOffHub(frontmatterData = {}) {
  const domains = Array.isArray(frontmatterData.domains) ? frontmatterData.domains : [];
  return domains.some((entry) => {
    const host = String(entry || '').trim().toLowerCase().replace(/^www\./, '');
    return Boolean(host) && !ALLOWED_SITE_HOSTS.has(host);
  });
}

/**
 * Spoke-canonical pages (hub-rendered duplicates whose canonical points at
 * a spoke domain) are not link sources either — a link there passes no
 * equity to the target and the page is slated for dedup, not enrichment.
 */
function canonicalPointsOffHub(frontmatterData = {}) {
  for (const value of [frontmatterData.canonical, frontmatterData.canonical_url]) {
    const raw = String(value || '').trim();
    if (!/^https?:\/\//i.test(raw)) continue;
    try {
      if (!ALLOWED_SITE_HOSTS.has(new URL(raw).hostname.toLowerCase())) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Same noindex detection the executor's gate applies (it delegates here) —
 * a noindex source fails source_not_indexable at execution, so planning it
 * would burn a cap slot.
 */
function robotsNoindex(frontmatter = {}) {
  return String(frontmatter.robots || frontmatter.indexing || '').toLowerCase().includes('noindex')
    || frontmatter.noindex === true;
}

function eligibleLinkSource(page) {
  const data = fm.parse(String(page?.body || '')).data || {};
  return !sourceRendersOffHub(data) && !canonicalPointsOffHub(data) && !robotsNoindex(data);
}

/**
 * A frontmatter canonical that names a DIFFERENT hub path than the page's
 * own URL fails source_canonical_mismatch at execution — planning such a
 * source burns a cap slot. Off-hub canonicals are handled separately by
 * canonicalPointsOffHub; run this only after that check has passed.
 */
function sourceCanonicalMismatch(frontmatterData = {}, pageUrl) {
  if (!pageUrl) return false;
  for (const value of [frontmatterData.canonical, frontmatterData.canonical_url]) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    if (!policy.urlsEquivalent(raw, pageUrl)) return true;
  }
  return false;
}

/**
 * Same internal-link count the executor's density gate uses (it delegates
 * here): internal markdown links plus internal <a> hrefs, images excluded.
 */
function countInternalLinks(body) {
  const text = String(body || '');
  let count = 0;
  // (?<!!) excludes markdown image embeds — ![alt](/x.webp) is not a link.
  const mdLink = /(?<!!)\[[^\]\n]+\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  let match;
  while ((match = mdLink.exec(text)) !== null) {
    if (policy.normalizeInternalUrl(String(match[1] || '').replace(/^<|>$/g, ''))) count++;
  }
  const href = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((match = href.exec(text)) !== null) {
    if (policy.normalizeInternalUrl(match[1])) count++;
  }
  return count;
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
  planForTarget(target, {
    corpus = [],
    opportunityId = null,
    cap = DEFAULT_LINK_CAP,
    perPageCap = DEFAULT_PER_PAGE_CAP,
    maxSourceContextualLinks = DEFAULT_MAX_SOURCE_CONTEXTUAL_LINKS,
    minTopicalRelevance = Number(process.env.AUTONOMOUS_INTERNAL_LINK_MIN_TOPICAL_RELEVANCE ?? 0.75),
  } = {}) {
    if (!target?.url) return [];
    const candidates = anchorCandidates(target);
    if (!candidates.length) return [];

    const targetPath = canonicalInternalPath(target.url);
    if (!targetPath) return [];
    // Resolve the target's content file from the corpus while we have it —
    // the executor can't reliably re-derive it from the URL alone (a
    // root-slug blog post and a location page have identical URL shapes).
    const targetPage = corpus.find(
      (page) => sameUrl(page.url || deriveUrlFromSourceFile(page.file, page.body), targetPath)
    ) || null;
    const targetFile = targetPage?.file || null;
    const targetFront = targetPage ? (fm.parse(String(targetPage.body || '')).data || {}) : {};
    // When the target page is in the corpus these facts equal the executor's
    // exactly. A not-yet-merged target gets a synthetic frontmatter from the
    // brief (the executor would skip everything as target_body_missing in
    // that state anyway, so the approximation cannot cause divergence).
    // The brief's keyword also backfills a corpus target whose (legacy)
    // frontmatter carries no keyword — without it the descriptive title
    // floods the core denominator, recreating the blackout this change
    // removes. The executor mirrors the merge via task.target_keyword.
    const targetFrontForFacts = targetPage
      ? {
        ...targetFront,
        primary_keyword: targetFront.primary_keyword || targetFront.target_keyword || target.keyword || undefined,
      }
      : {
        primary_keyword: target.keyword || undefined,
        title: target.title || undefined,
        service: target.service || undefined,
      };
    const targetFacts = topicalFacts(targetPage ? targetFile : targetPath, targetFrontForFacts);
    const matches = [];

    // Scan the WHOLE corpus before applying the site-wide cap. Taking the
    // first N matches in corpus order let a common-but-weak segment fill
    // every slot with sources the executor's relevance gate then skips,
    // while a genuinely relevant later page was never planned.
    for (const page of corpus) {
      const pageUrl = page.url || deriveUrlFromSourceFile(page.file, page.body);
      if (sameUrl(pageUrl, targetPath)) continue; // never link page to itself
      const front = fm.parse(String(page.body || '')).data || {};
      // Every executor precondition knowable from the corpus runs HERE,
      // before the cap — a source the gate would reject must never occupy
      // a slot (spoke-rendered, spoke-canonical, noindex, canonical
      // mismatch, link-saturated).
      if (sourceRendersOffHub(front) || canonicalPointsOffHub(front) || robotsNoindex(front)) continue;
      if (sourceCanonicalMismatch(front, pageUrl)) continue;
      if (pageAlreadyLinksTo(page.body, targetPath)) continue;
      if (countInternalLinks(page.body) > maxSourceContextualLinks) continue;

      // Evaluate EVERY candidate phrase for this page and keep the best
      // per-page match(es) by relevance — committing to the first matching
      // phrase let a low-relevance early candidate (e.g. a bare "roof rat")
      // shadow a later fully-relevant segment on the same page, queueing a
      // task the executor's relevance gate then rejects.
      const pageMatches = [];
      for (const { phrase, priority } of candidates) {
        // findEligiblePlacement scans past occurrences the executor would
        // reject (linked paragraph, contextual anchor-policy failure) and
        // returns the first placement that survives — the executor dry-run
        // and applyTaskToBody run the SAME scan, so the occurrence chosen
        // here is the one that gets evaluated and patched. occ.anchor
        // preserves the original casing from the matched text.
        const occ = findEligiblePlacement(page.body, phrase);
        if (!occ) continue;
        const relevance = policy.scoreTopicalRelevance(
          // Mask non-rendered regions (MDX props, HTML comments, code)
          // before scoring — hidden tokens must not lift topical overlap
          // for text the reader never sees; the occurrence finder already
          // excludes those regions from matching.
          topicalFacts(page.file, front, { bodyExcerpt: maskExcludedRegions(occ.paragraph) }),
          targetFacts
        );
        // Below the gate's floor the executor is certain to reject — with
        // identical facts on both sides the scores match, so skip here.
        if (relevance < minTopicalRelevance) continue;
        pageMatches.push({
          priority,
          relevance,
          task: {
            source_file: page.file,
            target_url: targetPath,
            target_file: targetFile,
            target_keyword: target.keyword || null,
            anchor_text: occ.anchor,
            context_snippet: occ.snippet,
            source_offset: occ.index,
            opportunity_id: opportunityId,
          },
        });
      }
      pageMatches.sort((a, b) => (b.relevance - a.relevance) || (b.priority - a.priority));
      matches.push(...pageMatches.slice(0, perPageCap));
    }
    // Fill the cap best-first: plan-time relevance (the executor gates on
    // it), then anchor priority; ties keep corpus order (sort is stable).
    matches.sort((a, b) => (b.relevance - a.relevance) || (b.priority - a.priority));
    return matches.slice(0, cap).map((m) => m.task);
  }

  /**
   * Apply a planned task to a body string and return the patched body.
   * Re-locates the phrase before replacing (in case the file changed
   * since planning) so offsets aren't load-bearing.
   */
  applyTaskToBody(body, task) {
    if (!body || !task) return body;
    const targetUrl = canonicalInternalPath(task.target_url);
    if (!targetUrl || pageAlreadyLinksTo(body, targetUrl)) return body;
    // Same eligible-placement scan the planner and executor dry-run use, so
    // the occurrence that was validated is the occurrence that gets linked.
    const occ = findEligiblePlacement(body, task.anchor_text);
    if (!occ) return body;
    const replacement = `[${occ.anchor}](${targetUrl})`;
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
      for (const full of walkMarkdownFiles(dir)) {
        const file = path.relative(dir, full).split(path.sep).join('/');
        const body = fs.readFileSync(full, 'utf8');
        out.push({
          file: path.relative(astroRoot, full).split(path.sep).join('/'),
          body,
          url: deriveUrlFromFile(c, file, body),
        });
      }
    }
    return out;
  }

  /**
   * Load Astro pages from the configured GitHub Astro repo. This is the
   * production fallback for Railway, where the portal container does not
   * have a local sibling checkout available at ASTRO_REPO_DIR.
   */
  async loadAstroCorpusFromGitHub({ collections = ['blog', 'services', 'locations'], ref = null } = {}) {
    const out = [];
    for (const collection of collections) {
      const root = `src/content/${collection}`;
      const files = await listMarkdownFilesFromGitHub(root, ref);
      for (const file of files) {
        const loaded = await GitHubClient.getFile(file.path, ref);
        if (!loaded?.content) continue;
        out.push({
          file: loaded.path || file.path,
          body: loaded.content,
          url: deriveUrlFromSourceFile(loaded.path || file.path, loaded.content),
        });
      }
    }
    return out;
  }
}

async function listMarkdownFilesFromGitHub(root, ref = null) {
  const out = [];
  const entries = await GitHubClient.listDir(root, ref);
  for (const entry of entries || []) {
    if (entry.type === 'dir') {
      out.push(...await listMarkdownFilesFromGitHub(entry.path, ref));
    } else if (entry.type === 'file' && /\.mdx?$/.test(entry.name || entry.path || '')) {
      out.push({ path: entry.path });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
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
  const raw = String(url || '').trim();
  if (!raw || /[\u0000-\u001F\\]/.test(raw)) return '';

  let pathname;
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return '';
    }
    if (!ALLOWED_SITE_HOSTS.has(parsed.hostname.toLowerCase())) return '';
    pathname = parsed.pathname;
  } else if (raw.startsWith('/') && !raw.startsWith('//')) {
    pathname = raw.replace(/[?#].*$/, '');
  } else {
    return '';
  }

  const p = pathname.replace(/\/+$/, '').toLowerCase();
  if (!p || !p.startsWith('/') || p.startsWith('//')) return '';
  if (!/^\/[a-z0-9/_~.%+-]+$/.test(p)) return '';
  return `${p}/`;
}

function deriveUrlFromFile(collection, file, body = '') {
  const slug = extractFrontmatterSlug(body);
  if (slug) return slug;
  const base = file.replace(/\.mdx?$/, '');
  if (collection === 'blog') return `/blog/${base}/`;
  return `/${base}/`;
}

function deriveUrlFromSourceFile(file, body = '') {
  const normalized = String(file || '').split(path.sep).join('/');
  const m = normalized.match(/(?:^|\/)src\/content\/(blog|services|locations)\/(.+\.mdx?)$/);
  if (!m) return '';
  return deriveUrlFromFile(m[1], m[2], body);
}

function walkMarkdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdownFiles(full));
    } else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
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
  ALLOWED_SITE_HOSTS,
  SERVICE_ANCHOR_ALIASES,
  INLINE_MARKDOWN_LINK_RE,
  anchorCandidates,
  serviceAnchorPhrase,
  keywordSegments,
  inferPageType,
  inferCluster,
  topicalFacts,
  maskExcludedRegions,
  maskNonContentRegions,
  blankRegion,
  findFirstUnlinkedOccurrence,
  findEligiblePlacement,
  isInsideMarkdownHeading,
  hasPhraseBoundary,
  isWordChar,
  isInsideLink,
  snippetAround,
  paragraphAround,
  paragraphHasLink,
  pageAlreadyLinksTo,
  sourceRendersOffHub,
  canonicalPointsOffHub,
  robotsNoindex,
  eligibleLinkSource,
  sourceCanonicalMismatch,
  countInternalLinks,
  DEFAULT_MAX_SOURCE_CONTEXTUAL_LINKS,
  unwrapAngleHref,
  normalizePath,
  canonicalInternalPath,
  stripHost,
  sameUrl,
  deriveUrlFromFile,
  deriveUrlFromSourceFile,
  walkMarkdownFiles,
  listMarkdownFilesFromGitHub,
  extractFrontmatterSlug,
};

/**
 * related-posts.js — computes RELATED existing blog posts for a
 * new supporting-blog brief.
 *
 * Background: writer-agent-config.js only ever allowed linking to a
 * CLOSED set (internal_links_to_add + the static ALLOWED_INTERNAL_LINKS
 * allowlist + real /{service-slug}-{city}-fl/ pages) and explicitly told
 * the writer "no guessed blog-post slugs" — so a new supporting-blog draft
 * had no way to link ANY other blog post, closed set or not. Result on the
 * live site: 115 of 278 blog posts link to no other post.
 *
 * This module gives each new supporting-blog brief a short, RANKED list of
 * real, live posts it may link — never a guess. The source of truth is the
 * same `blog_posts` table + `content-registry` URL-derivation the rest of
 * the content pipeline already trusts (dbBlogRowToItem: astro_live_url when
 * the astro pipeline has one, a legacy slug-derived GUESS otherwise). Only
 * the astro_live_url case is trusted as a link target here — a bare-slug
 * guess is exactly the failure a real incident hit (migration
 * 20260830000030: a pre-publish slug shipped as a live link and 404'd,
 * because the real route was category-prefixed, not the bare slug), and a
 * related-post link is a NEW allowance the UNKNOWN_INTERNAL_ROUTE gate
 * accepts unchecked, so it may only ever point at a pipeline-confirmed URL.
 * Domain eligibility mirrors
 * the spoke-fleet per-post targeting rule (server/services/content-astro/
 * spoke-sites.js): a candidate with no domains (or an empty list) is hub-only;
 * otherwise it must render on every domain the NEW post targets. Autonomous
 * supporting-blog briefs are hub-only by default.
 *
 * Pure ranking (rankRelatedPosts) is dependency-free and unit-tested
 * directly with fixture candidates; getRelatedPostsForBrief is the thin DB
 * wrapper content-brief-builder calls when composing a brief.
 */

const db = require('../../models/db');
const { dbBlogRowToItem } = require('./content-registry');
const { normalizeService } = require('./blog-seo-contract');
const { HUB_SITE_KEYS, normalizeSpokeSites } = require('../content-astro/spoke-sites');

// "8-12 related posts" per the brief — never pad below what genuinely
// relates (a low-relevance filler link is worse than a short list), never
// exceed this cap.
const RELATED_POSTS_DEFAULT_LIMIT = 12;
const RELATED_POSTS_TARGET_MIN = 8;
const MIN_SUBSTANTIVE_TOKEN_OVERLAP = 2;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with',
  'of', 'is', 'are', 'do', 'does', 'how', 'what', 'why', 'when', 'where',
  'my', 'your', 'our', 'this', 'that', 'near', 'me', 'us',
]);

// Words nearly every service post shares ("termite treatment in Florida"
// vs "fire ant control guide"). They still describe a post, but sharing
// one never makes two posts related, so they never count as overlap.
const GENERIC_TOPIC_TOKENS = new Set([
  'pest', 'pests', 'control', 'treatment', 'treatments', 'service', 'services',
  'company', 'companies', 'guide', 'tips', 'best', 'cost', 'costs', 'price',
  'florida', 'swfl', 'southwest', 'get', 'rid', 'remove', 'removal',
  'prevent', 'prevention', 'signs', 'identification', 'identify', 'home',
  'homes', 'house', 'homeowner', 'homeowners', 'yard', 'professional',
  'expert', 'local', 'year', 'season', 'seasonal',
]);

function extractTokens(text) {
  const out = new Set();
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/);
  for (const w of words) {
    if (w.length > 2 && !STOP_WORDS.has(w)) out.add(w);
  }
  return out;
}

// Pest/service entity normalization for RANKING only (never a gate
// decision). Reuse the blog SEO contract's aliases so "pest", "Pest
// Control", and "pest-control" share one identity. Do not pass a blank
// value to normalizeService: its intentional brief-level default is `pest`,
// while a missing candidate entity must remain missing here.
function entityCandidates(values) {
  const out = new Set();
  const raw = Array.isArray(values) ? values : [values];
  for (const value of raw) {
    const base = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (!base) continue;
    const canonical = String(normalizeService(value) || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    for (const entity of new Set([base, canonical].filter(Boolean))) {
      out.add(entity);
      if (entity.endsWith('es') && entity.length > 4) out.add(entity.slice(0, -2));
      if (entity.endsWith('s') && entity.length > 3) out.add(entity.slice(0, -1));
    }
  }
  return out;
}

function normalizePathForCompare(value) {
  let s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  try {
    if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
  } catch { /* keep raw */ }
  s = s.split(/[?#]/)[0];
  if (!s.startsWith('/')) s = `/${s}`;
  if (!s.endsWith('/')) s += '/';
  return s;
}

// Astro defaults a missing/empty domains list to the hub. Otherwise a
// candidate must render on EVERY domain the new post targets, mirroring the
// Astro collection filter.
function candidateRendersOnDomains(targetSites, domains) {
  let arr = targetSites;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { arr = null; }
  }
  const publishedSites = Array.isArray(arr) && arr.length ? arr : HUB_SITE_KEYS;
  return domains.every((d) => publishedSites.includes(d));
}

// True when `c` is even eligible to be scored: it has a path, is not the
// post being excluded (by id or path), and renders on every domain the new
// post targets. Split out of rankRelatedPosts to keep that function's
// cyclomatic complexity readable.
function isEligibleCandidate(c, { excludeId, excludePath, domains }) {
  if (!c || !c.path) return false;
  if (excludeId != null && c.id === excludeId) return false;
  if (excludePath && normalizePathForCompare(c.path) === excludePath) return false;
  return candidateRendersOnDomains(c.targetSites, domains);
}

// Ranking score for one eligible candidate: pest/service entity match first
// (binary, outranks everything), then keyword-token overlap (capped), then
// a small same-city nudge — but ONLY as a tie-breaker between candidates
// that are already topically related. City alone must never admit a
// candidate: a same-city post sharing neither entity nor keyword overlap
// with the target is not "related" just because it's local (Codex #4984
// r2 P1 — this list is now enforced by a hard link-count gate, so a
// city-only false positive could force an unrelated link into the draft).
function scoreCandidate(c, { targetEntities, targetTokens, targetCity }) {
  const candidateEntities = entityCandidates([c.service, c.category]);
  let entityScore = 0;
  for (const e of targetEntities) {
    if (e && candidateEntities.has(e)) { entityScore = 100; break; }
  }

  // City words are the same-city nudge's job below, and generic service
  // words relate nothing, so neither counts as keyword overlap: a same-city
  // or "…treatment in Florida" title must not admit an unrelated post
  // (Codex #4984 r4 P2 — this list feeds a hard link-count gate).
  const cityTokens = extractTokens(`${targetCity || ''} ${c.city || ''}`);
  const candidateTokens = extractTokens(`${c.keyword || ''} ${c.title || ''}`);
  let overlap = 0;
  for (const t of targetTokens) {
    if (GENERIC_TOPIC_TOKENS.has(t) || cityTokens.has(t)) continue;
    if (candidateTokens.has(t)) overlap += 1;
  }
  // One shared word is too weak to make a candidate mandatory downstream:
  // even a non-generic word such as "damage" can occur across unrelated
  // services. Require two substantive shared tokens unless the structured
  // service/category entity already establishes the relationship.
  const keywordScore = overlap >= MIN_SUBSTANTIVE_TOKEN_OVERLAP
    ? Math.min(overlap * 10, 60)
    : 0;

  const topicallyRelated = entityScore > 0 || keywordScore > 0;
  const sameCity = targetCity && c.city && String(c.city).trim().toLowerCase() === targetCity;
  const cityScore = (topicallyRelated && sameCity) ? 5 : 0;

  return entityScore + keywordScore + cityScore;
}

/**
 * rankRelatedPosts(target, candidates, opts) → [{ title, path, keyword }]
 *
 * target: { keyword, service, pestEntity, city, domains, excludePath, excludeId }
 * candidates: [{ id, title, path, keyword, city, service, category, targetSites, workflowStatus }]
 *
 * Ranking: pest/service entity match first (binary, outranks everything),
 * then keyword-token overlap (capped), then a small same-city nudge as a
 * tie-breaker (see scoreCandidate). A candidate that shares neither entity
 * nor keyword is dropped rather than force-filled — an unrelated link is
 * worse than a short list. Deterministic: ties break on title so the same
 * brief always proposes the same list.
 */
function rankRelatedPosts(target = {}, candidates = [], { limit = RELATED_POSTS_DEFAULT_LIMIT } = {}) {
  const scoringContext = {
    targetTokens: extractTokens(target.keyword),
    targetEntities: entityCandidates([target.service, target.pestEntity]),
    targetCity: target.city ? String(target.city).trim().toLowerCase() : null,
  };
  const eligibility = {
    domains: Array.isArray(target.domains) && target.domains.length ? target.domains : [...HUB_SITE_KEYS],
    excludePath: target.excludePath ? normalizePathForCompare(target.excludePath) : null,
    excludeId: target.excludeId != null ? target.excludeId : null,
  };

  const scored = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!isEligibleCandidate(c, eligibility)) continue;
    const score = scoreCandidate(c, scoringContext);
    if (score <= 0) continue; // no plausible topical relation — never force-fill
    scored.push({ title: c.title || null, path: normalizePathForCompare(c.path), keyword: c.keyword || null, _score: score });
  }
  scored.sort((a, b) => b._score - a._score || String(a.title || '').localeCompare(String(b.title || '')));
  // Two rows can resolve to one live URL; the brief lists each page once
  // (its best-scored row), so one anchor can't stand in for several posts.
  const seenPaths = new Set();
  const unique = scored.filter((r) => (seenPaths.has(r.path) ? false : seenPaths.add(r.path)));
  return unique.slice(0, limit).map(({ _score, ...rest }) => rest);
}

function candidateFromRow(row) {
  const item = dbBlogRowToItem(row);
  const publishedSites = normalizeSpokeSites([row.astro_live_url]);
  const liveUrlIsAbsolute = /^https?:\/\//i.test(String(row.astro_live_url || ''));
  return {
    id: row.id,
    title: item.title,
    path: item.canonical_url_normalized || item.canonical_url || null,
    keyword: item.target_keyword,
    city: item.target_city,
    service: item.target_service,
    category: item.category,
    // Blog publication pins domains independently of the historical
    // blog_posts.target_sites value. Use the verified live URL's host; a
    // relative Astro URL is a hub route. This prevents a stale/null DB field
    // from advertising a hub-only post as available on every spoke.
    targetSites: publishedSites.length ? publishedSites : [...HUB_SITE_KEYS],
    workflowStatus: item.workflow_status,
    astroStatus: row.astro_status || null,
    // dbBlogRowToItem's canonical_url falls back to a bare /{slug}/ guess
    // (content-registry.slugToPath) when astro_live_url is absent. That
    // guess is exactly the failure a real incident hit (migration
    // 20260830000030: a pre-publish slug shipped as a live link and 404'd —
    // the actual route was category-prefixed, not the bare slug). A
    // related-post link is a NEW allowance the gate will accept unchecked,
    // so it may only ever point at the pipeline-CONFIRMED URL, never a
    // guess — pathVerified gates that at the call site below.
    pathVerified: Boolean(row.astro_live_url) && (!liveUrlIsAbsolute || publishedSites.length > 0),
  };
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function registryRowLivePath(row) {
  const safeRow = row || {};
  const rawPath = [safeRow.canonical_url_normalized, safeRow.live_url, safeRow.canonical_url].find(Boolean) || null;
  const requiredStates = [
    [safeRow.content_type, 'blog'],
    [safeRow.workflow_status, 'published'],
    [safeRow.astro_status, 'present'],
    [safeRow.live_status, 'live'],
  ];
  if (!rawPath || !requiredStates.every(([actual, expected]) => actual === expected) || safeRow.noindex_detected === true) return null;
  const pathSites = normalizeSpokeSites([rawPath]);
  if (/^https?:\/\//i.test(rawPath) && pathSites.length === 0) return null;
  return normalizePathForCompare(rawPath);
}

function registryRowLiveKeys(row) {
  const path = registryRowLivePath(row);
  if (!path) return [];
  const safeRow = row || {};
  const metadata = parseJsonObject(safeRow.metadata);
  const frontmatter = parseJsonObject(metadata.frontmatter);
  const rawPath = [safeRow.canonical_url_normalized, safeRow.live_url, safeRow.canonical_url].find(Boolean);
  const configuredSites = normalizeSpokeSites(frontmatter.domains);
  const pathSites = normalizeSpokeSites([rawPath]);
  const sites = configuredSites.length ? configuredSites : (pathSites.length ? pathSites : HUB_SITE_KEYS);
  return sites.map((site) => `${site}|${path}`);
}

function candidateLiveKeys(candidate) {
  const path = normalizePathForCompare(candidate?.path);
  const sites = Array.isArray(candidate?.targetSites) && candidate.targetSites.length
    ? candidate.targetSites
    : HUB_SITE_KEYS;
  return sites.map((site) => `${site}|${path}`);
}

// The registry is the only durable inventory for Astro-authored posts that
// have neither a blog_posts row nor an autonomous run. Accept only its
// strongest state: an Astro source is present, the workflow is published,
// and the live-status sweep verified the canonical route.
function candidateFromRegistryRow(row) {
  const safeRow = row || {};
  const metadata = parseJsonObject(safeRow.metadata);
  const frontmatter = parseJsonObject(metadata.frontmatter);
  const path = registryRowLivePath(safeRow);
  if (!path || safeRow.reconciliation_status !== 'astro_only') return null;
  const rawPath = [safeRow.canonical_url_normalized, safeRow.live_url, safeRow.canonical_url].find(Boolean);
  const pathSites = normalizeSpokeSites([rawPath]);
  const configuredSites = normalizeSpokeSites(frontmatter.domains);
  return {
    id: safeRow.id,
    title: safeRow.title || frontmatter.title || null,
    path,
    keyword: safeRow.target_keyword || frontmatter.primary_keyword || null,
    city: safeRow.target_city || null,
    service: safeRow.target_service || null,
    category: safeRow.category || frontmatter.category || null,
    targetSites: configuredSites.length ? configuredSites : (pathSites.length ? pathSites : [...HUB_SITE_KEYS]),
    workflowStatus: 'published',
    astroStatus: 'live',
    pathVerified: true,
  };
}

/**
 * getRelatedPostsForBrief(target, opts) → Promise<[{ title, path, keyword }]>
 *
 * DB wrapper around rankRelatedPosts. `target` takes the same shape as
 * rankRelatedPosts' first argument. `opts.database` overrides the knex
 * connection (tests inject a mock); `opts.limit` overrides the cap.
 */
async function getRelatedPostsForBrief(target = {}, { database = db, limit = RELATED_POSTS_DEFAULT_LIMIT } = {}) {
  const rows = await database('blog_posts')
    .select('id', 'title', 'keyword', 'tag', 'category', 'slug', 'city', 'target_sites', 'status', 'astro_status', 'astro_live_url');
  const registryRows = await database('content_registry')
    .select(
      'id',
      'canonical_url',
      'canonical_url_normalized',
      'live_url',
      'content_type',
      'workflow_status',
      'astro_status',
      'live_status',
      'reconciliation_status',
      'noindex_detected',
      'title',
      'target_keyword',
      'target_city',
      'target_service',
      'category',
      'metadata'
    );
  const liveRegistryKeys = new Set((registryRows || []).flatMap(registryRowLiveKeys));
  const candidates = (rows || [])
    .map((row) => {
      try { return candidateFromRow(row); }
      catch { return null; }
    })
    // A merge stamps status + astro_live_url before the production build is
    // verified. Only astro_status=live proves the URL is actually deployed;
    // never offer a build_failed or still-pending target to a hard link gate.
    .filter((c) => c && c.path && c.pathVerified && c.astroStatus === 'live'
      && c.workflowStatus === 'published' && candidateLiveKeys(c).some((key) => liveRegistryKeys.has(key)));
  for (const row of registryRows || []) {
    try {
      const candidate = candidateFromRegistryRow(row);
      if (candidate) candidates.push(candidate);
    } catch { /* malformed registry row: exclude it */ }
  }
  return rankRelatedPosts(target, candidates, { limit });
}

module.exports = {
  RELATED_POSTS_DEFAULT_LIMIT,
  RELATED_POSTS_TARGET_MIN,
  rankRelatedPosts,
  candidateFromRow,
  candidateFromRegistryRow,
  registryRowLivePath,
  registryRowLiveKeys,
  getRelatedPostsForBrief,
  _internals: { extractTokens, entityCandidates, candidateRendersOnDomains, normalizePathForCompare, GENERIC_TOPIC_TOKENS },
};

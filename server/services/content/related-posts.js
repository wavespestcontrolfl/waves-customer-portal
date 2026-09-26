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
 * the astro pipeline has one, the legacy slug-derived path otherwise), so an
 * allowed related-post link can never be dead. Domain eligibility mirrors
 * the spoke-fleet per-post targeting rule (server/services/content-astro/
 * spoke-sites.js): a candidate with no target_sites (or an empty one)
 * renders everywhere; otherwise it must render on every domain the NEW post
 * targets. Autonomous supporting-blog briefs are hub-only by default, so
 * with no explicit domains a candidate must be hub-visible.
 *
 * Pure ranking (rankRelatedPosts) is dependency-free and unit-tested
 * directly with fixture candidates; getRelatedPostsForBrief is the thin DB
 * wrapper content-brief-builder calls when composing a brief.
 */

const db = require('../../models/db');
const { dbBlogRowToItem } = require('./content-registry');
const { HUB_SITE_KEYS } = require('../content-astro/spoke-sites');

// "8-12 related posts" per the brief — never pad below what genuinely
// relates (a low-relevance filler link is worse than a short list), never
// exceed this cap.
const RELATED_POSTS_DEFAULT_LIMIT = 12;
const RELATED_POSTS_TARGET_MIN = 8;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with',
  'of', 'is', 'are', 'do', 'does', 'how', 'what', 'why', 'when', 'where',
  'my', 'your', 'our', 'this', 'that', 'near', 'me', 'us',
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

// Light pest/service entity normalization for RANKING only (never a gate
// decision) — lowercase/hyphenate plus a de-pluralized form, so "termite"
// and "Termites" (a legacy blog_posts `tag`) match without needing the
// full FAQ-blocklist alias table.
function entityCandidates(values) {
  const out = new Set();
  const raw = Array.isArray(values) ? values : [values];
  for (const value of raw) {
    const base = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (!base) continue;
    out.add(base);
    if (base.endsWith('es') && base.length > 4) out.add(base.slice(0, -2));
    if (base.endsWith('s') && base.length > 3) out.add(base.slice(0, -1));
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

// A candidate with no target_sites (null/empty — legacy pre-filter rows,
// server/models/migrations/20260424000016) renders on every spoke, so it is
// always domain-eligible. Otherwise it must render on EVERY domain the new
// post targets, mirroring the Astro build's own per-site collection filter.
function candidateRendersOnDomains(targetSites, domains) {
  let arr = targetSites;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { arr = null; }
  }
  if (!Array.isArray(arr) || arr.length === 0) return true;
  return domains.every((d) => arr.includes(d));
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
// a small same-city nudge as a tie-breaker.
function scoreCandidate(c, { targetEntities, targetTokens, targetCity }) {
  const candidateEntities = entityCandidates([c.service, c.category]);
  let entityScore = 0;
  for (const e of targetEntities) {
    if (e && candidateEntities.has(e)) { entityScore = 100; break; }
  }

  const candidateTokens = extractTokens(`${c.keyword || ''} ${c.title || ''}`);
  let overlap = 0;
  for (const t of targetTokens) if (candidateTokens.has(t)) overlap += 1;
  const keywordScore = Math.min(overlap * 10, 60);

  const cityScore = (targetCity && c.city && String(c.city).trim().toLowerCase() === targetCity) ? 5 : 0;

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
  return scored.slice(0, limit).map(({ _score, ...rest }) => rest);
}

function candidateFromRow(row) {
  const item = dbBlogRowToItem(row);
  return {
    id: row.id,
    title: item.title,
    path: item.canonical_url_normalized || item.canonical_url || null,
    keyword: item.target_keyword,
    city: item.target_city,
    service: item.target_service,
    category: item.category,
    targetSites: row.target_sites,
    workflowStatus: item.workflow_status,
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
  const candidates = (rows || [])
    .map((row) => {
      try { return candidateFromRow(row); }
      catch { return null; }
    })
    .filter((c) => c && c.path && c.workflowStatus === 'published');
  return rankRelatedPosts(target, candidates, { limit });
}

module.exports = {
  RELATED_POSTS_DEFAULT_LIMIT,
  RELATED_POSTS_TARGET_MIN,
  rankRelatedPosts,
  candidateFromRow,
  getRelatedPostsForBrief,
  _internals: { extractTokens, entityCandidates, candidateRendersOnDomains, normalizePathForCompare },
};

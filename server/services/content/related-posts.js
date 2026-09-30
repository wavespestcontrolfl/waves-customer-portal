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
const { dbBlogRowToItem, registryLiveTargetUrl } = require('./content-registry');
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
  scored.sort((a, b) => b._score - a._score
    || String(a.title || '').localeCompare(String(b.title || ''))
    || a.path.localeCompare(b.path));
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

function registryCheckedUrl(row) {
  return registryLiveTargetUrl(row) || null;
}

function registryFrontmatter(row) {
  const metadata = parseJsonObject(row?.metadata);
  const direct = parseJsonObject(metadata.frontmatter);
  if (Object.keys(direct).length) return direct;
  const astro = parseJsonObject(metadata.astro);
  return parseJsonObject(astro.frontmatter);
}

function registryFrontmatterSites(frontmatter) {
  const direct = normalizeSpokeSites(frontmatter?.domains);
  return direct.length ? direct : normalizeSpokeSites(frontmatter?.tracking?.domains);
}

function registryRowLivePath(row) {
  const safeRow = row || {};
  const rawPath = registryCheckedUrl(safeRow);
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

function registryRowVerifiedSites(row) {
  const safeRow = row || {};
  const frontmatter = registryFrontmatter(safeRow);
  const rawPath = registryCheckedUrl(safeRow);
  const checkedSites = normalizeSpokeSites([rawPath]);
  const actualSites = checkedSites.length ? checkedSites : HUB_SITE_KEYS;
  const configuredSites = registryFrontmatterSites(frontmatter);
  const renderedSites = configuredSites.length ? configuredSites : HUB_SITE_KEYS;
  return actualSites.filter((site) => renderedSites.includes(site));
}

function registryRowLiveKeys(row) {
  const path = registryRowLivePath(row);
  if (!path) return [];
  return registryRowVerifiedSites(row).map((site) => `${site}|${path}`);
}

function candidateLiveKeys(candidate) {
  const path = normalizePathForCompare(candidate?.path);
  const sites = Array.isArray(candidate?.targetSites) && candidate.targetSites.length
    ? candidate.targetSites
    : HUB_SITE_KEYS;
  return sites.map((site) => `${site}|${path}`);
}

// A completed run proves that publication once succeeded; current registry
// truth decides whether the URL is still live and indexable. The wrapper
// below intersects this richer run metadata with a verified Astro-only row.
// `row` carries pre-projected frontmatter_* / payload_title columns (Codex
// #4984 r6+ P2) rather than the raw `draft_payload` JSONB blob — the query
// projects only these fields in SQL so a brief compose never transfers the
// full historical article body + gate metadata of every completed run.
function candidateFromAutonomousRun(row) {
  const rawUrl = row?.published_url;
  const publishedSites = normalizeSpokeSites([rawUrl]);
  if (!rawUrl || (/^https?:\/\//i.test(rawUrl) && publishedSites.length === 0)) return null;
  return {
    id: row.id,
    title: row.frontmatter_title || row.payload_title || null,
    path: normalizePathForCompare(rawUrl),
    keyword: row.frontmatter_primary_keyword || row.brief_keyword || null,
    city: row.frontmatter_first_area || row.brief_city || null,
    service: row.brief_service || row.frontmatter_service || null,
    category: row.frontmatter_category || null,
    targetSites: publishedSites.length ? publishedSites : [...HUB_SITE_KEYS],
    workflowStatus: 'published',
    astroStatus: 'live',
    pathVerified: true,
  };
}

// Reconciliation statuses that still mean "this IS the Astro-only row for
// this post" — astro_only is the steady state. astro_changed_since_sync is
// assigned to BOTH DB-matched and unmatched rows whose Astro hash drifted
// (content-registry.js changeStatus), so it counts as Astro-only lineage
// only when the row has no db_blog_id; a DB-matched row is covered by the
// blog_posts query instead. Never db_changed_since_sync, conflict, etc.
const REGISTRY_ASTRO_OWNED_STATUSES = new Set(['astro_only', 'astro_changed_since_sync']);

// The registry is the only durable inventory for Astro-authored posts that
// have neither a blog_posts row nor an autonomous run. Accept only its
// strongest state: an Astro source is present, the workflow is published,
// and the live-status sweep verified the canonical route. A transient
// changed-since-sync flag does not itself mean unverified — the live-status
// fields (workflow/astro/live/noindex, checked below via registryRowLivePath)
// are preserved across a resync (Codex #4984 r7 P2: excluding this status
// dropped a republished post from related-post candidates until the NEXT
// unchanged daily sync happened to restore astro_only).
function candidateFromRegistryRow(row) {
  const safeRow = row || {};
  const frontmatter = registryFrontmatter(safeRow);
  const path = registryRowLivePath(safeRow);
  if (!path || !REGISTRY_ASTRO_OWNED_STATUSES.has(safeRow.reconciliation_status)) return null;
  if (safeRow.reconciliation_status === 'astro_changed_since_sync' && safeRow.db_blog_id != null) return null;
  const verifiedSites = registryRowVerifiedSites(safeRow);
  if (!verifiedSites.length) return null;
  return {
    id: safeRow.id,
    title: safeRow.title || frontmatter.title || null,
    path,
    keyword: safeRow.target_keyword || frontmatter.primary_keyword || null,
    city: safeRow.target_city || null,
    service: safeRow.target_service || null,
    category: safeRow.category || frontmatter.category || null,
    targetSites: verifiedSites,
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
// Every related-post candidate that is verified live right now (blog_posts,
// autonomous runs and the content registry, cross-checked). Shared by brief
// composition (ranked) and the publish-time recheck (paths only).
async function loadVerifiedCandidates(database) {
  const rows = await database('blog_posts')
    .select('id', 'title', 'keyword', 'tag', 'category', 'slug', 'city', 'target_sites', 'status', 'astro_status', 'astro_live_url');
  // The audit table is append-only and draft_payload carries the full
  // article body plus gate metadata; a brief compose only ever needs a
  // handful of frontmatter fields (Codex #4984 r6+ P2), so project those
  // in SQL rather than transferring every historical run's complete payload.
  const autonomousRows = await database('autonomous_runs')
    .leftJoin('content_briefs as cb', 'cb.id', 'autonomous_runs.brief_id')
    .where({
      'autonomous_runs.outcome': 'completed_published',
      'autonomous_runs.action_type': 'new_supporting_blog',
    })
    .whereNotNull('autonomous_runs.published_url')
    .select(
      'autonomous_runs.id',
      'autonomous_runs.published_url',
      'autonomous_runs.completed_at',
      database.raw("autonomous_runs.draft_payload->'frontmatter'->>'title' as frontmatter_title"),
      database.raw("autonomous_runs.draft_payload->>'title' as payload_title"),
      database.raw("autonomous_runs.draft_payload->'frontmatter'->>'primary_keyword' as frontmatter_primary_keyword"),
      database.raw("autonomous_runs.draft_payload->'frontmatter'->'service_areas_tag'->>0 as frontmatter_first_area"),
      database.raw("autonomous_runs.draft_payload->'frontmatter'->>'service' as frontmatter_service"),
      database.raw("autonomous_runs.draft_payload->'frontmatter'->>'category' as frontmatter_category"),
      'cb.target_keyword as brief_keyword',
      'cb.city as brief_city',
      'cb.service as brief_service'
    );
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
      'db_blog_id',
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
  // Keyed by the row's own domain+path keys, not pathname alone: two live
  // rows can share a pathname on different fleet hosts, and each must stay
  // a candidate for briefs targeting its host.
  const registryCandidatesByKey = new Map();
  const registryCandidateList = [];
  // Every qualifying registry row's domain+path keys, BEFORE rows that share
  // a pathname on different fleet hosts collapse into one candidate by path
  // (the publish-time recheck must see each host).
  const qualifyingRegistryKeys = [];
  for (const row of registryRows || []) {
    try {
      const candidate = candidateFromRegistryRow(row);
      if (candidate) {
        registryCandidateList.push(candidate);
        for (const key of candidateLiveKeys(candidate)) {
          if (!registryCandidatesByKey.has(key)) registryCandidatesByKey.set(key, candidate);
          qualifyingRegistryKeys.push(key);
        }
      }
    } catch { /* malformed registry row: exclude it */ }
  }
  // A slug can be reused across fleet domains over time, so two different
  // completed runs — or a stale run and an unrelated current registry row —
  // can share a bare pathname while belonging to different sites (Codex
  // #4984 r6+ P2). Group by the run's OWN domain-plus-path live key (not
  // path alone) and keep only the newest `completed_at` per key: a
  // `new_supporting_blog` update on an existing slug can leave multiple
  // completed_published rows for the same URL, and rankRelatedPosts sorts
  // by topical score before deduping paths, so an older run could otherwise
  // donate metadata over the most recently published version.
  const newestAutonomousByKey = new Map();
  for (const row of autonomousRows || []) {
    let candidate;
    try { candidate = candidateFromAutonomousRun(row); }
    catch { continue; }
    if (!candidate) continue;
    const key = candidateLiveKeys(candidate).sort().join(',');
    const completedAt = row.completed_at ? new Date(row.completed_at).getTime() : 0;
    const existing = newestAutonomousByKey.get(key);
    if (!existing || completedAt > existing.completedAt) {
      newestAutonomousByKey.set(key, { candidate, completedAt });
    }
  }
  const consumedRegistry = new Set();
  for (const { candidate } of newestAutonomousByKey.values()) {
    // A path match alone is not enough — the run and the current registry
    // row must share a live domain+path key, or an old hub run can donate
    // its metadata to an unrelated spoke page whose pathname was reused.
    const verified = candidateLiveKeys(candidate)
      .map((key) => registryCandidatesByKey.get(key))
      .find(Boolean) || null;
    if (!verified) continue;
    consumedRegistry.add(verified);
    // Current registry truth controls both rendering and topical identity.
    // Historical run metadata fills only fields the live registry lacks.
    for (const field of ['title', 'keyword', 'city', 'service', 'category']) {
      if (verified[field]) candidate[field] = verified[field];
    }
    candidate.targetSites = verified.targetSites;
    candidates.push(candidate);
  }
  for (const candidate of registryCandidateList) {
    if (!consumedRegistry.has(candidate)) candidates.push(candidate);
  }
  const liveKeys = new Set([...candidates.flatMap(candidateLiveKeys), ...qualifyingRegistryKeys]);
  return { candidates, liveKeys };
}

async function getRelatedPostsForBrief(target = {}, { database = db, limit = RELATED_POSTS_DEFAULT_LIMIT } = {}) {
  const { candidates } = await loadVerifiedCandidates(database);
  return rankRelatedPosts(target, candidates, { limit });
}

// Publish-time recheck: of the frozen related paths, the ones still verified
// live NOW on every frozen publish host (a post can be unpublished,
// noindexed or moved to another fleet domain while a draft that links it
// waits for review). Hosts default to the hub, like candidate targetSites.
async function getLiveRelatedPaths(paths = [], { database = db, hosts = [] } = {}) {
  const wanted = new Set((Array.isArray(paths) ? paths : []).map(normalizePathForCompare).filter(Boolean));
  if (!wanted.size) return new Set();
  const sites = Array.isArray(hosts) && hosts.length ? hosts : HUB_SITE_KEYS;
  const { liveKeys } = await loadVerifiedCandidates(database);
  return new Set([...wanted].filter((p) => sites.every((site) => liveKeys.has(`${site}|${p}`))));
}

module.exports = {
  RELATED_POSTS_DEFAULT_LIMIT,
  RELATED_POSTS_TARGET_MIN,
  rankRelatedPosts,
  candidateFromRow,
  candidateFromAutonomousRun,
  candidateFromRegistryRow,
  registryRowLivePath,
  registryRowLiveKeys,
  getRelatedPostsForBrief,
  getLiveRelatedPaths,
  _internals: { extractTokens, entityCandidates, candidateRendersOnDomains, normalizePathForCompare, GENERIC_TOPIC_TOKENS },
};
